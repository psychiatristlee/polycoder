import { OpenRouterClient } from "../../src/providers/openrouter.js";
import { parseModels } from "../../src/models/parse.js";
import type { ModelInfo } from "../../src/providers/types.js";
import { getCachedModels, setCachedModels } from "./storage.js";

/** Cache-first model catalog for the extension (chrome.storage instead of fs). */
export async function loadModels(client: OpenRouterClient, refresh = false): Promise<ModelInfo[]> {
  if (!refresh) {
    const cached = await getCachedModels();
    if (cached) return cached;
  }
  const raw = await client.listRawModels();
  const models = parseModels(raw);
  if (models.length) await setCachedModels(models);
  return models;
}
