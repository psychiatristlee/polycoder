import fs from "node:fs";
import { modelCachePath, ensureConfigDir } from "../config/paths.js";
import type { ModelInfo } from "../providers/types.js";
import type { OpenRouterClient } from "../providers/openrouter.js";
import { parseModels, findModel } from "./parse.js";

export { parseModels, findModel };

const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

interface ModelCache {
  fetchedAt: number;
  models: ModelInfo[];
}

export function loadCachedModels(maxAgeMs = CACHE_TTL_MS): ModelInfo[] | null {
  try {
    const file = modelCachePath();
    if (!fs.existsSync(file)) return null;
    const cache = JSON.parse(fs.readFileSync(file, "utf8")) as ModelCache;
    if (Date.now() - cache.fetchedAt > maxAgeMs) return null;
    return cache.models;
  } catch {
    return null;
  }
}

export function writeModelCache(models: ModelInfo[]): void {
  ensureConfigDir();
  const cache: ModelCache = { fetchedAt: Date.now(), models };
  fs.writeFileSync(modelCachePath(), JSON.stringify(cache));
}

/** Cache-first model catalog. Pass refresh=true to force a network fetch. */
export async function getModels(
  client: OpenRouterClient,
  opts: { refresh?: boolean } = {}
): Promise<ModelInfo[]> {
  if (!opts.refresh) {
    const cached = loadCachedModels();
    if (cached && cached.length) return cached;
  }
  const raw = await client.listRawModels();
  const models = parseModels(raw);
  writeModelCache(models);
  return models;
}
