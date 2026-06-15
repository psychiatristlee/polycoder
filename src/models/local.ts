// Local LLM catalog (Ollama / LM Studio / llama.cpp — any OpenAI-compatible /models).
// Local models join routing as `local/<name>` with $0 pricing: under `cheapest` they
// win every task they qualify for; usage is still logged (0 cost, real tokens).
import type { ModelInfo } from "../providers/types.js";
import type { OpenRouterClient } from "../providers/openrouter.js";
import { LOCAL_PREFIX } from "../providers/openrouter.js";
import { classifyTier } from "./tiers.js";

// Local models that actually support Ollama's tool/function-calling API. Sending tools to a
// model that doesn't (e.g. deepseek-coder-v2, codellama, gemma, phi3, llava) returns HTTP 400
// ("does not support tools"). Conservative ALLOWLIST: anything not matched is treated as
// tool-less and driven via text-based tool calls (which the agent loop handles), so it never
// 400s — and the router keeps tool-needing tasks (edit/command/…) on a tool-capable model.
const LOCAL_TOOLS_OK =
  /\b(qwen2\.5|qwen3|qwq|llama-?3\.[123]|llama-?4|mistral(-nemo|-small|-large)?|mixtral|command-?r|command-?a|firefunction|hermes\s?3|granite\s?3|smollm2|cogito|nemotron|athene|devstral|magistral)\b/i;

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
        tools: LOCAL_TOOLS_OK.test(name),
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
