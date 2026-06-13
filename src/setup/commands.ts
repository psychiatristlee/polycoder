import { execSync } from "node:child_process";
import { loadConfig, saveConfig, resolveApiKey } from "../config/store.js";
import { runLogin } from "../auth/onboarding.js";
import { confirm, select } from "../util/prompt.js";
import { c } from "../util/format.js";
import {
  ollamaInstalled,
  ollamaVersion,
  ollamaInstallPlan,
  ensureServer,
  installedModels,
  suggestModels,
  totalRamGb,
  recommendBestModel,
  run,
  type ModelSuggestion,
} from "./localllm.js";

export interface SetupOptions {
  local?: boolean; // --local / --no-local; undefined = ask
  model?: string;
  yes?: boolean; // -y, accept defaults / auto-install
  auto?: boolean; // measure the machine and auto-pick the strongest model that fits
  recommend?: boolean; // just print the measurement + recommendation, change nothing
}

/** Print detected specs and the strongest local model that fits this machine. */
export function printRecommendation(): void {
  const rec = recommendBestModel();
  const s = rec.sys;
  console.log(c.bold("\n🖥  Detected hardware"));
  console.log(`   ${s.cpu}  ·  ${s.ramGb}GB RAM  ·  ${s.freeDiskGb}GB free disk  (${s.platform}/${s.arch})`);
  console.log(c.bold("\n🏆 Best local model that fits"));
  if (rec.best) {
    console.log(`   ${c.green(rec.best.id)}  (~${rec.best.diskGb}GB) — ${rec.best.note}`);
  } else {
    console.log(c.yellow("   None fit — free up disk or use a smaller model / OpenRouter."));
  }
  if (rec.fits.length > 1) {
    console.log(c.dim("   also fits: " + rec.fits.slice(1).map((m) => `${m.id} (~${m.diskGb}GB)`).join(", ")));
  }
  for (const b of rec.blocked) {
    console.log(c.dim(`   ✗ ${b.spec.id} — ${b.reason}`));
  }
  console.log("");
}

/** First-run setup: optionally install a local LLM, and optionally connect OpenRouter. */
export async function runSetup(opts: SetupOptions): Promise<void> {
  console.log(c.bold("\n🔧 Polymath setup\n"));
  const config = loadConfig();

  // --recommend: report only, change nothing.
  if (opts.recommend) {
    printRecommendation();
    return;
  }

  // 1) Local LLM — gated by the --local / --no-local flag (or a prompt).
  //    --auto implies local + auto-pick the best-fitting model.
  let wantLocal = opts.auto ? true : opts.local;
  if (wantLocal === undefined) {
    wantLocal = await confirm(
      `Install a local LLM (Ollama) for $0, offline, no-API-key runs? (RAM detected: ${totalRamGb()}GB)`,
      true
    );
  }

  if (wantLocal) {
    await setupLocal(opts, config);
  } else {
    config.local.enabled = false;
    saveConfig(config);
    console.log(c.dim("Skipping local LLM. (You can run `poly setup --local` later.)"));
  }

  // 2) OpenRouter key — offer if none is configured (cloud models / fallback).
  const freshConfig = loadConfig();
  if (!resolveApiKey(freshConfig)) {
    const wantKey = opts.yes
      ? false
      : await confirm("Connect an OpenRouter API key for cloud models (300+ models)?", !wantLocal);
    if (wantKey) await runLogin();
    else if (!wantLocal) console.log(c.yellow("No models configured yet — run `poly login` or `poly setup --local`."));
  }

  console.log(c.green("\n✓ Setup complete.") + c.dim("  Try: poly recommend \"add a dark-mode toggle\"  ·  poly run -w \"...\""));
}

async function setupLocal(opts: SetupOptions, config: ReturnType<typeof loadConfig>): Promise<void> {
  // a) Ollama runtime.
  if (!ollamaInstalled()) {
    const plan = ollamaInstallPlan();
    console.log(c.cyan("Local LLM runtime: Ollama is not installed."));
    if (plan.canAuto && plan.command) {
      const go = opts.yes || (await confirm(`Install Ollama via \`${plan.command.cmd} ${plan.command.args.join(" ")}\`?`, true));
      if (go) {
        const ok = await run(plan.command.cmd, plan.command.args);
        if (!ok) console.log(c.yellow("Auto-install failed. Manual: " + plan.manual));
      } else {
        console.log(c.dim("Manual install: " + plan.manual));
      }
    } else {
      console.log(c.yellow("Install manually: " + plan.manual));
    }
  } else {
    console.log(c.green("✓ Ollama present ") + c.dim(ollamaVersion() ?? ""));
  }

  if (!ollamaInstalled()) {
    console.log(c.yellow("Ollama still not on PATH — re-run `poly setup --local` after installing."));
    return;
  }

  // b) Server.
  process.stdout.write("Starting Ollama server… ");
  const up = await ensureServer(config.local.baseUrl);
  console.log(up ? c.green("ok") : c.yellow("could not confirm (start it with `ollama serve`)"));

  // c) Model.
  const have = await installedModels(config.local.baseUrl);
  let modelId = opts.model;
  if (!modelId && (opts.auto || opts.yes)) {
    // Measure the machine and auto-pick the strongest model that fits RAM + disk.
    printRecommendation();
    const best = recommendBestModel().best;
    if (best) {
      modelId = best.id;
      console.log(c.cyan(`Auto-selected ${c.bold(best.id)} for this machine.`));
    }
  }
  if (!modelId) {
    const suggestions = suggestModels().filter((s) => !have.includes(s.id));
    if (have.length && !suggestions.length) {
      modelId = have[0];
      console.log(c.dim(`Using already-installed model ${modelId}.`));
    } else {
      const pick = opts.yes
        ? suggestModels()[0]
        : await select<ModelSuggestion>(
            "Pick a model to download:",
            suggestModels(),
            (s) => `${s.label}  (~${s.sizeGb}GB) — ${s.note}${have.includes(s.id) ? " [installed]" : ""}`
          );
      modelId = pick.id;
    }
  }
  if (!have.includes(modelId)) {
    console.log(c.cyan(`Downloading ${modelId}…`));
    const ok = await run("ollama", ["pull", modelId]);
    if (!ok) {
      console.log(c.yellow(`Could not pull ${modelId}. Run \`ollama pull ${modelId}\` manually.`));
      return;
    }
  }

  // d) Enable in Polymath.
  config.local.enabled = true;
  saveConfig(config);
  console.log(c.green(`✓ Local LLM ready: ${modelId} → local/${modelId} ($0). `) + c.dim("Enabled in config."));
}

// ---- update ----------------------------------------------------------------

export interface UpdateOptions {
  check?: boolean; // report only, don't change anything
  self?: boolean; // only the CLI
  ollama?: boolean; // only the runtime
  models?: boolean; // only the models
}

function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Update the CLI (npm), the Ollama runtime, and pulled models. */
export async function runUpdate(currentVersion: string, opts: UpdateOptions): Promise<void> {
  const all = !opts.self && !opts.ollama && !opts.models;
  console.log(c.bold("\n⬆️  Polymath update") + (opts.check ? c.dim("  (check only)") : "") + "\n");

  // 1) The CLI itself.
  if (all || opts.self) {
    let latest = "";
    try {
      latest = execSync("npm view polycoder version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      latest = "";
    }
    if (!latest) {
      console.log(c.dim("CLI: could not reach npm registry."));
    } else if (cmp(latest, currentVersion) > 0) {
      console.log(c.yellow(`CLI: ${currentVersion} → ${latest} available.`));
      if (!opts.check) {
        const ok = await run("npm", ["install", "-g", `polycoder@${latest}`]);
        console.log(ok ? c.green(`✓ Updated to ${latest}.`) : c.red("npm update failed (try: sudo npm i -g polycoder@latest)."));
      } else {
        console.log(c.dim("  Run `poly update` to install."));
      }
    } else {
      console.log(c.green(`✓ CLI is up to date (${currentVersion}).`));
    }
  }

  // 2) Ollama runtime.
  if (all || opts.ollama) {
    if (!ollamaInstalled()) {
      console.log(c.dim("Ollama: not installed (run `poly setup --local`)."));
    } else if (opts.check) {
      console.log(c.dim(`Ollama: ${ollamaVersion() ?? "present"} (update with \`poly update --ollama\`).`));
    } else if (process.platform === "darwin") {
      console.log(c.cyan("Updating Ollama…"));
      await run("brew", ["upgrade", "ollama"]).then((ok) => !ok && console.log(c.dim("  (brew upgrade skipped/failed)")));
    } else if (process.platform === "linux") {
      await run("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]);
    } else {
      console.log(c.dim("Ollama: update via your installer (winget upgrade Ollama.Ollama)."));
    }
  }

  // 3) Local models (re-pull = update to the latest tag).
  if (all || opts.models) {
    const config = loadConfig();
    const models = await installedModels(config.local.baseUrl);
    if (!models.length) {
      console.log(c.dim("Models: none installed."));
    } else if (opts.check) {
      console.log(c.dim(`Models: ${models.join(", ")} (re-pull to update).`));
    } else {
      for (const m of models) {
        console.log(c.cyan(`Updating ${m}…`));
        await run("ollama", ["pull", m]);
      }
    }
  }

  console.log("");
}
