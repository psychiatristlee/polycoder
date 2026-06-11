// Detect / install / update a local LLM runtime (Ollama) and pull models.
// Cross-platform best-effort: we shell out to the user's package managers and the
// Ollama CLI, stream output, and degrade to printed instructions when we can't act.
import { execSync, spawn } from "node:child_process";
import os from "node:os";

export interface ModelSuggestion {
  id: string;
  label: string;
  sizeGb: number;
  note: string;
}

/** RAM-aware default model suggestions (coding-focused, OpenAI-tool-compatible). */
export function suggestModels(): ModelSuggestion[] {
  const ramGb = Math.round(os.totalmem() / 1024 ** 3);
  const list: ModelSuggestion[] = [];
  if (ramGb >= 13) list.push({ id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", sizeGb: 4.7, note: "best coding pick for ~16GB" });
  list.push({ id: "llama3.2:3b", label: "Llama 3.2 3B", sizeGb: 2.0, note: "fast, light; great for cheap tasks" });
  if (ramGb >= 30) list.push({ id: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", sizeGb: 9.0, note: "stronger coding for 32GB+" });
  return list;
}

export function totalRamGb(): number {
  return Math.round(os.totalmem() / 1024 ** 3);
}

function which(cmd: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function ollamaInstalled(): boolean {
  return which("ollama");
}

export function ollamaVersion(): string | null {
  try {
    return execSync("ollama --version", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/** Is the Ollama HTTP server reachable? */
export async function ollamaServerUp(baseUrl = "http://localhost:11434"): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/api/version`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function installedModels(baseUrl = "http://localhost:11434"): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`);
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

/** Run a command, streaming stdout/stderr to the console. Resolves false on failure. */
export function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

export interface InstallInstructions {
  canAuto: boolean;
  command?: { cmd: string; args: string[] };
  manual: string;
}

/** How to install Ollama on this platform. */
export function ollamaInstallPlan(): InstallInstructions {
  const platform = process.platform;
  if (platform === "darwin") {
    if (which("brew")) return { canAuto: true, command: { cmd: "brew", args: ["install", "ollama"] }, manual: "brew install ollama" };
    return { canAuto: false, manual: "Install Homebrew (https://brew.sh) then `brew install ollama`, or download https://ollama.com/download" };
  }
  if (platform === "linux") {
    return { canAuto: true, command: { cmd: "sh", args: ["-c", "curl -fsSL https://ollama.com/install.sh | sh"] }, manual: "curl -fsSL https://ollama.com/install.sh | sh" };
  }
  if (platform === "win32") {
    if (which("winget")) return { canAuto: true, command: { cmd: "winget", args: ["install", "-e", "--id", "Ollama.Ollama"] }, manual: "winget install Ollama.Ollama" };
    return { canAuto: false, manual: "Download the installer from https://ollama.com/download" };
  }
  return { canAuto: false, manual: "See https://ollama.com/download" };
}

/** Start the Ollama background service if it isn't already up (best-effort). */
export async function ensureServer(baseUrl = "http://localhost:11434"): Promise<boolean> {
  if (await ollamaServerUp(baseUrl)) return true;
  if (process.platform === "darwin" && which("brew")) {
    await run("brew", ["services", "start", "ollama"]);
  } else {
    // Detached `ollama serve` for linux/win or non-brew setups.
    try {
      const child = spawn("ollama", ["serve"], { stdio: "ignore", detached: true });
      child.unref();
    } catch {
      /* ignore */
    }
  }
  // Give it a moment, then re-check (poll up to ~5s).
  for (let i = 0; i < 10; i++) {
    if (await ollamaServerUp(baseUrl)) return true;
    await delay(500);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
