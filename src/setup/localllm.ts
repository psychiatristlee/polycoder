// Detect / install / update a local LLM runtime (Ollama) and pull models.
// Cross-platform best-effort: we shell out to the user's package managers and the
// Ollama CLI, stream output, and degrade to printed instructions when we can't act.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
export type ModelRole = "coding" | "general" | "reasoning" | "vision";
export interface ModelSpec {
  id: string;
  label: string;
  paramsB: number;
  diskGb: number;
  minRamGb: number;
  rank: number; // higher = preferred by auto-pick (coders rank highest — poly is a coding agent)
  note: string;
  role: ModelRole;
}

// Curated Ollama models across roles. The model picker shows these grouped by role with
// per-machine fit; the router auto-switches among whatever is installed, per task/cost.
export const LOCAL_MODEL_CATALOG: ModelSpec[] = [
  // ── Coding ──
  { id: "codellama:70b", label: "Code Llama 70B", paramsB: 70, diskGb: 39, minRamGb: 48, rank: 25, note: "대형 코더 (48GB+ 필요)", role: "coding" },
  { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", paramsB: 32, diskGb: 20, minRamGb: 32, rank: 24, note: "최강급 로컬 코더 (32GB+ 필요)", role: "coding" },
  { id: "deepseek-coder-v2:16b", label: "DeepSeek-Coder-V2 16B", paramsB: 16, diskGb: 9, minRamGb: 16, rank: 23, note: "강력한 MoE 코더", role: "coding" },
  { id: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", paramsB: 14, diskGb: 9, minRamGb: 16, rank: 22, note: "강력한 코더 · 16GB 적정", role: "coding" },
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", paramsB: 7, diskGb: 4.7, minRamGb: 12, rank: 21, note: "균형형 코더 · 12~16GB", role: "coding" },
  { id: "codellama:13b", label: "Code Llama 13B", paramsB: 13, diskGb: 7.4, minRamGb: 16, rank: 14, note: "Meta 코더", role: "coding" },
  { id: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", paramsB: 3, diskGb: 2.0, minRamGb: 8, rank: 13, note: "가벼운 코더 · 8GB", role: "coding" },
  { id: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", paramsB: 1.5, diskGb: 1.0, minRamGb: 6, rank: 6, note: "초경량 폴백", role: "coding" },
  // ── Reasoning ──
  { id: "deepseek-r1:70b", label: "DeepSeek-R1 70B", paramsB: 70, diskGb: 43, minRamGb: 48, rank: 19, note: "최강급 추론 (48GB+ 필요)", role: "reasoning" },
  { id: "deepseek-r1:32b", label: "DeepSeek-R1 32B", paramsB: 32, diskGb: 20, minRamGb: 32, rank: 18, note: "강력한 추론 (32GB+ 필요)", role: "reasoning" },
  { id: "deepseek-r1:14b", label: "DeepSeek-R1 14B", paramsB: 14, diskGb: 9, minRamGb: 16, rank: 17, note: "강력한 추론(사고연쇄)", role: "reasoning" },
  { id: "deepseek-r1:8b", label: "DeepSeek-R1 8B", paramsB: 8, diskGb: 4.9, minRamGb: 12, rank: 16, note: "추론 · 중간 크기", role: "reasoning" },
  { id: "deepseek-r1:7b", label: "DeepSeek-R1 7B", paramsB: 7, diskGb: 4.7, minRamGb: 12, rank: 15, note: "추론 · 경량", role: "reasoning" },
  // ── General ──
  { id: "qwen2.5:72b", label: "Qwen2.5 72B", paramsB: 72, diskGb: 47, minRamGb: 64, rank: 16, note: "대형 범용 (64GB+ 필요)", role: "general" },
  { id: "llama3.1:70b", label: "Llama 3.1 70B", paramsB: 70, diskGb: 40, minRamGb: 48, rank: 16, note: "대형 범용 (48GB+ 필요)", role: "general" },
  { id: "llama3.1:8b", label: "Llama 3.1 8B", paramsB: 8, diskGb: 4.7, minRamGb: 12, rank: 12, note: "범용 · 견고", role: "general" },
  { id: "qwen2.5:7b", label: "Qwen2.5 7B", paramsB: 7, diskGb: 4.7, minRamGb: 12, rank: 11, note: "범용 · 균형", role: "general" },
  { id: "gemma2:9b", label: "Gemma 2 9B", paramsB: 9, diskGb: 5.4, minRamGb: 12, rank: 10, note: "Google 범용", role: "general" },
  { id: "mistral:7b", label: "Mistral 7B", paramsB: 7, diskGb: 4.1, minRamGb: 12, rank: 9, note: "빠른 범용", role: "general" },
  { id: "phi3.5", label: "Phi-3.5 Mini", paramsB: 3.8, diskGb: 2.2, minRamGb: 8, rank: 8, note: "작지만 똑똑함", role: "general" },
  { id: "gemma2:2b", label: "Gemma 2 2B", paramsB: 2, diskGb: 1.6, minRamGb: 8, rank: 5, note: "초경량 범용", role: "general" },
  { id: "llama3.2:3b", label: "Llama 3.2 3B", paramsB: 3, diskGb: 2.0, minRamGb: 8, rank: 4, note: "빠른 범용 · 매우 가벼움", role: "general" },
  // ── Vision ──
  { id: "llama3.2-vision:11b", label: "Llama 3.2 Vision 11B", paramsB: 11, diskGb: 7.9, minRamGb: 16, rank: 7, note: "이미지 이해", role: "vision" },
  { id: "llava:7b", label: "LLaVA 7B", paramsB: 7, diskGb: 4.7, minRamGb: 12, rank: 3, note: "이미지 이해 · 경량", role: "vision" },
  { id: "moondream", label: "Moondream 2", paramsB: 1.8, diskGb: 1.7, minRamGb: 8, rank: 2, note: "초경량 비전", role: "vision" },
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

/** Default per-user Ollama install path on Windows (PATH may not be refreshed yet). */
function winOllamaPath(): string {
  return process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : "";
}

/** The ollama executable to invoke (PATH name, or the resolved Windows install path). */
export function ollamaCmd(): string {
  if (process.platform === "win32" && !which("ollama")) {
    const p = winOllamaPath();
    if (p && fs.existsSync(p)) return p;
  }
  return "ollama";
}

export function ollamaInstalled(): boolean {
  if (which("ollama")) return true;
  // On Windows the per-user install may not be on PATH in this process yet.
  const p = winOllamaPath();
  return !!p && fs.existsSync(p);
}

/**
 * Windows + a non-ASCII (e.g. Korean) username breaks Ollama: llama-server can't open
 * model files under `C:\Users\<한글>\.ollama\...` (the path is mojibake'd), failing with
 * "error loading model". Fix it by relocating the model store to an ASCII path via
 * OLLAMA_MODELS — set for THIS process (so poly-spawned ollama uses it) and persisted with
 * setx (so the tray app picks it up after a restart). Returns the new dir, or null if no
 * issue / not applicable.
 */
export function fixWindowsModelsPath(): { dir: string; restartNeeded: boolean } | null {
  if (process.platform !== "win32") return null;
  const home = process.env.USERPROFILE || os.homedir();
  if (/^[\x00-\x7F]*$/.test(home)) return null; // ASCII home → no issue
  const dir = path.join(process.env.PUBLIC || "C:\\Users\\Public", ".ollama", "models");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  const already = process.env.OLLAMA_MODELS === dir;
  process.env.OLLAMA_MODELS = dir;
  try {
    execSync(`setx OLLAMA_MODELS "${dir}"`, { stdio: "ignore" });
  } catch {
    /* best-effort persistence */
  }
  return { dir, restartNeeded: !already };
}

/**
 * Move already-downloaded models off a non-ASCII path to the ASCII OLLAMA_MODELS dir, so we
 * don't have to re-download multi-GB models. Same-drive rename is instant. Returns whether
 * anything moved (best-effort; the caller should stop Ollama first so files aren't locked).
 */
export function migrateOllamaModelsToAscii(): { moved: number; dir: string } | null {
  if (process.platform !== "win32") return null;
  const home = process.env.USERPROFILE || os.homedir();
  if (/^[\x00-\x7F]*$/.test(home)) return null; // ASCII home → nothing to migrate
  const dest = path.join(process.env.PUBLIC || "C:\\Users\\Public", ".ollama", "models");
  const src = path.join(home, ".ollama", "models");
  let moved = 0;
  try {
    if (!fs.existsSync(src)) return { moved, dir: dest };
    fs.mkdirSync(dest, { recursive: true });
    const merge = (s: string, d: string) => {
      for (const e of fs.readdirSync(s)) {
        const sp = path.join(s, e);
        const dp = path.join(d, e);
        if (fs.existsSync(dp) && fs.statSync(sp).isDirectory()) {
          fs.mkdirSync(dp, { recursive: true });
          merge(sp, dp);
        } else if (!fs.existsSync(dp)) {
          try {
            fs.renameSync(sp, dp);
            moved++;
          } catch {
            /* locked or cross-device — leave it */
          }
        }
      }
    };
    merge(src, dest);
  } catch {
    /* best-effort */
  }
  return { moved, dir: dest };
}

/** Best-effort restart of the Ollama server so it picks up new env (e.g. OLLAMA_MODELS). */
export async function restartOllama(baseUrl = "http://localhost:11434"): Promise<boolean> {
  try {
    if (process.platform === "win32") execSync("taskkill /f /im ollama.exe", { stdio: "ignore" });
    else execSync("pkill -x ollama || pkill ollama", { stdio: "ignore" });
  } catch {
    /* may not be running */
  }
  return ensureServer(baseUrl);
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
    // Prefer the official per-user installer over winget: it needs no admin/UAC (winget's
    // machine-scope path was throwing 0x8007029c assertion failures), runs silently, and
    // auto-starts the Ollama service. Downloaded to %TEMP% then run /VERYSILENT.
    const ps =
      "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " +
      "$o=Join-Path $env:TEMP 'OllamaSetup.exe'; " +
      "Write-Host 'Downloading Ollama (~1GB)...'; " +
      "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $o; " +
      "Write-Host 'Installing Ollama (silent, no admin)...'; " +
      "Start-Process -FilePath $o -ArgumentList '/VERYSILENT','/NORESTART' -Wait; " +
      "Write-Host 'Ollama install done.'";
    return {
      canAuto: true,
      command: { cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps] },
      manual: "https://ollama.com/download/OllamaSetup.exe 를 받아 실행 (SmartScreen이 막으면 '추가 정보 → 실행'), 설치 후 앱 재시작",
    };
  }
  return { canAuto: false, manual: "See https://ollama.com/download" };
}

/** Start the Ollama background service if it isn't already up (best-effort). */
export async function ensureServer(baseUrl = "http://localhost:11434"): Promise<boolean> {
  if (await ollamaServerUp(baseUrl)) return true;
  // `ollama serve` detached is the reliable way to start it on every platform. We avoid
  // `brew services start` — its launchctl bootstrap fails (error 5) when already bootstrapped
  // and dumps a scary error, and we don't need persistence here.
  try {
    const child = spawn(ollamaCmd(), ["serve"], { stdio: "ignore", detached: true, windowsHide: true });
    child.unref();
  } catch {
    /* ignore */
  }
  // Give it a moment, then re-check (poll up to ~7s; cold start can be slow).
  for (let i = 0; i < 14; i++) {
    if (await ollamaServerUp(baseUrl)) return true;
    await delay(500);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
