import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Base config directory: $POLYMATH_HOME, else $XDG_CONFIG_HOME/polymath, else ~/.config/polymath. */
export function configDir(): string {
  const override = process.env.POLYMATH_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "polymath");
}

export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function configFilePath(): string {
  return path.join(configDir(), "config.json");
}

export function dbFilePath(): string {
  return path.join(configDir(), "usage.sqlite");
}

/** Cached OpenRouter model catalog. */
export function modelCachePath(): string {
  return path.join(configDir(), "models.cache.json");
}

/** Local self-owned search index (crawled docs + BM25). */
export function searchDbFilePath(): string {
  return path.join(configDir(), "search.sqlite");
}
