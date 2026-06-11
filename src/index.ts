import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { render } from "ink";
import { loadConfig, saveConfig, resolveApiKey, type PolymathConfig } from "./config/store.js";
import { OpenRouterClient } from "./providers/openrouter.js";
import { getModels } from "./models/registry.js";
import type { ModelInfo } from "./providers/types.js";
import { runLogin, ensureApiKey } from "./auth/onboarding.js";
import { heuristicPlan, planRequest } from "./planner/planner.js";
import { buildRecommendation, renderRecommendation } from "./recommend/recommend.js";
import { renderUsageReport } from "./usage/report.js";
import { renderAnalysis } from "./usage/analyze.js";
import { syncUsage } from "./usage/firestoreSync.js";
import { syncDataConnect } from "./usage/dataconnect.js";
import { recordCommandRun, sessionUsageTotals } from "./usage/db.js";
import { logCompletion } from "./usage/logger.js";
import { route } from "./router/router.js";
import type { RoutingObjective, RoutingPolicy } from "./router/policy.js";
import { blendedPrice } from "./router/policy.js";
import { table, usd, perMTok, tierColor, c } from "./util/format.js";
import App from "./tui/App.tsx";

const program = new Command();

program
  .name("poly")
  .description("Polymath — cost-optimized, multi-model TUI coding agent")
  .version("0.2.0");

function client(config: PolymathConfig): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: resolveApiKey(config),
    referer: config.referer,
    title: config.title,
  });
}

function buildPolicy(config: PolymathConfig, opts: { objective?: string; maxCost?: string }): RoutingPolicy {
  const objective = (opts.objective as RoutingObjective) || config.defaultObjective;
  const maxCost = opts.maxCost != null ? parseFloat(opts.maxCost) : config.maxCostPerCallUsd;
  return {
    objective,
    maxCostPerCallUsd: Number.isFinite(maxCost as number) ? (maxCost as number) : undefined,
    pinned: config.pinned,
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
  const models = await getModels(client(config), { refresh });
  if (!models.length) {
    console.error(c.red("Could not load the model catalog. Check your connection."));
    process.exit(1);
  }
  return models;
}

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
  .option("-C, --cwd <dir>", "working directory", process.cwd())
  .action(async (goalParts: string[], opts) => {
    const startedAt = Date.now();
    const config = loadConfig();
    const key = await ensureApiKey(config);
    if (!key) {
      console.error(c.red("No API key — cannot run. Try `poly login`."));
      process.exit(1);
    }
    const reloaded = loadConfig();
    const models = await loadCatalog(reloaded);
    const policy = buildPolicy(reloaded, opts);
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
        objectiveLabel: policy.objective,
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

// ---- sync ------------------------------------------------------------------
program
  .command("sync")
  .description("Push the local analytics ledger to Firebase (Data Connect SQL and/or Firestore)")
  .action(async () => {
    const config = loadConfig();
    let pushed = false;
    if (config.dataconnect.enabled) {
      pushed = true;
      try {
        const res = await syncDataConnect(config);
        console.log(res.sessions + res.steps + res.commands + res.calls > 0 ? c.green(res.message) : c.dim(res.message));
      } catch (e: any) {
        console.error(c.red(`Data Connect sync failed: ${e?.message ?? e}`));
      }
    }
    if (config.firestore.enabled) {
      pushed = true;
      const res = await syncUsage(config);
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
  .description("Set a setting: objective <cheapest|value|quality> | maxcost <usd> | referer <url> | title <text>")
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

program.parseAsync().catch((err) => {
  console.error(c.red(err?.message ?? String(err)));
  process.exit(1);
});
