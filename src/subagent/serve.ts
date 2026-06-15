// `poly subagent serve` — turn THIS (GPU) machine into a remote LLM worker:
// probe GPU → pull+serve the heaviest fitting model → start the auth-proxy → expose it
// (Cloudflare tunnel for cross-network, else LAN) → register to the account + heartbeat.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { loadConfig, saveConfig } from "../config/store.js";
import { ollamaInstalled, ollamaInstallPlan, ensureServer, installedModels, run, freeDiskGb, totalRamGb, ollamaCmd } from "../setup/localllm.js";
import { measureGpu, recommendBestModelGpu } from "./gpu.js";
import { startProxy } from "./proxy.js";
import { startTunnel } from "./tunnel.js";
import * as registry from "./registry.js";
import { c } from "../util/format.js";

export interface ServeOptions {
  port?: number;
  tunnel?: boolean;
  lan?: boolean;
  model?: string;
  yes?: boolean;
  install?: boolean;
  rotateToken?: boolean;
}

function lanIp(): string {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}

/** A stable launcher for the autostart job: the installed `poly` bin if resolvable,
 *  else node + this script path (guarded so we never bake a temp tsx/npx path). */
function resolveLauncher(): string[] {
  try {
    const which = process.platform === "win32" ? "where poly" : "command -v poly";
    const p = execSync(which, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
    if (p && fs.existsSync(p)) return [p];
  } catch {
    /* not on PATH */
  }
  const cli = process.argv[1] || "";
  if (cli.endsWith(".js") && fs.existsSync(cli)) return [process.execPath, cli];
  // Last resort: assume `poly` is on PATH at boot.
  return ["poly"];
}

function installAutostart(args: string[]): void {
  const launcher = resolveLauncher();
  if (process.platform === "darwin") {
    const label = "com.polyrun.subagent";
    const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
    const argXml = [...launcher, "subagent", "serve", ...args].map((a) => `    <string>${a}</string>`).join("\n");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
${argXml}
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.tmpdir(), "polyrun-subagent.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(os.tmpdir(), "polyrun-subagent.err")}</string>
</dict></plist>`;
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    console.log(c.green(`✓ Autostart installed (LaunchAgent → ${plistPath})`));
  } else if (process.platform === "win32") {
    const tr = [...launcher, "subagent", "serve", ...args].map((a) => `\\"${a}\\"`).join(" ");
    try {
      execSync(`schtasks /create /sc onlogon /tn PolyrunSubagent /tr "${tr}" /rl highest /f`, { stdio: "ignore" });
      // Start it now too (onlogon alone wouldn't run until the next sign-in).
      try {
        execSync(`schtasks /run /tn PolyrunSubagent`, { stdio: "ignore" });
      } catch {
        /* will start at next logon */
      }
      console.log(c.green("✓ Autostart installed (Scheduled Task: PolyrunSubagent, runs at logon + now)"));
    } catch {
      console.log(c.yellow("Could not create the scheduled task; run `poly subagent serve` manually or as a service."));
    }
  } else {
    console.log(c.yellow("Autostart install is implemented for macOS/Windows; on Linux use a systemd unit."));
  }
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const port = opts.port ?? 8765;
  console.log(c.bold("\n🛰  polyrun subagent\n"));

  // 1) Ollama runtime.
  if (!ollamaInstalled()) {
    const plan = ollamaInstallPlan();
    console.log(c.cyan("Ollama not installed."));
    if (plan.canAuto && plan.command && opts.yes) {
      await run(plan.command.cmd, plan.command.args);
    } else {
      console.log(c.yellow("Install Ollama first: " + plan.manual + "   (or re-run with -y to auto-install)"));
      if (!ollamaInstalled()) return;
    }
  }
  process.stdout.write("Starting Ollama… ");
  console.log((await ensureServer()) ? c.green("ok") : c.yellow("could not confirm (try `ollama serve`)"));

  // 2) GPU-aware heaviest model. Already-pulled models bypass the disk-margin check.
  const have = await installedModels();
  const pick = recommendBestModelGpu(measureGpu(), freeDiskGb(), have);
  console.log(c.dim("Hardware: ") + pick.gpu.name + c.dim(`  ·  free disk ${pick.freeDiskGb}GB`));
  if (pick.gpu.kind === "cpu") console.log(c.yellow("⚠ No GPU detected — a GPU machine is recommended for a subagent."));
  const modelId = opts.model || pick.model?.id;
  if (!modelId) {
    console.log(c.red(pick.reason));
    return;
  }
  console.log(c.green("Model: ") + modelId + c.dim(`  (${pick.reason})`));

  if (!have.includes(modelId)) {
    console.log(c.cyan(`Pulling ${modelId}… (one-time)`));
    if (!(await run(ollamaCmd(), ["pull", modelId]))) {
      console.log(c.red(`Failed to pull ${modelId}.`));
      return;
    }
  }

  // 3) Relay token (stored chmod 600 via saveConfig).
  const cfg = loadConfig();
  let token = cfg.local.authToken;
  if (!token || opts.rotateToken) {
    token = randomBytes(32).toString("hex");
    cfg.local.authToken = token;
    saveConfig(cfg);
  }

  // 3.5) Install-and-exit: set up autostart (which runs the foreground serve below at
  // boot/login) and return now, so the model pull + token are done once during install
  // but we don't hold the port. The OS-managed job becomes the long-running server.
  if (opts.install) {
    // Tunnel is the default, so emit NO transport flag for it (`--tunnel` isn't a
    // registered option — emitting it would make the autostart job error out and never
    // serve). Forward the resolved model + port so the boot server is deterministic.
    const transportArgs = opts.tunnel === false || opts.lan ? ["--lan"] : [];
    installAutostart([...transportArgs, "-p", String(port), "--model", modelId, "-y"]);
    console.log("\n" + c.bold("✓ Subagent installed") + c.dim(" (autostart — serves at boot/login)"));
    console.log(c.dim("  token   : ") + token);
    console.log(c.dim("  account : ") + registry.accountId());
    console.log(c.dim("  model   : ") + modelId);
    console.log("\n  The server is now running in the background. From the polyrun machine:");
    console.log(c.cyan(`    poly subagent link --token ${token}`) + c.dim("   (auto-discovers via your account)"));
    console.log(c.dim("  Or check the live endpoint any time:  ") + c.cyan("poly subagent status"));
    return;
  }

  // 4) Auth-proxy. Bind to localhost when tunneling (the tunnel connects via 127.0.0.1, so
  // there's no reason to also expose the proxy on the LAN); bind 0.0.0.0 only for --lan.
  const lanMode = opts.tunnel === false || opts.lan;
  await startProxy({ port, token, host: lanMode ? "0.0.0.0" : "127.0.0.1" });

  // 5) Transport: tunnel (cross-network) preferred, else LAN.
  let endpoint = "";
  let transport = "";
  if (!lanMode) {
    process.stdout.write("Opening Cloudflare tunnel… ");
    const t = await startTunnel(port);
    if (t) {
      endpoint = `${t.url}/v1`;
      transport = "cloudflare";
      console.log(c.green("ok"));
    } else {
      // Tunnel failed and we're bound to localhost only — no remote endpoint. Be honest.
      console.log(c.yellow("unavailable"));
      console.log(c.yellow("⚠ No tunnel and not --lan: only reachable on localhost. Re-run with --lan for LAN access."));
      endpoint = `http://127.0.0.1:${port}/v1`;
      transport = "local";
    }
  }
  if (!endpoint) {
    endpoint = `http://${lanIp()}:${port}/v1`;
    transport = "lan";
  }

  // 6) Register to account (best-effort).
  const registered = await registry.register({
    endpoint,
    transport,
    authTokenHash: registry.hashToken(token),
    model: modelId,
    models: await installedModels(),
    hardware: { gpu: pick.gpu.name, vramGb: pick.gpu.vramGb, ramGb: totalRamGb(), platform: process.platform },
    online: true,
    lastHeartbeat: Date.now(),
  });

  // 7) Report. Only print the full token to an interactive TTY — the autostart job runs
  // this same path with stdout redirected to a log file, where a plaintext token would leak.
  const tokenDisplay = process.stdout.isTTY ? token : token.slice(0, 8) + "…  (hidden; see `poly subagent status` / serve --install)";
  console.log("\n" + c.bold("✓ Subagent ready") + c.dim(` (${transport})`));
  console.log(c.dim("  endpoint : ") + c.green(endpoint));
  console.log(c.dim("  token    : ") + tokenDisplay);
  console.log(c.dim("  account  : ") + registry.accountId() + (registered ? c.green("  (registered)") : c.yellow("  (registry off — link manually)")));
  console.log("\n  On the polyrun machine (same account):");
  console.log(c.cyan(`    poly subagent link --url ${endpoint} --token ${tokenDisplay}`));
  console.log(c.dim("  Verify from here:"));
  console.log(c.dim(`    curl -s ${endpoint}/models -H "Authorization: Bearer ${token.slice(0, 8)}…"`));

  // 8) Heartbeat + stay alive (the proxy server keeps the event loop running).
  const hb = setInterval(() => void registry.heartbeat(), 30_000);
  const stop = async () => {
    clearInterval(hb);
    await registry.markOffline();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(c.dim("\nServing — keep this machine on & logged in. Ctrl+C to stop.\n"));
}
