import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { render } from "ink";
import { loadConfig, saveConfig, resolveApiKey, type PolymathConfig } from "./config/store.js";
import { OpenRouterClient } from "./providers/openrouter.js";
import { getModels } from "./models/registry.js";
import { getLocalModels } from "./models/local.js";
import type { ModelInfo } from "./providers/types.js";
import { runLogin, ensureApiKey } from "./auth/onboarding.js";
import { heuristicPlan, planRequest } from "./planner/planner.js";
import { buildRecommendation, renderRecommendation } from "./recommend/recommend.js";
import { renderUsageReport } from "./usage/report.js";
import { renderAnalysis } from "./usage/analyze.js";
import { syncUsage } from "./usage/firestoreSync.js";
import { syncDataConnect } from "./usage/dataconnect.js";
import { recordCommandRun, sessionUsageTotals, listInsights } from "./usage/db.js";
import { insightBoostMap, distillInsights } from "./usage/insights.js";
import { listSkills, readSkillFile, deleteSkill, skillsDir } from "./skills/store.js";
import { search as searchLocal, statsByHost, docCount, clearIndex } from "./search/engine.js";
import { crawl as crawlSite } from "./search/crawl.js";
import { serveSearch, installLaunchAgent } from "./search/server.js";
import { logCompletion } from "./usage/logger.js";
import { route } from "./router/router.js";
import { ALL_TASK_TYPES } from "./planner/tasks.js";
import type { RoutingObjective, RoutingPolicy } from "./router/policy.js";
import { blendedPrice } from "./router/policy.js";
import { table, usd, perMTok, tierColor, c } from "./util/format.js";
import { runSetup, runUpdate } from "./setup/commands.js";
import App from "./tui/App.tsx";

export const VERSION = "0.5.0";
const program = new Command();

program
  .name("poly")
  .description("Polymath — cost-optimized, multi-model TUI coding agent")
  .version(VERSION);

function client(config: PolymathConfig): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: resolveApiKey(config),
    referer: config.referer,
    title: config.title,
    localBaseUrl: config.local.enabled ? config.local.baseUrl : undefined,
  });
}

function buildPolicy(
  config: PolymathConfig,
  opts: { objective?: string; maxCost?: string; free?: boolean; explore?: string }
): RoutingPolicy {
  const objective = (opts.objective as RoutingObjective) || config.defaultObjective;
  const maxCost = opts.maxCost != null ? parseFloat(opts.maxCost) : config.maxCostPerCallUsd;
  // Learned routing: re-distill insights from ALL accumulated runs first (closes the
  // learn loop so exploration results feed back), then prefer proven-efficient routes.
  let empirical: Record<string, number> | undefined;
  try {
    distillInsights();
    empirical = insightBoostMap(listInsights());
    if (!Object.keys(empirical).length) empirical = undefined;
  } catch {
    empirical = undefined;
  }
  const explore = opts.explore != null ? parseFloat(opts.explore) : config.exploreRate;
  return {
    objective,
    maxCostPerCallUsd: Number.isFinite(maxCost as number) ? (maxCost as number) : undefined,
    pinned: config.pinned,
    empirical,
    excludeFree: opts.free === false,
    explore: Number.isFinite(explore) ? Math.min(Math.max(explore, 0), 1) : 0,
  };
}

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Record one CLI command invocation in the analytics ledger (best-effort). */
function trackCommand(opts: {
  command: string;
  startedAt: number;
  sessionId?: string;
  args?: string;
  objective?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}): void {
  try {
    recordCommandRun({
      sessionId: opts.sessionId,
      ts: opts.startedAt,
      date: localDate(new Date(opts.startedAt)),
      command: opts.command,
      args: opts.args?.slice(0, 300),
      objective: opts.objective,
      promptTokens: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
      costUsd: opts.costUsd ?? 0,
      durationMs: Date.now() - opts.startedAt,
    });
  } catch {
    /* analytics must never break the CLI */
  }
}

async function loadCatalog(config: PolymathConfig, refresh = false): Promise<ModelInfo[]> {
  const cl = client(config);
  const hasKey = !!resolveApiKey(config);
  let models: ModelInfo[] = [];
  try {
    models = await getModels(cl, { refresh });
  } catch (e) {
    if (!config.local.enabled) throw e; // local-only setups tolerate OpenRouter being unreachable
  }
  if (config.local.enabled) {
    const local = await getLocalModels(cl);
    if (!local.length) {
      console.error(c.yellow(`Local server (${config.local.baseUrl}) returned no models — is it running?`));
    }
    // Keyless mode: without an OpenRouter key only local models are actually callable.
    models = hasKey ? [...local, ...models] : local;
  }
  if (!models.length) {
    console.error(c.red("No models available. Check your connection, or `poly config local on` with a running Ollama/LM Studio."));
    process.exit(1);
  }
  return models;
}

// ---- setup ------------------------------------------------------------------
program
  .command("setup")
  .description("First-run setup: optionally install a local LLM (Ollama) and connect models")
  .option("--local", "install a local LLM (Ollama) — skips the prompt")
  .option("--no-local", "skip the local LLM — skips the prompt")
  .option("--auto", "measure this machine and auto-install the strongest local model that fits", false)
  .option("--recommend", "just print detected specs + the best-fitting local model (no changes)", false)
  .option("-m, --model <id>", "local model to pull (e.g. qwen2.5-coder:7b)")
  .option("-y, --yes", "accept defaults / auto-install without prompts", false)
  .action(async (opts) => {
    // Tri-state from argv so "neither flag" → interactive prompt.
    const argv = process.argv;
    const local = argv.includes("--local") ? true : argv.includes("--no-local") ? false : undefined;
    await runSetup({ local, model: opts.model, yes: !!opts.yes, auto: !!opts.auto, recommend: !!opts.recommend });
  });

// ---- update -----------------------------------------------------------------
program
  .command("update")
  .description("Update Polymath, the Ollama runtime, and local models")
  .option("--check", "report available updates without installing", false)
  .option("--self", "only the Polymath CLI", false)
  .option("--ollama", "only the Ollama runtime", false)
  .option("--models", "only the local models", false)
  .action(async (opts) => {
    await runUpdate(VERSION, { check: !!opts.check, self: !!opts.self, ollama: !!opts.ollama, models: !!opts.models });
  });

// ---- login -----------------------------------------------------------------
program
  .command("login")
  .description("Connect Polymath to OpenRouter (set/replace your API key)")
  .action(async () => {
    await runLogin();
  });

// ---- run (default) ---------------------------------------------------------
program
  .command("run", { isDefault: true })
  .description("Launch the interactive agent (TUI)")
  .argument("[goal...]", "what to do (optional; prompts if omitted)")
  .option("-o, --objective <name>", "routing objective: cheapest | value | quality")
  .option("--max-cost <usd>", "exclude models whose projected per-call cost exceeds this")
  .option("-w, --write", "allow the agent to write files (confined to --cwd)", false)
  .option("-x, --commands", "DANGER: let the model run arbitrary shell commands in --cwd", false)
  .option("-W, --web", "allow web_search + web_fetch (research official docs/references)", false)
  .option("-C, --cwd <dir>", "working directory", process.cwd())
  .option("--no-verify", "skip the verify-and-escalate loop (single pass)")
  .option("--no-free", "exclude $0 OpenRouter free-tier models (rate-limited); prefer cheap paid")
  .option("--model <id>", "pin EVERY task to one model id (for benchmarking a single model/combo)")
  .option("--explore <rate>", "epsilon-greedy exploration rate 0..1 (default from config; 0 = always exploit)")
  .option("--no-skills", "don't reuse or learn skill playbooks for this run")
  .option("--no-quality", "skip the end-of-run LLM quality score")
  .option("--max-attempts <n>", "max code→verify→escalate attempts until goals met", "3")
  .action(async (goalParts: string[], opts) => {
    const startedAt = Date.now();
    const config = loadConfig();
    // Local-only mode needs no API key at all.
    if (!config.local.enabled || resolveApiKey(config)) {
      const key = await ensureApiKey(config);
      if (!key && !config.local.enabled) {
        console.error(c.red("No API key — cannot run. Try `poly login`, or `poly config local on` for a local LLM."));
        process.exit(1);
      }
    }
    const reloaded = loadConfig();
    const models = await loadCatalog(reloaded);
    const policy = buildPolicy(reloaded, opts);
    // --model: pin every task type to one model id (single-model benchmark runs).
    if (opts.model) {
      policy.pinned = Object.fromEntries(ALL_TASK_TYPES.map((t) => [t, opts.model as string]));
    }
    const goal = goalParts?.join(" ").trim() || undefined;
    const sessionId = randomUUID();

    const instance = render(
      createElement(App, {
        client: client(reloaded),
        models,
        policy,
        sessionId,
        cwd: opts.cwd,
        allowWrite: !!opts.write,
        allowCommands: !!opts.commands,
        allowWeb: !!opts.web,
        objectiveLabel: policy.objective,
        verify: opts.verify !== false,
        maxAttempts: Math.max(1, parseInt(opts.maxAttempts, 10) || 3),
        skills: reloaded.skills.enabled && opts.skills !== false,
        quality: opts.quality !== false,
        initialGoal: goal,
      })
    );
    await instance.waitUntilExit();
    // Attribute this command's real token usage from the per-call ledger.
    const totals = sessionUsageTotals(sessionId);
    trackCommand({
      command: "run",
      startedAt,
      sessionId,
      args: goal,
      objective: policy.objective,
      ...totals,
    });
  });

// ---- recommend -------------------------------------------------------------
program
  .command("recommend")
  .description("Recommend the best / best-value model combos for a task BEFORE running")
  .argument("<goal...>", "task description")
  .option("--smart", "use an LLM to produce a tailored plan (costs a few cents)", false)
  .option("-o, --objective <name>", "highlight a specific objective")
  .action(async (goalParts: string[], opts) => {
    const startedAt = Date.now();
    const config = loadConfig();
    const models = await loadCatalog(config);
    const goal = goalParts.join(" ");
    const sessionId = randomUUID();
    let plan = heuristicPlan(goal);
    if (opts.smart) {
      const key = resolveApiKey(config);
      if (!key) {
        console.error(c.yellow("--smart needs an API key; falling back to heuristic plan. Run `poly login`."));
      } else {
        const planRoute = route("plan", models, buildPolicy(config, {}));
        if (planRoute) {
          try {
            plan = await planRequest(goal, client(config), planRoute.model, (result) => {
              logCompletion(result, "plan", sessionId, "recommend");
            });
          } catch (e: any) {
            console.error(c.yellow(`Smart plan failed (${e?.message}); using heuristic.`));
          }
        }
      }
    }
    console.log(renderRecommendation(buildRecommendation(plan, models)));
    const totals = sessionUsageTotals(sessionId);
    trackCommand({ command: "recommend", startedAt, sessionId, args: goal, objective: config.defaultObjective, ...totals });
  });

// ---- models ----------------------------------------------------------------
program
  .command("models")
  .description("Browse the model catalog with pricing and tiers")
  .option("-t, --tier <tier>", "filter by tier: cheap | standard | frontier")
  .option("--tools", "only models that support tool/function calling", false)
  .option("-s, --search <text>", "filter by id/name substring")
  .option("--refresh", "force-refresh the catalog from OpenRouter", false)
  .option("-n, --limit <n>", "max rows", "40")
  .action(async (opts) => {
    const config = loadConfig();
    let models = await loadCatalog(config, !!opts.refresh);
    if (opts.tier) models = models.filter((m) => m.tier === opts.tier);
    if (opts.tools) models = models.filter((m) => m.capabilities.tools);
    if (opts.search) {
      const q = String(opts.search).toLowerCase();
      models = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    }
    models.sort((a, b) => blendedPrice(a) - blendedPrice(b));
    const limit = parseInt(opts.limit, 10) || 40;
    const rows = models.slice(0, limit).map((m) => [
      m.id,
      tierColor(m.tier),
      perMTok(m.pricing.promptUsdPerMTok),
      perMTok(m.pricing.completionUsdPerMTok),
      m.capabilities.tools ? "✓" : "",
      String(m.contextLength),
    ]);
    console.log(table(["Model", "Tier", "In", "Out", "Tools", "Ctx"], rows));
    console.log(c.dim(`\n${models.length} models match · showing ${rows.length}`));
  });

// ---- usage -----------------------------------------------------------------
program
  .command("usage")
  .description("Show recorded usage & cost by date + model")
  .option("--since <date>", "YYYY-MM-DD inclusive")
  .option("--until <date>", "YYYY-MM-DD inclusive")
  .option("--today", "only today", false)
  .option("--sync", "also push unsynced rows to Firestore", false)
  .action(async (opts) => {
    const config = loadConfig();
    let since = opts.since;
    let until = opts.until;
    if (opts.today) {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
      since = iso;
      until = iso;
    }
    console.log(renderUsageReport({ since, until }));
    if (opts.sync) {
      const res = await syncUsage(config);
      console.log(res.synced > 0 ? c.green(res.message) : c.dim(res.message));
    }
  });

// ---- analyze ----------------------------------------------------------------
program
  .command("analyze")
  .description("Which approach reaches the goal with the FEWEST tokens — per model, task, objective, command")
  .option("--since <date>", "YYYY-MM-DD inclusive")
  .option("--until <date>", "YYYY-MM-DD inclusive")
  .action(async (opts) => {
    console.log(renderAnalysis({ since: opts.since, until: opts.until }));
  });

// ---- skills -----------------------------------------------------------------
const skillsCmd = program
  .command("skills")
  .description("Reusable task playbooks Polymath distills from verified successes and replays on similar goals");
skillsCmd
  .command("list", { isDefault: true })
  .description("List learned skills")
  .action(() => {
    const skills = listSkills();
    if (!skills.length) {
      console.log(
        c.dim(
          `No skills yet. Polymath learns one from each VERIFIED successful run (write mode + verify on),\n` +
            `then replays it on similar goals. Disable with \`poly config skills off\` or \`--no-skills\`.\n` +
            `Stored in ${skillsDir()}`
        )
      );
      return;
    }
    const rows = skills.map((s) => [
      c.green(s.name),
      s.goalType,
      String(s.uses),
      String(s.sources),
      usd(s.avgCostUsd),
      s.description.length > 60 ? s.description.slice(0, 59) + "…" : s.description,
    ]);
    console.log(table(["Skill", "Goal", "Used", "Src", "Avg $", "Description"], rows));
    console.log(c.dim(`\n${skills.length} skill(s) · ${skillsDir()}`));
  });
skillsCmd
  .command("show")
  .description("Print a skill's full playbook")
  .argument("<name>", "skill name")
  .action((name: string) => {
    const raw = readSkillFile(name);
    if (!raw) {
      console.error(c.red(`No skill named "${name}". Run \`poly skills list\`.`));
      process.exitCode = 1;
      return;
    }
    console.log(raw);
  });
skillsCmd
  .command("rm")
  .description("Delete a skill")
  .argument("<name>", "skill name")
  .action((name: string) => {
    console.log(deleteSkill(name) ? c.green(`Removed skill "${name}".`) : c.yellow(`No skill named "${name}".`));
  });

// ---- sync ------------------------------------------------------------------
program
  .command("sync")
  .description("Push DISTILLED efficiency insights to Firebase (raw logs stay local unless --raw)")
  .option("--raw", "also push the full raw ledger (sessions/steps/calls/commands)", false)
  .action(async (opts) => {
    const config = loadConfig();
    let pushed = false;
    if (config.dataconnect.enabled) {
      pushed = true;
      try {
        const res = await syncDataConnect(config, { raw: !!opts.raw });
        const n = res.insights + res.sessions + res.steps + res.commands + res.calls;
        console.log(n > 0 ? c.green(res.message) : c.dim(res.message));
      } catch (e: any) {
        console.error(c.red(`Data Connect sync failed: ${e?.message ?? e}`));
      }
    }
    if (config.firestore.enabled) {
      pushed = true;
      const res = await syncUsage(config, { raw: !!opts.raw });
      console.log(res.synced > 0 ? c.green(res.message) : c.dim(res.message));
    }
    if (!pushed) {
      console.log(
        c.yellow(
          "No sync target enabled. Use `poly config dataconnect on` (SQL) or `poly config firestore on`."
        )
      );
    }
  });

// ---- config ----------------------------------------------------------------
const cfg = program.command("config").description("View or change Polymath settings");
cfg
  .command("show")
  .description("Print the current config (key is masked)")
  .action(() => {
    const config = loadConfig();
    const key = resolveApiKey(config);
    console.log(
      JSON.stringify(
        { ...config, openrouterApiKey: key ? key.slice(0, 8) + "…" + key.slice(-4) : null },
        null,
        2
      )
    );
  });
cfg
  .command("set")
  .description("Set a setting: objective <cheapest|value|quality> | maxcost <usd> | explore <0..1> | referer <url> | title <text>")
  .argument("<key>")
  .argument("<value>")
  .action((key: string, value: string) => {
    const config = loadConfig();
    switch (key) {
      case "objective":
        config.defaultObjective = value as RoutingObjective;
        break;
      case "maxcost":
        config.maxCostPerCallUsd = parseFloat(value);
        break;
      case "explore":
        config.exploreRate = Math.min(Math.max(parseFloat(value) || 0, 0), 1);
        break;
      case "referer":
        config.referer = value;
        break;
      case "title":
        config.title = value;
        break;
      default:
        console.error(c.red(`Unknown setting: ${key}`));
        return;
    }
    saveConfig(config);
    console.log(c.green(`Set ${key} = ${value}`));
  });
cfg
  .command("firestore")
  .description("Enable/disable Firestore sync: on | off")
  .argument("<state>")
  .action((state: string) => {
    const config = loadConfig();
    config.firestore.enabled = /^on|true|1$/i.test(state);
    saveConfig(config);
    console.log(c.green(`Firestore sync ${config.firestore.enabled ? "enabled" : "disabled"}.`));
  });
cfg
  .command("local")
  .description("Enable/disable a local LLM server (Ollama/LM Studio): on | off [--base <url>]")
  .argument("<state>")
  .option("--base <url>", "OpenAI-compatible base URL (default http://localhost:11434/v1)")
  .action((state: string, opts) => {
    const config = loadConfig();
    config.local.enabled = /^on|true|1$/i.test(state);
    if (opts.base) config.local.baseUrl = String(opts.base).replace(/\/$/, "");
    saveConfig(config);
    console.log(
      c.green(
        `Local LLM ${config.local.enabled ? "enabled" : "disabled"} (${config.local.baseUrl}). ` +
          `Models appear as local/<name> with $0 cost.`
      )
    );
  });
cfg
  .command("skills")
  .description("Enable/disable learning + replaying reusable skill playbooks: on | off")
  .argument("<state>")
  .action((state: string) => {
    const config = loadConfig();
    config.skills.enabled = /^on|true|1$/i.test(state);
    saveConfig(config);
    console.log(
      c.green(
        `Skill learning ${config.skills.enabled ? "enabled" : "disabled"}. ` +
          `Skills live in ${skillsDir()}.`
      )
    );
  });
cfg
  .command("dataconnect")
  .description("Enable/disable Firebase Data Connect (SQL) sync: on | off [--location <loc>] [--service <id>]")
  .argument("<state>")
  .option("--location <loc>", "Data Connect location (default us-east4)")
  .option("--service <id>", "Data Connect service id (default polymath)")
  .action((state: string, opts) => {
    const config = loadConfig();
    config.dataconnect.enabled = /^on|true|1$/i.test(state);
    if (opts.location) config.dataconnect.location = opts.location;
    if (opts.service) config.dataconnect.serviceId = opts.service;
    saveConfig(config);
    console.log(
      c.green(
        `Data Connect sync ${config.dataconnect.enabled ? "enabled" : "disabled"} ` +
          `(service ${config.dataconnect.serviceId} @ ${config.dataconnect.location}).`
      )
    );
  });

// ---- search (local self-owned engine) --------------------------------------
const searchCmd = program
  .command("search")
  .description("Self-owned search engine: crawl your own corpus, BM25 search, web GUI");
searchCmd
  .command("query", { isDefault: true })
  .description("Search the local index")
  .argument("<query...>", "search terms")
  .action((parts: string[]) => {
    const q = parts.join(" ");
    const hits = searchLocal(q, 12);
    if (!hits.length) {
      console.log(c.dim(`No results for "${q}". Index a site first: poly search index <url>`));
      return;
    }
    for (const h of hits) {
      console.log(c.green(h.title || h.url));
      console.log("  " + c.dim(h.url));
      console.log("  " + h.snippet + "\n");
    }
    console.log(c.dim(`${hits.length} result(s) · ${docCount()} docs indexed`));
  });
searchCmd
  .command("index")
  .description("Crawl + index a site into the local engine")
  .argument("<url...>", "seed URL(s)")
  .option("--max <n>", "max pages", "25")
  .option("--depth <d>", "crawl depth", "1")
  .option("--all-domains", "follow off-site links too", false)
  .action(async (urls: string[], opts) => {
    console.log(c.cyan(`Crawling ${urls.join(", ")}…`));
    const r = await crawlSite(urls, {
      maxPages: parseInt(opts.max, 10) || 25,
      depth: parseInt(opts.depth, 10) || 1,
      sameDomain: !opts.allDomains,
      onProgress: (p) => process.stdout.write(`\r  indexed ${p.indexed}…`),
    });
    console.log(c.green(`\n✓ Indexed ${r.indexed} pages (visited ${r.visited}). Total docs: ${docCount()}`));
  });
searchCmd
  .command("serve")
  .description("Run the search web GUI (always-on local server)")
  .option("-p, --port <n>", "port", "8787")
  .option("--install", "auto-start at login (macOS LaunchAgent)", false)
  .action(async (opts) => {
    const port = parseInt(opts.port, 10) || 8787;
    if (opts.install) {
      const r = installLaunchAgent(port);
      console.log(r.ok ? c.green(r.message) : c.yellow(r.message));
      return;
    }
    await serveSearch({ port });
  });
searchCmd
  .command("stats")
  .description("Index stats by host")
  .action(() => {
    console.log(c.bold(`${docCount()} docs indexed`));
    for (const h of statsByHost()) console.log(`  ${h.host}  ${c.dim(String(h.docs))}`);
  });
searchCmd
  .command("clear")
  .description("Clear the index (optionally one host)")
  .argument("[host]")
  .action((host?: string) => {
    console.log(c.green(`Removed ${clearIndex(host)} docs.`));
  });

program.parseAsync().catch((err) => {
  console.error(c.red(err?.message ?? String(err)));
  process.exit(1);
});
