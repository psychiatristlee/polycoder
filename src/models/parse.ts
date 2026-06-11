// Browser-safe model parsing (no fs / node deps). Shared by the CLI registry and
// by the VSCode/Chrome extensions, which cache via their own platform storage.
import type { ModelInfo } from "../providers/types.js";
import { classifyTier } from "./tiers.js";

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

export function toPerMTok(raw: string | number | undefined): number {
  const n = typeof raw === "string" ? parseFloat(raw) : raw ?? 0;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * 1_000_000; // OpenRouter prices are USD per token
}

export function parseModels(raw: any[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of raw) {
    if (!m?.id) continue;
    const promptUsdPerMTok = toPerMTok(m.pricing?.prompt);
    const completionUsdPerMTok = toPerMTok(m.pricing?.completion);
    const provider = String(m.id).split("/")[0] ?? "unknown";
    const modalities: string[] =
      m.architecture?.input_modalities ??
      (typeof m.architecture?.modality === "string"
        ? String(m.architecture.modality).split(/[+\->]/)
        : []);
    const supported: string[] = m.supported_parameters ?? [];
    out.push({
      id: m.id,
      name: m.name ?? m.id,
      provider,
      contextLength: m.context_length ?? m.top_provider?.context_length ?? 0,
      pricing: { promptUsdPerMTok, completionUsdPerMTok },
      tier: classifyTier(`${m.id} ${m.name ?? ""}`, completionUsdPerMTok),
      capabilities: {
        tools: supported.includes("tools") || supported.includes("tool_choice"),
        vision: modalities.some((x) => /image|vision/i.test(x)),
      },
    });
  }
  return out;
}
