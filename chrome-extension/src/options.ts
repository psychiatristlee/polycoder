import { OpenRouterClient } from "../../src/providers/openrouter.js";
import type { RoutingObjective } from "../../src/router/policy.js";
import { getConfig, setConfig } from "./storage.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyEl = $<HTMLInputElement>("key");
const objEl = $<HTMLSelectElement>("objective");
const statusEl = $<HTMLDivElement>("status");

async function load() {
  const cfg = await getConfig();
  if (cfg.openrouterApiKey) keyEl.value = cfg.openrouterApiKey;
  objEl.value = cfg.objective;
}

async function save() {
  const key = keyEl.value.trim();
  const objective = objEl.value as RoutingObjective;
  statusEl.textContent = "Validating…";
  statusEl.className = "";

  if (!key) {
    statusEl.textContent = "Enter a key first.";
    statusEl.className = "err";
    return;
  }

  const cfg = await getConfig();
  const client = new OpenRouterClient({ apiKey: key, referer: cfg.referer, title: cfg.title });
  try {
    const info = await client.validateKey();
    await setConfig({ openrouterApiKey: key, objective });
    const detail = [info.label, info.limit == null ? "no limit" : `$${info.limit} limit`]
      .filter(Boolean)
      .join(" · ");
    statusEl.textContent = "✓ Saved & connected" + (detail ? ` (${detail})` : "");
    statusEl.className = "ok";
  } catch (e: any) {
    // Still save (e.g. offline), but surface the failure.
    await setConfig({ openrouterApiKey: key, objective });
    statusEl.textContent = "Saved, but validation failed: " + (e?.message ?? e);
    statusEl.className = "err";
  }
}

$("save").addEventListener("click", save);
load();
