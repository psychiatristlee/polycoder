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

IMPORTANT — answer, don't invent work: if the request is a question, a request to explain/show
something, casual conversation, or a meta-command about this agent/tool itself (e.g. "use the
saved key", "what can you do", "why did that happen", "is it working") — i.e. NOT a concrete
request to create or modify files/code — return EXACTLY ONE step of type "chat" that answers
directly. NEVER invent a coding project, create files, or run commands for such requests.

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

// Detect clearly non-build requests (questions / meta-commands about the tool) so the agent
// answers conversationally instead of inventing a coding project (e.g. "오픈라우터 키 이용해봐"
// must NOT trigger a 5-step plan that writes a fake .env). Conservative: ANY build intent or a
// long request disqualifies it, so real coding tasks are never swallowed.
// English tokens are \b-anchored so substrings don't false-match ("app" inside "happen",
// "add" inside "address") — that would wrongly route a meta question ("why did that happen")
// into a 5-step coding plan. Korean tokens need no boundaries.
const BUILD_INTENT =
  /(만들|구현|추가|작성|생성|고쳐|수정|개발|짜(줘|봐)|클론|스캐폴|그려|그래프|차트|페이지|컴포넌트|함수|파일|앱|사이트)|\b(build|create|implement|add|write|make|scaffold|set ?up|fix|refactor|install|deploy|render|api|app|website)\b/i;
const QUESTION_OR_META =
  /[?？]\s*$|^\s*(왜|뭐|무엇|어떻게|어디|언제|누가|what|why|how|where|when|which|who|can you|do you|does it|is it|are you)\b|(이용해|사용해|써\s*봐|이게\s*뭐|설명|알려줘|보여줘|뭐가\s*있|할\s*수\s*있|가능해|되나|돼\?)|\b(use|using|try)\s+(the|my|saved|stored|your)\s+(key|api ?key|config|settings)\b/i;
export function isConversational(goal: string): boolean {
  const g = (goal || "").trim();
  if (!g || g.length > 60) return false;
  if (BUILD_INTENT.test(g)) return false;
  return QUESTION_OR_META.test(g);
}
export function conversationalPlan(goal: string): Plan {
  return {
    goal,
    steps: [
      { id: 1, type: "chat", description: "Answer the user directly and conversationally. Do NOT create or modify any files or run commands.", estPromptTokens: 1200, estCompletionTokens: 500 },
    ],
    goalType: "other",
    criteria: ["The user's question or request is answered clearly and directly"],
  };
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
  onUsage?: (result: CompletionResult) => void,
  /** Optional reusable-skill playbook to bias the plan toward a proven approach. */
  extraContext?: string
): Promise<Plan> {
  // Short-circuit clearly conversational/meta requests to a single chat answer — no LLM plan,
  // no coding project. (Deterministic so it can't be derailed by a weak planner model.)
  if (isConversational(goal)) return conversationalPlan(goal);
  const system = extraContext ? `${PLAN_SYSTEM}\n\n${extraContext}` : PLAN_SYSTEM;
  const result = await client.complete(
    {
      model: planModel.id,
      messages: [
        { role: "system", content: system },
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
