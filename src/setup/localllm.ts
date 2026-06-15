// Detect / install / update a local LLM runtime (Ollama) and pull models.
// Cross-platform best-effort: we shell out to the user's package managers and the
// Ollama CLI, stream output, and degrade to printed instructions when we can't act.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export interface ModelSuggestion {
  id: string;
  label: string;
  sizeGb: number;
  note: string;
}

/**
 * Capability-ranked catalog of local coding models (Ollama tags, Q4_K_M quant).
 * `diskGb` ≈ download/on-disk size; `minRamGb` is the RAM needed to load the weights
 * AND leave headroom for the OS + KV cache. NOTE for MoE models like 30B-A3B: the
 * "A3B" cuts *compute*, not memory — all expert weights still reside in RAM — so
 * their minRamGb tracks total params, not active params. `rank` = higher is stronger.
 */
export interface ModelSpec {
  id: string;
  label: string;
  paramsB: number;
  diskGb: number;
  minRamGb: number;
  rank: number;
  note: string;
}

export const LOCAL_MODEL_CATALOG: ModelSpec[] = [
  { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", paramsB: 32, diskGb: 20, minRamGb: 32, rank: 6, note: "strongest local coder; needs 32GB+" },
  { id: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", paramsB: 14, diskGb: 9, minRamGb: 16, rank: 5, note: "strong coder; sweet spot for 16GB" },
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", paramsB: 7, diskGb: 4.7, minRamGb: 12, rank: 4, note: "solid coder for ~12–16GB" },
  { id: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", paramsB: 3, diskGb: 2.0, minRamGb: 8, rank: 3, note: "light coder for 8GB" },
  { id: "llama3.2:3b", label: "Llama 3.2 3B", paramsB: 3, diskGb: 2.0, minRamGb: 8, rank: 2, note: "fast general; very light" },
  { id: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", paramsB: 1.5, diskGb: 1.0, minRamGb: 6, rank: 1, note: "tiny fallback" },
];

const DISK_MARGIN_GB = 3; // keep headroom so the volume doesn't fill up

export interface SystemSpec {
  platform: NodeJS.Platform;
  arch: string;
  cpu: string;
  ramGb: number;
  freeDiskGb: number;
}

export function totalRamGb(): number {
  return Math.round(os.totalmem() / 1024 ** 3);
}

/** Free space (GB) on the volume that will hold the model files (~ the home dir). */
export function freeDiskGb(atPath = os.homedir()): number {
  try {
    const s = fs.statfsSync(atPath); // works on macOS/Linux/Windows in Node ≥ 18.15
    return Math.round((s.bsize * s.bavail) / 1024 ** 3);
  } catch {
    // `df` doesn't exist on Windows — don't block model picks there; on POSIX parse df.
    if (process.platform === "win32") return 4096; // generous sentinel; statfs above is the real check
    try {
      const out = execSync(`df -k "${atPath}"`, { encoding: "utf8" }).trim().split("\n").pop() ?? "";
      const cols = out.split(/\s+/);
      const availKb = parseInt(cols[3], 10);
      return Number.isFinite(availKb) ? Math.round(availKb / 1024 / 1024) : 0;
    } catch {
      return 0;
    }
  }
}

function cpuBrand(): string {
  if (process.platform === "darwin") {
    try {
      return execSync("sysctl -n machdep.cpu.brand_string", { encoding: "utf8" }).trim();
    } catch {
      /* fall through */
    }
  }
  return os.cpus()?.[0]?.model ?? `${os.arch()} CPU`;
}

/** Measure the machine so we can pick the largest model it can actually run. */
export function measureSystem(): SystemSpec {
  return {
    platform: process.platform,
    arch: os.arch(),
    cpu: cpuBrand(),
    ramGb: totalRamGb(),
    freeDiskGb: freeDiskGb(),
  };
}

export interface ModelRecommendation {
  best: ModelSpec | null;
  fits: ModelSpec[]; // all that fit, strongest first
  blocked: { spec: ModelSpec; reason: string }[]; // notable models that DON'T fit, with why
  sys: SystemSpec;
}

/** Pick the strongest catalog model that fits this machine's RAM and free disk. */
export function recommendBestModel(sys: SystemSpec = measureSystem()): ModelRecommendation {
  const fits: ModelSpec[] = [];
  const blocked: { spec: ModelSpec; reason: string }[] = [];
  for (const m of LOCAL_MODEL_CATALOG) {
    const ramOk = sys.ramGb >= m.minRamGb;
    const diskOk = sys.freeDiskGb >= m.diskGb + DISK_MARGIN_GB;
    if (ramOk && diskOk) {
      fits.push(m);
    } else if (m.rank >= 5) {
      // Only explain the high-end models the user is likely asking about.
      const why = !ramOk
        ? `needs ~${m.minRamGb}GB RAM (have ${sys.ramGb}GB)`
        : `needs ~${(m.diskGb + DISK_MARGIN_GB).toFixed(0)}GB free disk (have ${sys.freeDiskGb}GB)`;
      blocked.push({ spec: m, reason: why });
    }
  }
  fits.sort((a, b) => b.rank - a.rank);
  return { best: fits[0] ?? null, fits, blocked, sys };
}

/** RAM-aware default model suggestions (coding-focused, OpenAI-tool-compatible). */
export function suggestModels(): ModelSuggestion[] {
  const { sys, fits } = recommendBestModel();
  void sys;
  return fits.map((m) => ({ id: m.id, label: m.label, sizeGb: m.diskGb, note: m.note }));
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
