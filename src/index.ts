import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
import { route, routeOrBest } from "./router/router.js";
import { runAgent, type AgentDeps, type AgentEvent } from "./agent/loop.js";
import { runStep, runAuto, type SuperviseEvent } from "./supervise/loop.js";
import { getAdapter, type AgentKind } from "./supervise/agents.js";
import { ALL_TASK_TYPES } from "./planner/tasks.js";
import type { RoutingObjective, RoutingPolicy } from "./router/policy.js";
import { blendedPrice } from "./router/policy.js";
import { table, usd, perMTok, tierColor, c } from "./util/format.js";
import { runSetup, runUpdate } from "./setup/commands.js";
import { LOCAL_MODEL_CATALOG, installedModels, totalRamGb, freeDiskGb, ensureServer, ollamaInstalled, ollamaServerUp, ollamaInstallPlan, run as runCmd, ollamaCmd, fixWindowsModelsPath, migrateOllamaModelsToAscii, restartOllama } from "./setup/localllm.js";
import { execSync as execSyncCmd } from "node:child_process";
import { registerSubagentCommands } from "./subagent/commands.js";
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
    // Relay token for an authenticated remote subagent; harmless for a bare local Ollama.
    localApiKey: config.local.enabled ? config.local.authToken : undefined,
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
  .option("--json", "machine-readable output (all matches, for the desktop app)", false)
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
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          hasKey: !!resolveApiKey(config),
          count: models.length,
          models: models.map((m) => ({
            id: m.id,
            name: m.name,
            provider: m.provider,
            tier: m.tier,
            promptUsd: m.pricing.promptUsdPerMTok,
            completionUsd: m.pricing.completionUsdPerMTok,
            tools: m.capabilities.tools,
            vision: m.capabilities.vision,
            ctx: m.contextLength,
            local: m.id.startsWith("local/"),
          })),
        }) + "\n"
      );
      return;
    }
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
  .description(
    "Set a setting: objective <cheapest|value|quality> | maxcost <usd> | explore <0..1> | " +
      "searchprovider <duckduckgo|brave|polysearch> | bravekey <key> | polysearchurl <url> | polysearchkey <key> | referer <url> | title <text>"
  )
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
      case "apikey":
        config.openrouterApiKey = value;
        break;
      case "explore":
        config.exploreRate = Math.min(Math.max(parseFloat(value) || 0, 0), 1);
        break;
      case "searchprovider":
        config.search.provider = value;
        break;
      case "bravekey":
        config.search.braveApiKey = value;
        break;
      case "polysearchurl":
        config.search.polysearchUrl = value;
        break;
      case "polysearchkey":
        config.search.polysearchKey = value;
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

// ---- vision (describe images / video keyframes with a vision model) --------
const IMG_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", heic: "image/heic",
};
function imageToDataUrl(file: string): string {
  const ext = (file.split(".").pop() || "").toLowerCase();
  const mime = IMG_MIME[ext] || "image/png";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}
/** Pick a reliable vision model: well-known multimodal families first, cheapest among them. */
function pickVisionModel(models: ModelInfo[]): ModelInfo | undefined {
  const vision = models.filter((m) => m.capabilities.vision && !m.id.startsWith("local/"));
  const GOOD = /(gpt-4o|gpt-4\.1|o[134]|claude.*(sonnet|opus|haiku)|gemini.*(flash|pro)|qwen.*vl|pixtral|llama.*(vision|maverick|scout)|grok.*vision)/i;
  const known = vision.filter((m) => GOOD.test(m.id)).sort((a, b) => blendedPrice(a) - blendedPrice(b));
  if (known.length) return known[0];
  // Fall back to any vision model, cheapest non-free first (free tiers are flaky/rate-limited).
  const paid = vision.filter((m) => blendedPrice(m) > 0).sort((a, b) => blendedPrice(a) - blendedPrice(b));
  return paid[0] || vision[0];
}
const vision = program.command("vision").description("Multimodal helpers (image understanding)");
vision
  .command("describe")
  .description("Describe image(s) with a vision model — emits text the agent can act on")
  .argument("<images...>", "image file path(s)")
  .option("-q, --question <text>", "what to extract (default: a detailed description)")
  .option("-m, --model <id>", "vision model (default: cheapest vision-capable in catalog)")
  .option("--json", "emit JSON {file,description}[] instead of text", false)
  .option("-o, --objective <obj>", "cheapest | value | quality")
  .action(async (images: string[], opts) => {
    const config = loadConfig();
    const cl = client(config);
    const models = await loadCatalog(config);
    let vm = opts.model ? models.find((m) => m.id === opts.model) : undefined;
    if (opts.model && !vm) {
      console.error(c.red(`Model not found: ${opts.model}`));
      process.exit(1);
    }
    if (!vm) vm = pickVisionModel(models);
    if (!vm) {
      console.error(c.red("No vision-capable model available. Set an OpenRouter key (poly config set apikey …)."));
      process.exit(1);
    }
    const q = opts.question || "Describe this image in detail: layout, text content, colors, notable objects, and anything an engineer would need to recreate or act on it.";
    const out: { file: string; description: string }[] = [];
    for (const img of images) {
      if (!fs.existsSync(img)) {
        if (!opts.json) console.error(c.yellow(`skip (missing): ${img}`));
        continue;
      }
      try {
        const r = await cl.visionComplete(vm.id, { user: q, images: [imageToDataUrl(img)] }, vm.pricing, 800);
        out.push({ file: img, description: r.content.trim() });
        if (!opts.json) {
          console.log(c.bold("\n" + path.basename(img)) + c.dim(`  (${vm.id})`));
          console.log(r.content.trim());
        }
      } catch (e: any) {
        if (!opts.json) console.error(c.red(`✗ ${path.basename(img)}: ${e?.message || e}`));
        else out.push({ file: img, description: `[error: ${e?.message || e}]` });
      }
    }
    if (opts.json) process.stdout.write(JSON.stringify({ model: vm.id, results: out }) + "\n");
  });

// ---- agent (headless; streams JSON events for the desktop app) --------------
program
  .command("agent")
  .description("Headless agent: run a goal and stream JSON events (one per line). Used by the desktop app/automation.")
  .argument("<goal...>", "what to do")
  .option("-o, --objective <name>", "cheapest | value | quality")
  .option("-w, --write", "allow file writes (confined to --cwd)", false)
  .option("-x, --commands", "allow shell commands in --cwd", false)
  .option("-W, --web", "allow web_search + web_fetch", false)
  .option("-C, --cwd <dir>", "working directory", process.cwd())
  .option("--no-free", "exclude $0 OpenRouter free-tier models (rate-limited)")
  .option("--no-verify", "single pass, no verify/escalate")
  .option("--no-skills", "don't reuse/learn skills")
  .option("--no-quality", "skip the quality score")
  .option("--max-attempts <n>", "max attempts", "3")
  .action(async (goalParts: string[], opts) => {
    const startedAt = Date.now();
    const config = loadConfig();
    const models = await loadCatalog(config);
    const policy = buildPolicy(config, opts);
    const goal = goalParts.join(" ");
    const sessionId = randomUUID();
    // Interactive clarification over stdin: handleAskUser emits a `question` event,
    // the host (desktop app) writes the chosen answer back as a line on our stdin.
    let rl: any = null;
    const waiters: ((s: string) => void)[] = [];
    const buffered: string[] = [];
    const ask = (_q: string, _options: string[]): Promise<string> => {
      if (!rl) {
        // Static import: a runtime require() throws in the ESM bundle (dist/cli.js).
        rl = readline.createInterface({ input: process.stdin });
        rl.on("line", (line: string) => {
          const w = waiters.shift();
          if (w) w(line);
          else buffered.push(line);
        });
      }
      const b = buffered.shift();
      if (b !== undefined) return Promise.resolve(b.trim());
      return new Promise((res) => waiters.push((s) => res(s.trim())));
    };
    const deps: AgentDeps = {
      client: client(config),
      models,
      policy,
      sessionId,
      cwd: opts.cwd,
      allowWrite: !!opts.write,
      allowCommands: !!opts.commands,
      allowWeb: !!opts.web,
      verify: opts.verify !== false,
      maxAttempts: Math.max(1, parseInt(opts.maxAttempts, 10) || 3),
      skills: config.skills.enabled && opts.skills !== false,
      quality: opts.quality !== false,
      ask,
    };
    const emit = (e: AgentEvent) => process.stdout.write(JSON.stringify(e) + "\n");
    try {
      await runAgent(goal, deps, emit);
    } catch (e: any) {
      emit({ type: "error", message: e?.message ?? String(e) });
    }
    const totals = sessionUsageTotals(sessionId);
    trackCommand({ command: "agent", startedAt, sessionId, args: goal, objective: policy.objective, ...totals });
    if (rl) rl.close();
    process.exit(0);
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

// ---- supervise (orchestrate an external coding agent) ----------------------
interface SuperviseState {
  goal: string;
  agentKind: AgentKind;
  cmdTemplate?: string;
  recModelId?: string;
  step: number;
  lastInstruction: string;
  nextInstruction: string;
  history: { step: number; summary: string; progress: number; aligned: boolean; instruction: string }[];
}
const SUPERVISE_STATE_FILE = ".poly-supervise.json";

function loadSuperviseState(dir: string): SuperviseState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SUPERVISE_STATE_FILE), "utf8")) as SuperviseState;
  } catch {
    return null;
  }
}
function saveSuperviseState(dir: string, s: SuperviseState): void {
  try {
    fs.writeFileSync(path.join(dir, SUPERVISE_STATE_FILE), JSON.stringify(s, null, 2));
  } catch {
    /* non-fatal */
  }
}

function renderSuperviseEvent(e: SuperviseEvent): void {
  switch (e.type) {
    case "agent-start":
      console.log(c.bold(`\n▶ Step ${e.step}`) + c.dim(`  →  ${e.agent}`));
      console.log(c.dim("  instruction: ") + e.instruction.replace(/\n/g, " ").slice(0, 200));
      break;
    case "agent-done":
      console.log(
        c.dim("  worker: ") +
          (e.killed ? c.yellow(`killed`) : c.green(`exit ${e.code}`)) +
          c.dim(`  (${(e.ms / 1000).toFixed(1)}s)`)
      );
      break;
    case "diff": {
      const d = e.diff;
      console.log(
        c.dim("  diff: ") + (d.empty ? c.yellow("no changes") : `${d.filesChanged} file(s) ` + c.green(`+${d.insertions}`) + " " + c.red(`-${d.deletions}`))
      );
      if (d.stat) for (const line of d.stat.split("\n").slice(0, 8)) console.log(c.dim("    " + line));
      break;
    }
    case "recommendation": {
      const r = e.rec;
      const bar = "█".repeat(Math.round(r.progress / 10)).padEnd(10, "░");
      console.log(c.bold("  ⟐ supervisor: ") + (r.done ? c.green("DONE") : r.aligned ? c.green("on track") : c.yellow("off track")) + c.dim(`  [${bar}] ${r.progress}%`) + (r.heuristic ? c.dim(" (heuristic)") : ""));
      console.log(c.dim("  summary: ") + r.summary);
      for (const con of r.concerns) console.log(c.yellow("  ⚠ ") + con);
      if (!r.done) console.log(c.cyan("  → next: ") + r.nextInstruction.replace(/\n/g, " ").slice(0, 240));
      break;
    }
  }
}

program
  .command("supervise")
  .description("Supervision mode: drive an external coding agent (Claude Code/Codex), read its diff, recommend the next step")
  .argument("[project]", "project directory", ".")
  .option("-g, --goal <text>", "the high-level goal to accomplish")
  .option("-a, --agent <kind>", "worker agent: claude | codex | cmd (default: auto-detect)")
  .option("--agent-cmd <template>", "command for the `cmd` agent ({prompt} placeholder optional)")
  .option("--auto", "auto-loop: feed each recommendation back to the worker", false)
  .option("-n, --max-runs <n>", "max auto runs", "5")
  .option("--continue", "apply the last recommended next instruction (manual stepping)", false)
  .option("--instruction <text>", "override the instruction for this step")
  .option("-m, --model <id>", "recommendation model (default: routed 'review' model)")
  .option("-o, --objective <obj>", "cheapest | value | quality")
  .option("--no-free", "exclude free-tier models from routing")
  .option("--idle <s>", "kill the worker after N seconds of silence", "180")
  .option("--max <s>", "hard cap per worker run (seconds)", "900")
  .option("--json", "emit newline-delimited JSON events (for the desktop app / scripts)", false)
  .action(async (project: string, opts) => {
    const startedAt = Date.now();
    const emitEvent = opts.json
      ? (ev: SuperviseEvent) => process.stdout.write(JSON.stringify(ev) + "\n")
      : renderSuperviseEvent;
    const emitJson = (obj: any) => {
      if (opts.json) process.stdout.write(JSON.stringify(obj) + "\n");
    };
    const dir = path.resolve(project || ".");
    if (!fs.existsSync(dir)) {
      console.error(c.red(`No such directory: ${dir}`));
      process.exit(1);
    }
    const config = loadConfig();
    const prior = loadSuperviseState(dir);

    // Resolve goal + agent: new session needs --goal; --continue resumes from state.
    const goal = opts.goal || prior?.goal;
    if (!goal) {
      console.error(c.red("A goal is required for a new session: poly supervise -g \"<goal>\" [project]"));
      process.exit(1);
    }
    const agentKind: AgentKind = (opts.agent as AgentKind) || prior?.agentKind || autoDetectAgent();
    const cmdTemplate = opts.agentCmd || prior?.cmdTemplate;
    const adapter = getAdapter(agentKind, cmdTemplate);
    if (!adapter.available) {
      console.error(
        c.red(
          agentKind === "cmd"
            ? "The `cmd` agent needs --agent-cmd \"<command>\"."
            : `Worker "${adapter.bin}" is not on PATH. Install it, or use --agent cmd --agent-cmd "<command>".`
        )
      );
      process.exit(1);
    }

    // Recommendation model: explicit --model, else the routed "review" model.
    const policy = buildPolicy(config, opts);
    const models = await loadCatalog(config);
    let recModel = opts.model ? models.find((m) => m.id === opts.model) : undefined;
    if (opts.model && !recModel) {
      console.error(c.red(`Model not found in catalog: ${opts.model}`));
      process.exit(1);
    }
    if (!recModel) {
      const routed = routeOrBest("review", models, policy);
      if (!routed) {
        console.error(c.red("No model available to power the supervisor. Set a key or link a subagent."));
        process.exit(1);
      }
      recModel = routed.model;
    }

    const cl = client(config);
    let promptTokens = 0,
      completionTokens = 0,
      costUsd = 0;
    const onUsage = (r: any) => {
      promptTokens += r.usage?.promptTokens ?? 0;
      completionTokens += r.usage?.completionTokens ?? 0;
      costUsd += r.costUsd ?? 0;
    };

    emitJson({ type: "session", project: dir, worker: adapter.label, supervisor: recModel.id, goal, mode: opts.auto ? "auto" : "manual" });
    if (!opts.json) {
      console.log(c.bold("\n⟐ poly supervise"));
      console.log(c.dim("  project   : ") + dir);
      console.log(c.dim("  worker    : ") + adapter.label);
      console.log(c.dim("  supervisor: ") + recModel.id);
      console.log(c.dim("  goal      : ") + goal);
    }

    const deps = {
      client: cl,
      recModel,
      onEvent: emitEvent,
      onUsage,
      idleMs: (parseInt(opts.idle, 10) || 180) * 1000,
      maxMs: (parseInt(opts.max, 10) || 900) * 1000,
    };
    const sopts = { cwd: dir, goal, agentKind, cmdTemplate };

    if (opts.auto) {
      // Fresh auto run starts from the goal; --continue resumes from the last recommendation.
      const first = opts.instruction || (opts.continue && prior?.nextInstruction) || goal;
      const maxRuns = Math.max(1, parseInt(opts.maxRuns, 10) || 5);
      if (!opts.json) console.log(c.dim(`  mode      : AUTO (≤${maxRuns} runs)\n`));
      const res = await runAuto(sopts, first, maxRuns, deps);
      const last = res.steps[res.steps.length - 1];
      const state: SuperviseState = {
        goal,
        agentKind,
        cmdTemplate,
        recModelId: recModel.id,
        step: (prior?.step ?? 0) + res.steps.length,
        lastInstruction: last?.instruction ?? first,
        nextInstruction: last?.recommendation.nextInstruction ?? "",
        // Append to prior history (resuming an AUTO session must not discard earlier steps).
        history: [
          ...(prior?.history ?? []),
          ...res.steps.map((s) => ({ step: (prior?.step ?? 0) + s.step, summary: s.recommendation.summary, progress: s.recommendation.progress, aligned: s.recommendation.aligned, instruction: s.instruction })),
        ],
      };
      saveSuperviseState(dir, state);
      emitJson({ type: "result", done: res.done, stoppedReason: res.stoppedReason, runs: res.steps.length, costUsd, nextInstruction: state.nextInstruction });
      if (!opts.json) {
        console.log(
          "\n" + c.bold(res.done ? c.green("✓ Goal reached") : c.yellow(`■ Stopped: ${res.stoppedReason}`)) + c.dim(`  · ${res.steps.length} run(s) · ${usd(costUsd)}`)
        );
        if (!res.done && state.nextInstruction) console.log(c.dim("  resume: ") + c.cyan(`poly supervise --continue "${dir}"`));
      }
    } else {
      // MANUAL: one step. Continue from the last recommendation if state exists, else the
      // goal; --instruction overrides. (The "수정하기" button just re-runs this command.)
      const step = (prior?.step ?? 0) + 1;
      const instruction = opts.instruction || prior?.nextInstruction || goal;
      if (!opts.json) console.log(c.dim(`  mode      : manual (step ${step})\n`));
      const adapterForStep = getAdapter(agentKind, cmdTemplate);
      const s = await runStep(sopts, instruction, step, deps, adapterForStep);
      const state: SuperviseState = {
        goal,
        agentKind,
        cmdTemplate,
        recModelId: recModel.id,
        step,
        lastInstruction: instruction,
        nextInstruction: s.recommendation.nextInstruction,
        history: [...(prior?.history ?? []), { step, summary: s.recommendation.summary, progress: s.recommendation.progress, aligned: s.recommendation.aligned, instruction }],
      };
      saveSuperviseState(dir, state);
      emitJson({ type: "result", done: s.recommendation.done, step, costUsd, nextInstruction: s.recommendation.nextInstruction });
      if (!opts.json) {
        if (s.recommendation.done) {
          console.log("\n" + c.green("✓ Supervisor says the goal is met.") + c.dim(`  · ${usd(costUsd)}`));
        } else {
          console.log("\n" + c.dim("Apply the recommendation: ") + c.cyan(`poly supervise --continue "${dir}"`) + c.dim("   (or --auto to loop)"));
        }
      }
    }

    trackCommand({ command: "supervise", startedAt, args: goal, objective: policy.objective, promptTokens, completionTokens, costUsd });
  });

function autoDetectAgent(): AgentKind {
  if (getAdapter("claude").available) return "claude";
  if (getAdapter("codex").available) return "codex";
  return "claude"; // report a helpful "not on PATH" error downstream
}

// ---- local (manage multiple local models; poly auto-routes per task) -------
const localCmd = program.command("local").description("Manage local LLM models — download several; poly auto-switches per task/cost");
localCmd
  .command("catalog", { isDefault: true })
  .description("Recommended local models + what fits this machine")
  .option("--json", "machine-readable output", false)
  .action(async (opts) => {
    const have = await installedModels();
    const ram = totalRamGb();
    const disk = freeDiskGb();
    const rows = LOCAL_MODEL_CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      sizeGb: m.diskGb,
      paramsB: m.paramsB,
      note: m.note,
      role: m.role,
      installed: have.includes(m.id),
      fits: have.includes(m.id) || (m.minRamGb <= ram && disk >= m.diskGb + 3),
    }));
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ramGb: ram, freeDiskGb: disk, enabled: loadConfig().local.enabled, models: rows }) + "\n");
      return;
    }
    console.log(c.bold(`\nLocal model catalog`) + c.dim(`  (RAM ${ram}GB · free disk ${disk}GB)\n`));
    for (const r of rows) {
      const mark = r.installed ? c.green("✓ 설치됨") : r.fits ? c.dim("· 설치가능") : c.red("✗ 용량부족");
      console.log(`  ${mark}  ${r.label.padEnd(22)} ${c.dim("~" + r.sizeGb + "GB")}  ${c.dim(r.note)}`);
    }
    console.log(c.dim("\n  여러 개 받아두면 poly가 작업에 따라 자동으로 골라 씁니다.  설치: ") + c.cyan("poly local pull <id>"));
  });
localCmd
  .command("list")
  .description("Installed local models")
  .option("--json", "machine-readable output", false)
  .action(async (opts) => {
    const have = await installedModels();
    const cfg = loadConfig();
    if (opts.json) {
      process.stdout.write(JSON.stringify({ enabled: cfg.local.enabled, baseUrl: cfg.local.baseUrl, models: have }) + "\n");
      return;
    }
    console.log(c.bold(`Installed local models (${have.length})`) + c.dim(` · 로컬 라우팅 ${cfg.local.enabled ? "on" : "off"}`));
    for (const m of have) console.log("  " + c.green("local/" + m));
    if (!have.length) console.log(c.dim("  (없음) — poly local pull <id>"));
  });
localCmd
  .command("pull")
  .description("Download a local model and enable local routing")
  .argument("<id>", "model id, e.g. qwen2.5-coder:7b")
  .option("-y, --yes", "auto-install Ollama if missing", false)
  .action(async (id: string, opts) => {
    const wfix = fixWindowsModelsPath();
    if (wfix) console.log(c.yellow(`⚠ 한글 경로 감지 — 모델 저장 경로를 ${wfix.dir} 로 설정했습니다.`));
    // Already installed/running? (HTTP check is definitive even when PATH is stale on Windows.)
    const present = ollamaInstalled() || (await ollamaServerUp());
    if (!present) {
      const plan = ollamaInstallPlan();
      if (plan.canAuto && plan.command && opts.yes) {
        console.log(c.cyan("Installing Ollama…"));
        await runCmd(plan.command.cmd, plan.command.args);
      }
      if (!ollamaInstalled() && !(await ollamaServerUp())) {
        console.log(c.yellow("Ollama not installed. " + plan.manual));
        process.exit(1);
      }
    } else {
      console.log(c.dim("Ollama already installed — skipping install."));
    }
    await ensureServer();
    console.log(c.cyan(`Pulling ${id}…`));
    const ok = await runCmd(ollamaCmd(), ["pull", id]);
    if (!ok) {
      console.log(c.red(`Failed to pull ${id}.`));
      process.exit(1);
    }
    const cfg = loadConfig();
    cfg.local.enabled = true;
    saveConfig(cfg);
    console.log(c.green(`✓ ${id} ready → local/${id} ($0). 로컬 라우팅 켜짐.`));
  });
localCmd
  .command("rm")
  .description("Remove an installed local model")
  .argument("<id>", "model id")
  .action(async (id: string) => {
    const ok = await runCmd(ollamaCmd(), ["rm", id]);
    console.log(ok ? c.green(`✓ removed ${id}`) : c.red(`failed to remove ${id}`));
  });
localCmd
  .command("fix")
  .description("Windows 한글 사용자명 경로 문제 해결: 모델을 ASCII 경로로 이동 + Ollama 재시작")
  .action(async () => {
    if (process.platform !== "win32") {
      console.log(c.yellow("이 수정은 Windows 전용입니다 (한글/비ASCII 사용자명 경로 문제)."));
      return;
    }
    console.log(c.cyan("Ollama 중지 후 모델을 ASCII 경로로 이동 중… (재다운로드 없음)"));
    try {
      execSyncCmd("taskkill /f /im ollama.exe", { stdio: "ignore", windowsHide: true });
    } catch {
      /* may not be running */
    }
    const mig = migrateOllamaModelsToAscii();
    const fix = fixWindowsModelsPath();
    await restartOllama();
    if (!fix) {
      console.log(c.green("ASCII 경로라 수정할 게 없습니다."));
      return;
    }
    console.log(c.green(`✓ 모델 ${mig?.moved ?? 0}개 이동 → ${fix.dir}`));
    console.log(c.dim("  OLLAMA_MODELS 설정 + Ollama 재시작 완료. 이제 모델 로드 오류가 해결됩니다."));
  });

// ---- subagent (remote GPU worker) ------------------------------------------
registerSubagentCommands(program);

program.parseAsync().catch((err) => {
  console.error(c.red(err?.message ?? String(err)));
  process.exit(1);
});
