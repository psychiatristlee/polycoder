// GPU/VRAM detection + "heaviest model that fits" selection for the subagent.
// Cross-platform, dependency-free: nvidia-smi (Win/Linux), Apple unified memory (Mac),
// rocm-smi (AMD best-effort), else CPU/RAM fallback. Reuses Ollama helpers from setup.
import { execSync } from "node:child_process";
import os from "node:os";
import { freeDiskGb, totalRamGb } from "../setup/localllm.js";

export interface GpuInfo {
  kind: "nvidia" | "apple" | "amd" | "cpu";
  name: string;
  vramGb: number; // usable VRAM (or unified-memory budget) in GB; 0 = no GPU
}

export interface GpuModel {
  id: string;
  label: string;
  minVramGb: number; // Q4_K_M weights + KV headroom
  diskGb: number;
  rank: number; // higher = heavier/stronger
}

// Heaviest-first coding models. minVramGb ≈ Q4 weights + context KV margin.
export const GPU_CATALOG: GpuModel[] = [
  { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", minVramGb: 22, diskGb: 20, rank: 7 },
  { id: "deepseek-coder-v2:16b", label: "DeepSeek-Coder-V2 16B", minVramGb: 12, diskGb: 9, rank: 6 },
  { id: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", minVramGb: 11, diskGb: 9, rank: 5 },
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", minVramGb: 6, diskGb: 4.7, rank: 4 },
  { id: "qwen2.5-coder:3b", label: "Qwen2.5 Coder 3B", minVramGb: 3, diskGb: 2.0, rank: 3 },
  { id: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", minVramGb: 2, diskGb: 1.0, rank: 2 },
  { id: "llama3.2:3b", label: "Llama 3.2 3B", minVramGb: 3, diskGb: 2.0, rank: 1 },
];

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

function detectNvidia(): GpuInfo | null {
  const cmds =
    process.platform === "win32"
      ? [
          'nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits',
          '"C:\\Windows\\System32\\nvidia-smi.exe" --query-gpu=memory.total,name --format=csv,noheader,nounits',
          '"C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe" --query-gpu=memory.total,name --format=csv,noheader,nounits',
        ]
      : ["nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits"];
  for (const c of cmds) {
    const out = tryExec(c);
    if (!out) continue;
    // one GPU per line: "24576, NVIDIA GeForce RTX 4090"
    let best: GpuInfo | null = null;
    for (const line of out.split("\n")) {
      const m = line.split(",");
      const mib = parseInt(m[0], 10);
      if (!Number.isFinite(mib)) continue;
      const gb = Math.round(mib / 1024);
      if (!best || gb > best.vramGb) best = { kind: "nvidia", name: (m[1] || "NVIDIA GPU").trim(), vramGb: gb };
    }
    if (best) return best;
  }
  return null;
}

function detectAmd(): GpuInfo | null {
  const out = tryExec("rocm-smi --showmeminfo vram --csv");
  if (!out) return null;
  const m = out.match(/(\d+)/g);
  if (!m) return null;
  const bytes = Math.max(...m.map((x) => parseInt(x, 10)).filter((n) => n > 1_000_000));
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return { kind: "amd", name: "AMD GPU (ROCm)", vramGb: Math.round(bytes / 1024 ** 3) };
}

/** Detect the host's inference accelerator + usable VRAM budget. */
export function measureGpu(): GpuInfo {
  const nv = detectNvidia();
  if (nv) return nv;
  if (process.platform === "darwin" && os.arch() === "arm64") {
    // Apple Silicon unified memory — Metal can address ~70% of RAM for model weights.
    return { kind: "apple", name: `Apple Silicon (${totalRamGb()}GB unified)`, vramGb: Math.floor(totalRamGb() * 0.7) };
  }
  const amd = detectAmd();
  if (amd) return amd;
  return { kind: "cpu", name: "CPU only (no GPU detected)", vramGb: 0 };
}

const DISK_MARGIN_GB = 3;

export interface GpuPick {
  gpu: GpuInfo;
  model: GpuModel | null;
  fits: GpuModel[];
  freeDiskGb: number;
  reason: string;
}

/**
 * Pick the heaviest model that runs COMFORTABLY (≈15% VRAM headroom) + fits disk.
 * `installed` model ids skip the disk-margin check — they're already on disk, so a full
 * volume shouldn't disqualify a model that needs no new download.
 */
export function recommendBestModelGpu(
  gpu: GpuInfo = measureGpu(),
  disk = freeDiskGb(),
  installed: string[] = []
): GpuPick {
  // CPU-only: fall back to a RAM-budgeted small model (subagent is pointless here, warn upstream).
  const budget = gpu.kind === "cpu" ? Math.max(0, totalRamGb() - 4) : gpu.vramGb * 0.85;
  const have = new Set(installed);
  const fits = GPU_CATALOG.filter(
    (m) => m.minVramGb <= budget && (have.has(m.id) || disk >= m.diskGb + DISK_MARGIN_GB)
  ).sort((a, b) => b.rank - a.rank);
  const model = fits[0] ?? null;
  const reason = !model
    ? `No model fits ${gpu.kind === "cpu" ? `${totalRamGb()}GB RAM` : `${gpu.vramGb}GB VRAM`} + ${disk}GB free disk.`
    : `${gpu.name} → ${model.label} (needs ~${model.minVramGb}GB, budget ${Math.round(budget)}GB${have.has(model.id) ? ", already pulled" : ""}).`;
  return { gpu, model, fits, freeDiskGb: disk, reason };
}
