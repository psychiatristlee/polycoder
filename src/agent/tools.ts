import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ToolSchema, ToolCall } from "../providers/types.js";
import { extractJson } from "../planner/planner.js";

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file relative to the working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path (default '.')" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the working directory and return combined stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Signal that the task is complete with a short summary for the user.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
      },
    },
  },
];

export const KNOWN_TOOLS = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

/** Read-only tool subset for the verify gate (no write_file). */
export const READONLY_TOOL_SCHEMAS: ToolSchema[] = TOOL_SCHEMAS.filter((t) =>
  ["read_file", "list_dir", "run_command"].includes(t.function.name)
);

/**
 * Fallback for models without native tool calling (common with small local LLMs):
 * they often answer with the tool call as plain JSON text, e.g.
 *   {"name": "write_file", "arguments": {"path": "...", "content": "..."}}
 * Parse that into a synthetic ToolCall so the agent still acts on it.
 */
export function parseTextToolCall(content: string): ToolCall | null {
  if (!content) return null;
  const json = extractJson(content);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as any;
    const name = obj?.name ?? obj?.tool ?? obj?.function?.name;
    if (typeof name !== "string" || !KNOWN_TOOLS.has(name)) return null;
    const args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {};
    return {
      id: `textcall_${name}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    };
  } catch {
    return null;
  }
}

export interface ToolContext {
  cwd: string;
  /** Set true to allow run_command + write_file to actually execute. */
  allowWrite: boolean;
  allowCommands: boolean;
}

export interface ToolOutcome {
  result: string;
  /** present when the tool is `finish` */
  finishSummary?: string;
}

const MAX_OUTPUT = 8000;

// run_command guards. The PRIMARY guard is an IDLE timeout: a command is killed only
// if it emits no output for this long. A real build/install that keeps printing
// progress therefore runs as long as it needs (no fixed ceiling), while a command that
// hangs — e.g. waiting on stdin it will never get — is killed promptly. An ABSOLUTE cap
// is an optional backstop for the rare command that streams forever. Both are env-
// overridable; "0"/"off"/"none" disables either one.
function envMs(name: string, dflt: number | undefined): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw == null || raw === "") return dflt;
  if (/^(0|off|none|unlimited)$/i.test(raw)) return undefined; // disabled
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : dflt;
}
const commandIdleMs = () => envMs("POLY_COMMAND_IDLE_MS", 120_000); // kill after 2 min of silence
const commandMaxMs = () => envMs("POLY_COMMAND_TIMEOUT_MS", undefined); // absolute cap, off by default

// Env that discourages interactive prompts so tools fail/skip instead of blocking.
const NONINTERACTIVE_ENV: NodeJS.ProcessEnv = {
  CI: "1",
  npm_config_yes: "true",
  npm_config_fund: "false",
  npm_config_audit: "false",
  GIT_TERMINAL_PROMPT: "0",
  DEBIAN_FRONTEND: "noninteractive",
};

/** Run a shell command, streaming output, with an idle (no-output) timeout. */
function runCommandStreaming(command: string, ctx: ToolContext): Promise<string> {
  const idleMs = commandIdleMs();
  const maxMs = commandMaxMs();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.cwd,
      env: { ...scrubbedEnv(), ...NONINTERACTIVE_ENV },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"], // stdin = EOF, so prompts don't block
      detached: true, // own process group → we can kill the whole tree
    });
    let out = "";
    let truncated = false;
    let killReason = "";
    const CAP = 200_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
    };
    const killTree = (reason: string) => {
      killReason = reason;
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const resetIdle = () => {
      if (idleMs == null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killTree("idle"), idleMs);
    };
    const append = (d: Buffer) => {
      if (out.length < CAP) {
        out += d.toString();
        if (out.length >= CAP) truncated = true;
      } else {
        truncated = true;
      }
      resetIdle(); // any output proves it's still making progress
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    resetIdle();
    if (maxMs != null) maxTimer = setTimeout(() => killTree("timeout"), maxMs);
    child.on("error", (err: any) => {
      clearTimers();
      resolve(clip(redactSecrets(`Error: ${err?.message ?? String(err)}\n${out}`)));
    });
    child.on("close", (code, signal) => {
      clearTimers();
      let prefix = "";
      if (killReason === "idle")
        prefix = `Killed: no output for ${Math.round((idleMs ?? 0) / 1000)}s — likely hung or waiting for input.\n`;
      else if (killReason === "timeout")
        prefix = `Killed: exceeded absolute limit ${Math.round((maxMs ?? 0) / 1000)}s.\n`;
      else if (code !== 0) prefix = `Exit ${code}${signal ? ` (${signal})` : ""}.\n`;
      resolve(clip(redactSecrets(prefix + (out || "(no output)") + (truncated ? "\n…(output truncated)" : ""))));
    });
  });
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…(truncated, ${s.length} chars)` : s;
}

/** Last line of defense: redact obvious secrets from any text fed back into the model context. */
function redactSecrets(s: string): string {
  return s
    .replace(/sk-or-[A-Za-z0-9._-]+/g, "sk-or-***REDACTED***")
    .replace(/"private_key"\s*:\s*"[^"]*"/g, '"private_key":"***REDACTED***"');
}

// Env vars that must never leak into a spawned command's environment.
const SECRET_ENV = ["OPENROUTER_API_KEY", "FIREBASE_SERVICE_ACCOUNT_KEY", "GOOGLE_APPLICATION_CREDENTIALS"];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

/** Resolve a path and CONFINE it to the working directory (no absolute/`..` escapes). */
function resolve(ctx: ToolContext, p: string): string {
  const root = path.resolve(ctx.cwd);
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === "") return abs; // the root itself
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return abs;
}

export async function executeTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolOutcome> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { result: `Error: could not parse arguments: ${argsJson}` };
  }

  try {
    switch (name) {
      case "read_file": {
        const file = resolve(ctx, String(args.path));
        if (!fs.existsSync(file)) return { result: `Error: file not found: ${args.path}` };
        return { result: clip(fs.readFileSync(file, "utf8")) };
      }
      case "list_dir": {
        const dir = resolve(ctx, String(args.path ?? "."));
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        return {
          result: clip(
            entries
              .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
              .sort()
              .join("\n")
          ),
        };
      }
      case "write_file": {
        if (!ctx.allowWrite) return { result: "Denied: write_file is disabled (read-only mode)." };
        const file = resolve(ctx, String(args.path));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(args.content ?? ""), "utf8");
        return { result: `Wrote ${args.path} (${String(args.content ?? "").length} bytes).` };
      }
      case "run_command": {
        if (!ctx.allowCommands) return { result: "Denied: run_command is disabled." };
        return { result: await runCommandStreaming(String(args.command), ctx) };
      }
      case "finish":
        return { result: "ok", finishSummary: String(args.summary ?? "Done.") };
      default:
        return { result: `Error: unknown tool ${name}` };
    }
  } catch (err: any) {
    // execSync throws on non-zero exit; surface its output.
    const stdout = err?.stdout?.toString?.() ?? "";
    const stderr = err?.stderr?.toString?.() ?? "";
    return { result: clip(redactSecrets(`Error: ${err?.message ?? String(err)}\n${stdout}\n${stderr}`)) };
  }
}
