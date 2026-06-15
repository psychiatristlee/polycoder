// `poly subagent link` — point THIS machine (the polyrun client) at a remote subagent.
// Two ways in: explicit --url/--token (copy-pasted from the GPU box's `serve` output),
// or auto-discovery from the account registry (Firestore) when both share the same
// OpenRouter key. Writes config.local.{enabled,baseUrl,authToken} so `local/*` models
// route to the subagent's auth-proxy with the relay token.
import { loadConfig, saveConfig } from "../config/store.js";
import * as registry from "./registry.js";
import { c } from "../util/format.js";

export interface LinkOptions {
  url?: string;
  token?: string;
  /** Pick a registered node automatically (requires same account / Firestore). */
  auto?: boolean;
  /** Pick a specific registered node by its short id. */
  node?: string;
}

function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  // Accept a bare host or a /v1 endpoint; normalize to an OpenAI-compatible /v1 base.
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  if (!/\/v1$/i.test(u)) u += "/v1";
  return u;
}

/** Probe the subagent's /models with the relay token to confirm it's reachable + authed. */
export async function probe(baseUrl: string, token: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return { ok: false, models: [], error: "unauthorized (relay token mismatch)" };
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as { data?: any[] };
    const models = (json.data ?? []).map((m: any) => m.id).filter(Boolean);
    return { ok: true, models };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.message || "unreachable" };
  }
}

export async function runLink(opts: LinkOptions): Promise<void> {
  let baseUrl = opts.url ? normalizeBaseUrl(opts.url) : "";
  let token = (opts.token || "").trim();
  let pickedModel = "";

  // Auto-discovery from the registry when no explicit URL was given.
  if (!baseUrl) {
    console.log(c.dim("Looking up subagents on your account…"));
    const nodes = await registry.listNodes();
    if (!nodes.length) {
      console.log(c.yellow("No online subagents found for this account."));
      console.log(c.dim("On the GPU machine run "), c.cyan("poly subagent serve"), c.dim(", then either:"));
      console.log(c.dim("  • re-run "), c.cyan("poly subagent link"), c.dim(" (auto), or"));
      console.log(c.dim("  • paste its endpoint: "), c.cyan("poly subagent link --url <url> --token <token>"));
      return;
    }
    const chosen = opts.node ? nodes.find((n) => n.id === opts.node) : nodes[0];
    if (!chosen) {
      console.log(c.yellow(`No online node with id ${opts.node}. Online nodes:`));
      for (const n of nodes) console.log("  " + c.bold(n.id) + c.dim(`  ${n.hardware?.gpu} · ${n.model} · ${n.transport}`));
      return;
    }
    baseUrl = chosen.endpoint;
    pickedModel = chosen.model;
    console.log(c.green("Found: ") + chosen.hardware?.gpu + c.dim(`  (${chosen.model}, ${chosen.transport})`));
    if (!token) {
      // The registry only stores the token HASH, never the token. The relay token must be
      // copied from the GPU box once (it's printed by `serve`). Match it against the hash.
      console.log(c.yellow("\nThis node needs its relay token (shown once by `poly subagent serve`)."));
      console.log(c.dim("Re-run: ") + c.cyan(`poly subagent link --token <token>${opts.node ? ` --node ${opts.node}` : ""}`));
      return;
    }
    // Fail CLOSED: never send a token to a registry-supplied endpoint we can't verify. A
    // node with no/empty authTokenHash could be spoofed in the registry to harvest tokens.
    if (!chosen.authTokenHash) {
      console.log(c.red("✗ Registered node has no token fingerprint — refusing to send the token."));
      console.log(c.dim("  Link explicitly instead: ") + c.cyan("poly subagent link --url <url> --token <token>"));
      return;
    }
    if (registry.hashToken(token) !== chosen.authTokenHash) {
      console.log(c.red("✗ That token does not match the registered node (hash mismatch)."));
      return;
    }
  }

  if (!token) {
    console.log(c.red("A relay token is required. Pass --token <token> (printed by `poly subagent serve`)."));
    return;
  }

  process.stdout.write(c.dim(`Probing ${baseUrl}… `));
  const res = await probe(baseUrl, token);
  if (!res.ok) {
    console.log(c.red(`✗ ${res.error}`));
    return;
  }
  console.log(c.green("ok") + c.dim(`  (${res.models.length} model${res.models.length === 1 ? "" : "s"})`));

  const cfg = loadConfig();
  cfg.local.enabled = true;
  cfg.local.baseUrl = baseUrl;
  cfg.local.authToken = token;
  saveConfig(cfg);

  const model = pickedModel || res.models[0] || "";
  console.log("\n" + c.bold("✓ Linked to subagent"));
  console.log(c.dim("  baseUrl : ") + baseUrl);
  console.log(c.dim("  models  : ") + res.models.map((m) => `local/${m}`).join(", "));
  if (model) {
    console.log("\n  Route a run to it with:");
    console.log(c.cyan(`    poly run --model local/${model} "<your task>"`));
  }
  console.log(c.dim("\n  Local models now appear in the catalog at $0. Unlink: ") + c.cyan("poly subagent unlink"));
}

export function runUnlink(): void {
  const cfg = loadConfig();
  cfg.local.enabled = false;
  cfg.local.authToken = undefined;
  saveConfig(cfg);
  console.log(c.green("✓ Unlinked. Local/remote models removed from routing."));
}
