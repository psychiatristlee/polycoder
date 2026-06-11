import { OpenRouterClient } from "../../src/providers/openrouter.js";
import type { ModelInfo } from "../../src/providers/types.js";
import type { RoutingObjective } from "../../src/router/policy.js";
import { getConfig, setConfig } from "./storage.js";
import { loadModels } from "./models.js";
import { recommendBrowser, runBrowserAgent, type BrowserEvent } from "./browserAgent.js";
import { reportByDateModel, totals } from "./usage.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const goalEl = $<HTMLTextAreaElement>("goal");
const out = $<HTMLPreElement>("out");
const costEl = $<HTMLSpanElement>("cost");
const objSel = $<HTMLSelectElement>("objective");
const needKey = $<HTMLDivElement>("needkey");

let models: ModelInfo[] = [];
let cost = 0;
let running = false;

function usd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(3);
}

function line(text: string, cls = "t") {
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text + "\n";
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}
function clear() {
  out.textContent = "";
  out.className = "";
}

async function client(): Promise<OpenRouterClient | null> {
  const cfg = await getConfig();
  if (!cfg.openrouterApiKey) {
    needKey.hidden = false;
    return null;
  }
  return new OpenRouterClient({ apiKey: cfg.openrouterApiKey, referer: cfg.referer, title: cfg.title });
}

async function ensureModels(c: OpenRouterClient): Promise<boolean> {
  if (models.length) return true;
  line("Loading model catalog…");
  try {
    models = await loadModels(c);
    return models.length > 0;
  } catch (e: any) {
    line("Failed to load models: " + (e?.message ?? e), "r");
    return false;
  }
}

async function activeTabId(): Promise<{ id?: number; url?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { id: tab?.id, url: tab?.url };
}

async function onRecommend() {
  const c = await client();
  if (!c) return;
  clear();
  if (!(await ensureModels(c))) return;
  const recs = recommendBrowser(models);
  line("Model options for this task (8-step session estimate):", "c");
  for (const r of recs) {
    line(`  ${r.objective.padEnd(8)} ${r.model ? r.model.id : "(none)"}  ~${usd(r.estSessionUsd)}`, "y");
  }
  line("Pick an objective above, then Run.", "t");
}

async function onRun() {
  if (running) return;
  const goal = goalEl.value.trim();
  if (!goal) {
    line("Type a goal first.", "r");
    return;
  }
  const c = await client();
  if (!c) return;
  clear();
  if (!(await ensureModels(c))) return;

  const { id: tabId, url } = await activeTabId();
  if (!tabId) {
    line("No active tab found.", "r");
    return;
  }
  if (url && /^(chrome|edge|about|chrome-extension):/i.test(url)) {
    line("Cannot automate this page (" + url.split("/")[0] + "). Open a normal website tab.", "r");
    return;
  }

  running = true;
  const objective = objSel.value as RoutingObjective;
  let textBuf = "";
  const flush = () => {
    if (textBuf.trim()) line(textBuf.trim(), "");
    textBuf = "";
  };
  const emit = (e: BrowserEvent) => {
    switch (e.type) {
      case "model":
        line(`→ model: ${e.model.id}  (${e.reason})`, "c");
        break;
      case "text":
        textBuf += e.delta;
        break;
      case "tool-call":
        flush();
        line(`  🔧 ${e.name}(${e.args.slice(0, 100)})`, "m");
        break;
      case "tool-result":
        line(`  ↳ ${e.result.replace(/\s+/g, " ").slice(0, 120)}`, "t");
        break;
      case "usage":
        cost += e.row.costUsd;
        costEl.textContent = usd(cost);
        break;
      case "done":
        flush();
        line("✓ " + e.summary, "g");
        break;
      case "error":
        flush();
        line("⚠ " + e.message, "r");
        break;
    }
  };

  try {
    await runBrowserAgent(goal, { client: c, models, objective, tabId }, emit);
  } catch (e: any) {
    line("Fatal: " + (e?.message ?? e), "r");
  } finally {
    running = false;
  }
}

async function onUsage() {
  clear();
  const rows = await reportByDateModel();
  if (!rows.length) {
    line("No usage recorded yet.", "t");
    return;
  }
  line("Usage by date + model:", "c");
  for (const r of rows) {
    line(`  ${r.date}  ${r.model}  ${r.calls} calls  ${usd(r.costUsd)}`, "t");
  }
  const t = await totals();
  line(`TOTAL  ${t.calls} calls · ${usd(t.costUsd)}`, "g");
}

async function init() {
  const cfg = await getConfig();
  objSel.value = cfg.objective;
  needKey.hidden = !!cfg.openrouterApiKey;
  objSel.addEventListener("change", () => setConfig({ objective: objSel.value as RoutingObjective }));
  $("run").addEventListener("click", onRun);
  $("recommend").addEventListener("click", onRecommend);
  $("usageBtn").addEventListener("click", onUsage);
  $("openopts").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  // warm the model cache
  const c = await client();
  if (c) ensureModels(c).catch(() => {});
}

init();
