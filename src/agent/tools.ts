import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { ToolSchema } from "../providers/types.js";

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

export function executeTool(name: string, argsJson: string, ctx: ToolContext): ToolOutcome {
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
        const out = execSync(String(args.command), {
          cwd: ctx.cwd,
          encoding: "utf8",
          env: scrubbedEnv(), // never expose API key / service-account JSON to the child
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { result: clip(redactSecrets(out || "(no output)")) };
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
