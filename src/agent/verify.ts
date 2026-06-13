// The verify gate: measure the ACTUAL result against the acceptance criteria.
// The verifier inspects the workspace with read-only tools (and may run tests if
// commands are allowed), then returns a structured verdict. A failing verdict is
// what triggers escalation in the agent loop.
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ChatMessage, CompletionResult, ModelInfo } from "../providers/types.js";
import {
  READONLY_TOOL_SCHEMAS,
  executeTool,
  parseTextToolCall,
  type ToolContext,
} from "./tools.js";
import { extractJson } from "../planner/planner.js";

export interface CriterionResult {
  criterion: string;
  met: boolean;
  reason: string;
}

export interface Verdict {
  total: number;
  metCount: number;
  allMet: boolean;
  results: CriterionResult[];
  unmet: CriterionResult[];
  feedback: string;
}

export interface VerifyEvents {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
  onUsage?: (r: CompletionResult) => void;
}

const VERIFY_MAX_ITERS = 8;

const VERIFY_SYSTEM = `You are the VERIFY stage of an autonomous coding agent. Your job is to MEASURE whether the goal was actually achieved — be skeptical and check the real workspace, do not assume.
Use the read-only tools (read_file, list_dir, run_command) to inspect files and, where relevant, run build/test commands. Then judge EACH acceptance criterion against what you actually observed.
When done, reply with ONLY this JSON (no prose, no code fence):
{"results":[{"criterion":"<verbatim>","met":true|false,"reason":"<evidence>"}],"feedback":"<concrete guidance to fix any unmet criteria>"}`;

export async function verifyGoal(
  goal: string,
  criteria: string[],
  deps: { client: OpenRouterClient; model: ModelInfo; cwd: string; allowCommands: boolean; allowWeb?: boolean },
  ev: VerifyEvents = {}
): Promise<Verdict> {
  const toolCtx: ToolContext = { cwd: deps.cwd, allowWrite: false, allowCommands: deps.allowCommands, allowWeb: deps.allowWeb ?? false };
  const useTools = deps.model.capabilities.tools;
  const messages: ChatMessage[] = [
    { role: "system", content: VERIFY_SYSTEM },
    {
      role: "user",
      content:
        `Goal: ${goal}\n\nAcceptance criteria:\n` +
        criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\nInspect the workspace, then return the verdict JSON.`,
    },
  ];

  let verdict: Verdict | null = null;
  for (let iter = 0; iter < VERIFY_MAX_ITERS; iter++) {
    const gen = deps.client.stream(
      { model: deps.model.id, messages, tools: useTools ? READONLY_TOOL_SCHEMAS : undefined, temperature: 0, maxTokens: 1500 },
      deps.model.pricing
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const result = next.value;
    ev.onUsage?.(result);

    const calls = result.toolCalls.length
      ? result.toolCalls
      : useTools && parseTextToolCall(result.content)
      ? [parseTextToolCall(result.content)!]
      : [];

    // A verdict in the text ends verification.
    const parsed = parseVerdict(result.content, criteria);
    if (parsed) {
      verdict = parsed;
      break;
    }

    if (calls.length) {
      if (result.toolCalls.length) messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
      for (const tc of calls) {
        ev.onToolCall?.(tc.function.name, tc.function.arguments);
        const outcome = await executeTool(tc.function.name, tc.function.arguments, toolCtx);
        ev.onToolResult?.(tc.function.name, outcome.result);
        if (result.toolCalls.length) {
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: outcome.result });
        } else {
          messages.push({ role: "assistant", content: result.content });
          messages.push({ role: "user", content: `Tool ${tc.function.name} returned:\n${outcome.result}\nContinue, then return the verdict JSON.` });
        }
      }
      continue;
    }

    // No tools, no verdict — ask once more for the JSON.
    messages.push({ role: "assistant", content: result.content });
    messages.push({ role: "user", content: `Return ONLY the verdict JSON now.` });
  }

  return verdict ?? fallbackVerdict(criteria);
}

function parseVerdict(text: string, criteria: string[]): Verdict | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { results?: any[]; feedback?: string };
    if (!Array.isArray(obj.results)) return null;
    const results: CriterionResult[] = obj.results.map((r) => ({
      criterion: String(r.criterion ?? ""),
      met: r.met === true || String(r.met).toLowerCase() === "true",
      reason: String(r.reason ?? "").slice(0, 300),
    }));
    if (!results.length) return null;
    const unmet = results.filter((r) => !r.met);
    return {
      total: results.length,
      metCount: results.length - unmet.length,
      allMet: unmet.length === 0,
      results,
      unmet,
      feedback: String(obj.feedback ?? "").slice(0, 1000) || unmet.map((u) => u.reason).join("; "),
    };
  } catch {
    return null;
  }
  void criteria;
}

/** When the verifier can't produce a verdict, treat as unmet (forces escalation). */
function fallbackVerdict(criteria: string[]): Verdict {
  const results = criteria.map((c) => ({ criterion: c, met: false, reason: "verifier produced no verdict" }));
  return { total: results.length, metCount: 0, allMet: false, results, unmet: results, feedback: "Verification inconclusive; re-attempt with a stronger model." };
}
