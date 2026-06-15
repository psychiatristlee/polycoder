// Wires the `poly subagent …` command group into commander:
//   serve   — turn THIS (GPU) machine into a remote LLM worker
//   link    — point this machine at a remote subagent (--url/--token or auto from registry)
//   unlink  — stop routing to the subagent
//   status  — show the current link + any registered nodes on this account
//   test    — authenticated /v1/chat/completions round-trip against the linked subagent
//   rotate  — issue a fresh relay token on a serving node
import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig } from "../config/store.js";
import { c } from "../util/format.js";
import { runServe } from "./serve.js";
import { runLink, runUnlink, probe } from "./link.js";
import * as registry from "./registry.js";

/** One authenticated chat round-trip to confirm the linked subagent actually infers. */
async function runTest(prompt: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.local.enabled || !cfg.local.baseUrl) {
    console.log(c.yellow("No subagent linked. Run `poly subagent link` first."));
    return;
  }
  const base = cfg.local.baseUrl.replace(/\/+$/, "");
  const token = cfg.local.authToken || "";
  process.stdout.write(c.dim(`Probing ${base}… `));
  const p = await probe(base, token);
  if (!p.ok) {
    console.log(c.red(`✗ ${p.error}`));
    return;
  }
  const model = p.models[0];
  console.log(c.green("ok") + c.dim(`  · model ${model}`));
  process.stdout.write(c.dim("Round-trip… "));
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 128,
        stream: false,
      }),
    });
    if (!res.ok) {
      console.log(c.red(`✗ HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`));
      return;
    }
    const json = (await res.json()) as any;
    const text = json?.choices?.[0]?.message?.content ?? "";
    const ms = Date.now() - t0;
    console.log(c.green(`ok`) + c.dim(`  (${ms}ms)`));
    console.log("\n" + c.bold("Subagent replied:"));
    console.log("  " + String(text).trim().split("\n").join("\n  "));
    console.log(c.dim(`\n✓ Subagent is working. Route runs with: `) + c.cyan(`poly run --model local/${model} "<task>"`));
  } catch (e: any) {
    console.log(c.red(`✗ ${e?.message || e}`));
  }
}

async function runStatus(): Promise<void> {
  const cfg = loadConfig();
  console.log(c.bold("Subagent status\n"));
  console.log(c.dim("  account : ") + registry.accountId());
  if (cfg.local.enabled && cfg.local.baseUrl) {
    console.log(c.dim("  linked  : ") + c.green(cfg.local.baseUrl) + (cfg.local.authToken ? c.dim(" (token set)") : c.yellow(" (no token)")));
  } else {
    console.log(c.dim("  linked  : ") + c.yellow("none"));
  }
  const nodes = await registry.listNodes();
  if (nodes.length) {
    console.log(c.bold("\n  Online nodes on this account:"));
    for (const n of nodes) {
      const age = Math.max(0, Math.round((Date.now() - (n.lastHeartbeat || 0)) / 1000));
      console.log(
        "    " + c.bold(n.id) + c.dim(`  ${n.hardware?.gpu || "?"} · ${n.model} · ${n.transport} · ${age}s ago`)
      );
      console.log(c.dim("      " + n.endpoint));
    }
  } else {
    console.log(c.dim("\n  No online nodes registered (registry off, or none serving)."));
  }
}

export function registerSubagentCommands(program: Command): void {
  const sa = program
    .command("subagent")
    .description("Remote GPU worker: serve a local LLM on one machine, use it from another");

  sa.command("serve")
    .description("Turn THIS (GPU) machine into a remote LLM worker for your account")
    .option("-p, --port <n>", "proxy port", "8765")
    .option("--model <id>", "force a specific Ollama model (else heaviest that fits)")
    .option("--lan", "expose on the LAN only (no Cloudflare tunnel)", false)
    .option("--no-tunnel", "skip the Cloudflare tunnel (LAN fallback)")
    .option("-y, --yes", "auto-install Ollama if missing", false)
    .option("--install", "also install autostart (LaunchAgent / Scheduled Task)", false)
    .option("--rotate-token", "issue a fresh relay token", false)
    .action(async (opts) => {
      await runServe({
        port: parseInt(opts.port, 10) || 8765,
        model: opts.model,
        lan: opts.lan,
        tunnel: opts.tunnel, // commander sets false when --no-tunnel
        yes: opts.yes,
        install: opts.install,
        rotateToken: opts.rotateToken,
      });
    });

  sa.command("link")
    .description("Point THIS machine at a remote subagent (paste --url/--token, or auto from registry)")
    .option("--url <url>", "subagent endpoint (e.g. https://x.trycloudflare.com/v1)")
    .option("--token <token>", "relay token printed by `subagent serve`")
    .option("--node <id>", "pick a specific registered node by id")
    .action(async (opts) => {
      await runLink({ url: opts.url, token: opts.token, node: opts.node });
    });

  sa.command("unlink")
    .description("Stop routing to the subagent (disables local/* models)")
    .action(() => runUnlink());

  sa.command("status")
    .description("Show the current link + online nodes on this account")
    .action(async () => {
      await runStatus();
    });

  sa.command("test")
    .description("Authenticated round-trip against the linked subagent")
    .argument("[prompt...]", "test prompt", )
    .action(async (parts: string[]) => {
      const prompt = parts && parts.length ? parts.join(" ") : "Reply with exactly: subagent OK";
      await runTest(prompt);
    });

  sa.command("rotate")
    .description("Issue a fresh relay token (restart serve / reload autostart to apply)")
    .action(() => {
      const cfg = loadConfig();
      const token = randomBytes(32).toString("hex");
      cfg.local.authToken = token;
      saveConfig(cfg);
      console.log(c.green("✓ New relay token issued."));
      console.log(c.dim("  token : ") + token);
      console.log(c.yellow("\n  Restart the serving node to apply:"));
      console.log(c.dim("    • foreground:  ") + c.cyan("poly subagent serve"));
      console.log(c.dim("    • autostart (macOS):  ") + c.cyan("launchctl kickstart -k gui/$UID/com.polyrun.subagent"));
      console.log(c.dim("    • autostart (Windows): ") + c.cyan("schtasks /end /tn PolyrunSubagent & schtasks /run /tn PolyrunSubagent"));
      console.log(c.dim("  Then re-link the laptop: ") + c.cyan("poly subagent link --token " + token));
    });
}
