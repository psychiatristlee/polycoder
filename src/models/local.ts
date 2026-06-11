// Local LLM catalog (Ollama / LM Studio / llama.cpp — any OpenAI-compatible /models).
// Local models join routing as `local/<name>` with $0 pricing: under `cheapest` they
// win every task they qualify for; usage is still logged (0 cost, real tokens).
import type { ModelInfo } from "../providers/types.js";
import type { OpenRouterClient } from "../providers/openrouter.js";
import { LOCAL_PREFIX } from "../providers/openrouter.js";
import { classifyTier } from "./tiers.js";

export function parseLocalModels(raw: any[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of raw) {
    if (!m?.id) continue;
    const name = String(m.id);
    out.push({
      id: LOCAL_PREFIX + name,
      name: `${name} (local)`,
      provider: "local",
      contextLength: m.context_length ?? 8192,
      pricing: { promptUsdPerMTok: 0, completionUsdPerMTok: 0 },
      tier: classifyTier(name, 0),
      capabilities: {
        // OpenAI-compatible local servers pass tool schemas through; models that
        // can't call tools simply reply with text, which the agent loop handles.
        tools: true,
        vision: /llava|vision|vl\b|moondream/i.test(name),
      },
    });
  }
  return out;
}

/** Fetch local models; returns [] (never throws) so an offline server can't break the CLI. */
export async function getLocalModels(client: OpenRouterClient): Promise<ModelInfo[]> {
  try {
    const raw = await client.listLocalRawModels();
    return parseLocalModels(raw);
  } catch {
    return [];
  }
}
