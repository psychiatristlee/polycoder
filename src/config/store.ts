import fs from "node:fs";
import { configFilePath, ensureConfigDir } from "./paths.js";
import type { RoutingObjective } from "../router/policy.js";

export interface PolymathConfig {
  /** OpenRouter API key (sk-or-...). Stored locally with 0600 perms. */
  openrouterApiKey?: string;
  /** Default routing objective for new sessions. */
  defaultObjective: RoutingObjective;
  /** Optional ceiling on per-call cost (USD); models above this are excluded from routing. */
  maxCostPerCallUsd?: number;
  /** Headers OpenRouter uses for attribution / rankings. */
  referer: string;
  title: string;
  firestore: {
    enabled: boolean;
    projectId: string;
    collection: string;
  };
  /** Pinned model overrides per task type (id), takes precedence over the router. */
  pinned?: Record<string, string>;
}

export const DEFAULT_CONFIG: PolymathConfig = {
  defaultObjective: "value",
  referer: "https://github.com/polymath-agent",
  title: "Polymath",
  firestore: {
    enabled: false,
    projectId: "mathology-b8e3d",
    collection: "polymath_usage",
  },
};

export function loadConfig(): PolymathConfig {
  const file = configFilePath();
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PolymathConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      firestore: { ...DEFAULT_CONFIG.firestore, ...(raw.firestore ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: PolymathConfig): void {
  ensureConfigDir();
  const file = configFilePath();
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Tighten perms in case the file already existed with looser ones.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
}

/** Resolve the API key from env (takes precedence) or stored config. */
export function resolveApiKey(config: PolymathConfig): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || config.openrouterApiKey;
}
