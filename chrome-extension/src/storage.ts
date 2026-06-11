import type { ModelInfo } from "../../src/providers/types.js";
import type { RoutingObjective } from "../../src/router/policy.js";

export interface ChromeConfig {
  openrouterApiKey?: string;
  objective: RoutingObjective;
  referer: string;
  title: string;
}

const DEFAULT: ChromeConfig = {
  objective: "value",
  referer: "https://github.com/psychiatristlee/polycoder",
  title: "Polymath",
};

export async function getConfig(): Promise<ChromeConfig> {
  const r = await chrome.storage.local.get("config");
  return { ...DEFAULT, ...(r.config ?? {}) };
}

export async function setConfig(patch: Partial<ChromeConfig>): Promise<void> {
  const cur = await getConfig();
  await chrome.storage.local.set({ config: { ...cur, ...patch } });
}

interface ModelCache {
  fetchedAt: number;
  models: ModelInfo[];
}

export async function getCachedModels(maxAgeMs = 12 * 3600 * 1000): Promise<ModelInfo[] | null> {
  const r = await chrome.storage.local.get("modelCache");
  const c = r.modelCache as ModelCache | undefined;
  if (c && Date.now() - c.fetchedAt < maxAgeMs && c.models?.length) return c.models;
  return null;
}

export async function setCachedModels(models: ModelInfo[]): Promise<void> {
  await chrome.storage.local.set({ modelCache: { fetchedAt: Date.now(), models } });
}
