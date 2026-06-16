import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import type { ToolSchema, ToolCall } from "../providers/types.js";
import { extractJson } from "../planner/planner.js";
import { searchWeb } from "../search/providers.js";

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
      description:
        "Run a shell command in the working directory and return combined stdout/stderr. " +
        "Use this for real terminal work: git (status/add/commit/branch/diff/log), package managers " +
        "(npm/pnpm/yarn/pip), build & test (npm run build, pytest, go test), and deploy/cloud CLIs " +
        "(firebase, gh, vercel, supabase, docker). Commands run NON-INTERACTIVELY (no stdin) — always pass " +
        "non-interactive flags (e.g. --yes, -m for git commit, firebase --non-interactive) and never start " +
        "long-running servers (dev servers/watchers) as they will be killed when idle.",
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
      name: "web_search",
      description:
        "Search the web and return the top results (title, URL, snippet). Use to find official documentation and real-world references before designing or implementing. The backend engine is configurable (DuckDuckGo / Brave / the self-hosted polysearch).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          count: { type: "number", description: "Max results (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a web page by URL and return its readable text content (HTML stripped). Use to read docs/references found via web_search.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user to choose when the request is genuinely AMBIGUOUS — present a question plus 2-4 concrete options (like Claude Code). Returns the user's choice. Only use for real forks you cannot resolve from context; otherwise proceed with sensible defaults.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, description: "2-4 concrete choices" },
        },
        required: ["question", "options"],
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
// Local/quantized models frequently emit *almost*-valid JSON when they narrate a tool call
// as text — most commonly literal newlines/tabs inside a string value (e.g. multi-line file
// content for write_file), which JSON forbids. Escape control chars inside string literals and
// drop trailing commas so JSON.parse can recover. String/escape-aware so we don't touch
// structural characters or already-escaped sequences.
export function repairJson(s: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === "\\") { out += ch + (s[i + 1] ?? ""); i++; continue; } // keep escape pairs intact
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1"); // trailing commas before } or ]
}

// Yield every balanced top-level {...} object in `s` (string/escape-aware so braces inside string
// values don't break matching). Small local models often wrap the tool-call JSON in prose, emit a
// ```swift/```bash code block BEFORE the ```json tool call, or stack several objects — so we can't
// just grab the first `{`.
function* allJsonObjects(s: string): Generator<string> {
  for (let start = s.indexOf("{"); start !== -1; start = s.indexOf("{", start + 1)) {
    let depth = 0, inStr = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (ch === "\\") { i++; continue; } if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { yield s.slice(start, i + 1); break; } }
    }
  }
}

const toToolCall = (obj: any): ToolCall | null => {
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name;
  if (typeof name !== "string" || !KNOWN_TOOLS.has(name)) return null;
  const args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? obj.args ?? {};
  return { id: `textcall_${name}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
};

export function parseTextToolCall(content: string): ToolCall | null {
  if (!content) return null;
  // Candidates, most-likely-to-be-the-tool-call first: ```json fences, then any code fence, then
  // the whole text. For each, scan EVERY balanced {…} object (with JSON repair) and return the
  // first that is a known tool call — so a leading ```swift block can't hide the real ```json call.
  const candidates: string[] = [];
  for (const m of content.matchAll(/```json\s*([\s\S]*?)```/gi)) candidates.push(m[1]);
  for (const m of content.matchAll(/```[a-z0-9]*\s*([\s\S]*?)```/gi)) candidates.push(m[1]);
  candidates.push(content);
  for (const cand of candidates) {
    for (const objStr of allJsonObjects(cand)) {
      let obj: any;
      try { obj = JSON.parse(objStr); } catch { try { obj = JSON.parse(repairJson(objStr)); } catch { continue; } }
      const call = toToolCall(obj);
      if (call) return call;
    }
  }
  return null;
}

export interface ToolContext {
  cwd: string;
  /** Set true to allow run_command + write_file to actually execute. */
  allowWrite: boolean;
  allowCommands: boolean;
  /** Set true to allow web_search + web_fetch (network egress). */
  allowWeb: boolean;
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

// Long-running dev servers / watchers never "finish" — running them as a build step just
// hangs until the idle-timeout kills them (a confusing non-zero exit). Detect them and,
// once they report "ready", treat that as success and stop the process.
const SERVER_CMD =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b|\bnext\s+(dev|start)\b|\bvite\b|\bnodemon\b|webpack(-dev-server|\s+serve)|\bng\s+serve\b|\bserve\b|http-server|rails\s+s(erver)?\b|flask\s+run|artisan\s+serve|python\s+-m\s+http\.server|\buvicorn\b|\bgunicorn\b/i;
const SERVER_READY =
  /\b(ready|compiled successfully|compiled|listening|started server|server running|running at|local:\s+https?:\/\/|localhost:\d+|127\.0\.0\.1:\d+|VITE v[\d.]+\s+ready|webpack compiled|watching for file changes|✓ ready)\b/i;

/** Run a shell command, streaming output, with an idle (no-output) timeout. */
function runCommandStreaming(command: string, ctx: ToolContext): Promise<string> {
  const idleMs = commandIdleMs();
  const maxMs = commandMaxMs();
  const isServer = SERVER_CMD.test(command);
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: ctx.cwd,
      env: { ...scrubbedEnv(), ...NONINTERACTIVE_ENV },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"], // stdin = EOF, so prompts don't block
      detached: !isWin, // POSIX: own process group → kill the whole tree. (win: taskkill /T)
      windowsHide: true, // don't pop up a console window for every command
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
      if (isWin) {
        try {
          execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore", windowsHide: true });
        } catch {
          try {
            child.kill();
          } catch {
            /* gone */
          }
        }
        return;
      }
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
    let readyHit = false;
    const append = (d: Buffer) => {
      if (out.length < CAP) {
        out += d.toString();
        if (out.length >= CAP) truncated = true;
      } else {
        truncated = true;
      }
      // A dev server that reports "ready/compiled/listening" succeeded — it won't exit on
      // its own, so capture that as success and stop it instead of hanging until idle-kill.
      if (isServer && !readyHit && SERVER_READY.test(out)) {
        readyHit = true;
        setTimeout(() => killTree("ready"), 800); // let a bit more output flush
        return;
      }
      resetIdle(); // any output proves it's still making progress
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // Dev servers go quiet after "ready"; give them a generous first window to compile.
    if (isServer && idleMs != null) {
      idleTimer = setTimeout(() => killTree("idle"), Math.max(idleMs, 90_000));
    } else {
      resetIdle();
    }
    if (maxMs != null) maxTimer = setTimeout(() => killTree("timeout"), maxMs);
    child.on("error", (err: any) => {
      clearTimers();
      resolve(clip(redactSecrets(`Error: ${err?.message ?? String(err)}\n${out}`)));
    });
    child.on("close", (code, signal) => {
      clearTimers();
      let prefix = "";
      if (killReason === "ready")
        prefix =
          "✓ Dev server started successfully (compiled/ready), then stopped — a server doesn't terminate, so it can't be a build step. To VERIFY the build use `npm run build`; to actually view it, run the server outside the agent.\n";
      else if (killReason === "idle")
        prefix = isServer
          ? `Killed: the server produced no "ready" signal within ${Math.round((idleMs ?? 0) / 1000)}s — check for a startup error above, or verify with \`npm run build\`.\n`
          : `Killed: no output for ${Math.round((idleMs ?? 0) / 1000)}s — likely hung or waiting for input (re-run non-interactively, e.g. add --yes / -y).\n`;
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

// ---- web research -----------------------------------------------------------

const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const WEB_TIMEOUT_MS = 20_000;
const WEB_MAX_CHARS = 6000;

/** Block loopback / link-local / private ranges so the agent can't hit internal services. */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<{ status: number; ctype: string; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": WEB_UA, accept: "text/html,application/xhtml+xml,text/plain,*/*", ...headers },
    });
    const ctype = res.headers.get("content-type") ?? "";
    const body = await res.text();
    return { status: res.status, ctype, body };
  } finally {
    clearTimeout(timer);
  }
}

async function webFetch(rawUrl: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return `Error: invalid URL: ${rawUrl}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Error: only http(s) URLs are allowed.";
  if (isBlockedHost(u.hostname)) return `Error: refusing to fetch a private/loopback host (${u.hostname}).`;
  try {
    const { status, ctype, body } = await fetchText(u.href);
    const text = /html|xml/i.test(ctype) ? htmlToText(body) : body;
    const clipped = text.length > WEB_MAX_CHARS ? text.slice(0, WEB_MAX_CHARS) + `\n…(truncated, ${text.length} chars)` : text;
    return redactSecrets(`# ${u.href}  (HTTP ${status})\n\n${clipped}`);
  } catch (err: any) {
    return `Error fetching ${u.href}: ${err?.name === "AbortError" ? "timed out" : err?.message ?? String(err)}`;
  }
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
      case "web_search": {
        if (!ctx.allowWeb) return { result: "Denied: web access is disabled (run with --web)." };
        const n = Math.min(Math.max(Number(args.count) || 5, 1), 10);
        const out = await searchWeb(String(args.query ?? ""), n);
        if (!out.results.length) {
          return { result: out.error ? `Search via ${out.provider} failed: ${out.error}` : `No results for "${args.query}" (via ${out.provider}).` };
        }
        const text =
          `Top ${out.results.length} results (via ${out.provider}) for "${args.query}":\n\n` +
          out.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
        return { result: clip(redactSecrets(text)) };
      }
      case "web_fetch": {
        if (!ctx.allowWeb) return { result: "Denied: web access is disabled (run with --web)." };
        return { result: clip(await webFetch(String(args.url ?? ""))) };
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
