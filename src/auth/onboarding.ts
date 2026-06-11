import readline from "node:readline";
import { OpenRouterClient } from "../providers/openrouter.js";
import { loadConfig, saveConfig, resolveApiKey, type PolymathConfig } from "../config/store.js";
import { c } from "../util/format.js";

function ask(query: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (opts.hidden) {
      // Mask typed characters (best-effort; the classic readline override).
      const out: any = (rl as any).output;
      (rl as any)._writeToOutput = (str: string) => {
        if (str.includes(query) || str.includes("\n") || str.includes("\r")) out.write(str);
        else out.write("*");
      };
    }
    rl.question(query, (answer) => {
      rl.close();
      if (opts.hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive API-key setup, mirroring Claude Code's first-run connect flow.
 * Returns the saved key, or null if the user aborted.
 */
export async function runLogin(): Promise<string | null> {
  const config = loadConfig();
  const existing = resolveApiKey(config);

  console.log(c.bold("\n🔌 Connect Polymath to your models (via OpenRouter)\n"));
  console.log(
    [
      "Polymath reaches 300+ models from every major provider through a single OpenRouter key.",
      "",
      c.bold("1.") + " Create a key (free to sign up):  " + c.cyan("https://openrouter.ai/keys"),
      c.bold("2.") + " Add credit or use free models:    " + c.cyan("https://openrouter.ai/credits"),
      c.bold("3.") + " Paste the key (starts with " + c.dim("sk-or-...") + ") below.",
      "",
      c.dim("The key is stored locally at ~/.config/polymath/config.json (chmod 600) and never sent anywhere except OpenRouter."),
      "",
    ].join("\n")
  );

  if (existing) {
    const mask = existing.slice(0, 8) + "…" + existing.slice(-4);
    const keep = await ask(`A key is already configured (${mask}). Replace it? [y/N] `);
    if (!/^y/i.test(keep)) {
      console.log(c.dim("Keeping existing key."));
      return existing;
    }
  }

  const key = await ask("OpenRouter API key: ", { hidden: true });
  if (!key) {
    console.log(c.yellow("No key entered — aborted."));
    return null;
  }
  if (!/^sk-or-/.test(key)) {
    console.log(c.yellow("Warning: key does not start with 'sk-or-'. Continuing anyway."));
  }

  process.stdout.write("Validating… ");
  const client = new OpenRouterClient({ apiKey: key, referer: config.referer, title: config.title });
  let ok = false;
  let detail = "";
  try {
    const info = await client.validateKey();
    ok = true;
    const used = typeof info.usage === "number" ? `$${info.usage.toFixed(2)} used` : "";
    const limit = info.limit == null ? "no preset limit" : `$${info.limit} limit`;
    detail = [info.label, used, limit].filter(Boolean).join(" · ");
  } catch (err: any) {
    console.log(c.red("failed."));
    console.log(c.red(`  ${err?.message ?? err}`));
    const save = await ask("Save the key anyway (e.g. offline)? [y/N] ");
    if (!/^y/i.test(save)) return null;
  }

  config.openrouterApiKey = key;
  saveConfig(config);
  if (ok) console.log(c.green("ok") + c.dim(detail ? `  (${detail})` : ""));
  console.log(c.green("✓ Saved. You're connected.") + c.dim("  Try: poly recommend \"add a dark-mode toggle\""));
  return key;
}

/** Ensure a key exists; trigger onboarding if not. Returns the key or null if aborted. */
export async function ensureApiKey(config: PolymathConfig): Promise<string | null> {
  const existing = resolveApiKey(config);
  if (existing) return existing;
  console.log(c.yellow("No OpenRouter API key found — let's connect one."));
  return runLogin();
}
