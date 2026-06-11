import { OpenRouterClient } from "../../src/providers/openrouter.js";
import type { ChatMessage, ModelInfo, ToolSchema } from "../../src/providers/types.js";
import { route, projectCost } from "../../src/router/router.js";
import type { RoutingObjective, RoutingPolicy } from "../../src/router/policy.js";
import { getPageInfo, clickBySelector, typeBySelector, extractBySelector } from "./pageFns.js";
import { logCompletion, type UsageRow } from "./usage.js";

const BROWSER_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_page",
      description: "Read the current page: returns url, title, visible text, and a list of interactive elements with CSS selectors. Call this first.",
      parameters: { type: "object", properties: { maxChars: { type: "number", description: "max characters of page text (default 4000)" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "Click an element by CSS selector (use a selector from get_page).",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into an input/textarea/contenteditable by CSS selector.",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "extract",
      description: "Return the text content of all elements matching a CSS selector.",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the active tab to a URL and wait for load.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Finish the task with a short summary for the user.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  },
];

async function inPage(tabId: number, func: (...a: any[]) => any, args: any[]): Promise<any> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: func as any, args: args as any });
  return res?.result;
}

async function navigate(tabId: number, url: string): Promise<string> {
  await chrome.tabs.update(tabId, { url });
  await new Promise<void>((resolve) => {
    const done = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(done);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 15000);
  });
  return "navigated to " + url;
}

async function execTool(name: string, argsJson: string, tabId: number): Promise<{ result: string; finish?: string }> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { result: "bad arguments: " + argsJson };
  }
  try {
    switch (name) {
      case "get_page": {
        const info = await inPage(tabId, getPageInfo, [args.maxChars ?? 4000]);
        return { result: JSON.stringify(info).slice(0, 9000) };
      }
      case "click":
        return { result: await inPage(tabId, clickBySelector, [String(args.selector)]) };
      case "type":
        return { result: await inPage(tabId, typeBySelector, [String(args.selector), String(args.text ?? "")]) };
      case "extract":
        return { result: await inPage(tabId, extractBySelector, [String(args.selector)]) };
      case "navigate":
        return { result: await navigate(tabId, String(args.url)) };
      case "finish":
        return { result: "ok", finish: String(args.summary ?? "Done.") };
      default:
        return { result: "unknown tool: " + name };
    }
  } catch (err: any) {
    return { result: "tool error: " + (err?.message ?? String(err)) };
  }
}

// ---- recommendation (before running) ---------------------------------------

export interface BrowserRec {
  objective: RoutingObjective;
  model: ModelInfo | null;
  estSessionUsd: number;
}

const NOMINAL_CALLS = 8;
const NOMINAL_EST = { promptTokens: 3000, completionTokens: 400 };

export function recommendBrowser(models: ModelInfo[]): BrowserRec[] {
  const objectives: RoutingObjective[] = ["cheapest", "value", "quality"];
  return objectives.map((objective) => {
    const r = route("edit", models, { objective }, NOMINAL_EST);
    return {
      objective,
      model: r?.model ?? null,
      estSessionUsd: r ? projectCost(r.model, NOMINAL_EST) * NOMINAL_CALLS : 0,
    };
  });
}

// ---- the agent loop --------------------------------------------------------

export type BrowserEvent =
  | { type: "model"; model: ModelInfo; reason: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; name: string; args: string }
  | { type: "tool-result"; name: string; result: string }
  | { type: "usage"; row: UsageRow }
  | { type: "done"; summary: string }
  | { type: "error"; message: string };

export interface BrowserDeps {
  client: OpenRouterClient;
  models: ModelInfo[];
  objective: RoutingObjective;
  tabId: number;
}

const MAX_ITERS = 14;

export async function runBrowserAgent(
  goal: string,
  deps: BrowserDeps,
  emit: (e: BrowserEvent) => void
): Promise<void> {
  const policy: RoutingPolicy = { objective: deps.objective };
  const r = route("edit", deps.models, policy);
  if (!r) {
    emit({ type: "error", message: "No tool-capable model available for browser automation." });
    return;
  }
  const model = r.model;
  emit({ type: "model", model, reason: r.reason });

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM(goal) },
    { role: "user", content: goal },
  ];

  let summary = "";
  for (let i = 0; i < MAX_ITERS; i++) {
    const gen = deps.client.stream(
      { model: model.id, messages, tools: BROWSER_TOOLS, temperature: 0.2, maxTokens: 1500 },
      model.pricing
    );
    let next = await gen.next();
    while (!next.done) {
      emit({ type: "text", delta: next.value });
      next = await gen.next();
    }
    const result = next.value;
    const row = await logCompletion(result, "browser");
    emit({ type: "usage", row });

    if (result.toolCalls.length) {
      messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
      let finished = false;
      for (const tc of result.toolCalls) {
        emit({ type: "tool-call", name: tc.function.name, args: tc.function.arguments });
        const out = await execTool(tc.function.name, tc.function.arguments, deps.tabId);
        emit({ type: "tool-result", name: tc.function.name, result: out.result });
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: out.result });
        if (out.finish != null) {
          summary = out.finish;
          finished = true;
        }
      }
      if (finished) break;
      continue;
    }
    summary = result.content || summary;
    break;
  }
  emit({ type: "done", summary: summary || "(finished)" });
}

function SYSTEM(goal: string): string {
  return `You are Polymath, an autonomous browser-automation agent controlling the user's ACTIVE browser tab through tools.
Goal: ${goal}

Rules:
- ALWAYS call get_page first to understand the current page and obtain element selectors.
- Use click/type/extract with selectors returned by get_page; use navigate to change pages.
- Take one concrete action at a time, then re-read the page if the DOM likely changed.
- Do NOT ask the user questions; act autonomously. Call finish with a short summary when the goal is achieved or truly blocked.
You were selected as the most cost-effective tool-capable model for this task — be efficient.`;
}
