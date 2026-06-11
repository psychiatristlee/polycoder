import type { OpenRouterClient } from "../providers/openrouter.js";
import type { CompletionResult, ModelInfo } from "../providers/types.js";
import {
  ALL_TASK_TYPES,
  ALL_GOAL_TYPES,
  type GoalType,
  type Plan,
  type PlannedStep,
  type TaskType,
} from "./tasks.js";

const PLAN_SYSTEM = `You are the planning stage of a coding agent. Break the user's request into a short, ordered list of concrete steps.
Each step must be classified by type, chosen from EXACTLY this set:
  plan      - high-level decomposition / design decisions
  search    - locate files, symbols, or information in the codebase
  read      - read & understand existing code
  edit      - write or modify code
  command   - run a shell/build/test command
  review    - critique code for correctness or bugs
  reason    - hard algorithmic or architectural reasoning
  explain   - explain results to the user
  summarize - condense long content
  chat      - a simple conversational reply

Also classify the request's goalType (one of: feature, bugfix, refactor, test, docs, chore, other) and write 2-5 MEASURABLE acceptance criteria — concrete, checkable conditions that mean the goal is fully achieved (e.g. "hello.js exists and prints the greeting", "npm test passes", "the function handles empty input").

Return ONLY minified JSON of the form:
{"goalType":"<type>","criteria":["...","..."],"steps":[{"type":"<type>","description":"...","estPromptTokens":<int>,"estCompletionTokens":<int>}]}
Use 3-8 steps for non-trivial work, fewer for simple requests. Estimate tokens realistically (prompts often 2000-15000, completions 200-3000).`;

export function classifyGoalType(goal: string): GoalType {
  const g = goal.toLowerCase();
  if (/\b(fix|bug|broken|error|crash|regression|fails?)\b/.test(g)) return "bugfix";
  if (/\b(refactor|rename|clean ?up|restructure|extract|simplif)/.test(g)) return "refactor";
  if (/\b(test|spec|coverage|unit test|e2e)\b/.test(g)) return "test";
  if (/\b(docs?|readme|comment|documentation)\b/.test(g)) return "docs";
  if (/\b(bump|upgrade|dependency|deps|config|chore|lint|format)\b/.test(g)) return "chore";
  if (/\b(add|create|implement|build|feature|support|new)\b/.test(g)) return "feature";
  return "other";
}

export function heuristicPlan(goal: string): Plan {
  // Deterministic fallback used when no model is available (e.g. offline cost estimates).
  const steps: PlannedStep[] = [
    { id: 1, type: "plan", description: "Decompose the request", estPromptTokens: 2000, estCompletionTokens: 600 },
    { id: 2, type: "search", description: "Locate relevant files", estPromptTokens: 3000, estCompletionTokens: 400 },
    { id: 3, type: "read", description: "Read & understand code", estPromptTokens: 8000, estCompletionTokens: 500 },
    { id: 4, type: "edit", description: "Implement the change", estPromptTokens: 9000, estCompletionTokens: 1500 },
    { id: 5, type: "review", description: "Review the change", estPromptTokens: 6000, estCompletionTokens: 800 },
  ];
  return {
    goal,
    steps,
    goalType: classifyGoalType(goal),
    criteria: ["The stated goal is fully implemented and works", "No obvious errors or omissions remain"],
  };
}

export async function planRequest(
  goal: string,
  client: OpenRouterClient,
  planModel: ModelInfo,
  onUsage?: (result: CompletionResult) => void
): Promise<Plan> {
  const result = await client.complete(
    {
      model: planModel.id,
      messages: [
        { role: "system", content: PLAN_SYSTEM },
        { role: "user", content: goal },
      ],
      temperature: 0,
      maxTokens: 1200,
    },
    planModel.pricing
  );
  onUsage?.(result);
  const parsed = extractPlan(result.content);
  if (!parsed) return heuristicPlan(goal);
  return { goal, ...parsed };
}

function extractPlan(text: string): Omit<Plan, "goal"> | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { steps?: any[]; goalType?: string; criteria?: any[] };
    if (!Array.isArray(obj.steps)) return null;
    const steps: PlannedStep[] = obj.steps.map((s, i) => ({
      id: i + 1,
      type: coerceTaskType(s.type),
      description: String(s.description ?? "").slice(0, 300) || "(step)",
      estPromptTokens: clampInt(s.estPromptTokens, 500, 60000, 4000),
      estCompletionTokens: clampInt(s.estCompletionTokens, 100, 8000, 800),
    }));
    if (!steps.length) return null;
    const goalType = (ALL_GOAL_TYPES as string[]).includes(String(obj.goalType))
      ? (obj.goalType as GoalType)
      : "other";
    const criteria = Array.isArray(obj.criteria)
      ? obj.criteria.map((x) => String(x).slice(0, 200)).filter(Boolean).slice(0, 6)
      : [];
    return { steps, goalType, criteria: criteria.length ? criteria : ["The stated goal is fully achieved"] };
  } catch {
    return null;
  }
}

function coerceTaskType(v: unknown): TaskType {
  const s = String(v).toLowerCase().trim() as TaskType;
  return (ALL_TASK_TYPES as string[]).includes(s) ? s : "edit";
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Pull the first balanced JSON object out of a model response (handles code fences/prose). */
export function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{");
  if (start === -1) return null;
  // String/escape-aware brace matching: braces inside string literals (very common in
  // step descriptions like "add a closing brace }") must NOT affect the depth counter.
  let depth = 0;
  let inString = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") {
        i++; // skip the escaped character
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}
