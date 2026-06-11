import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ChatMessage, CompletionResult, ModelInfo } from "../providers/types.js";
import {
  type RoutingPolicy,
  ESCALATION_LADDER,
  applyRung,
  rungForTier,
} from "../router/policy.js";
import { route, routeOrBest } from "../router/router.js";
import { planRequest, heuristicPlan } from "../planner/planner.js";
import type { Plan, PlannedStep } from "../planner/tasks.js";
import { TOOL_SCHEMAS, executeTool, parseTextToolCall, type ToolContext } from "./tools.js";
import { verifyGoal, type Verdict } from "./verify.js";
import { logCompletion } from "../usage/logger.js";
import {
  startSession,
  finishSession,
  recordStepRun,
  recordAttempt,
  optimalStartTier,
  type UsageEntry,
  type StepRunRow,
} from "../usage/db.js";
import { TASK_SKILL } from "../models/strengths.js";

export type AgentEvent =
  | { type: "plan"; plan: Plan; planModel: string }
  | { type: "criteria"; goalType: string; criteria: string[]; startTier: string; learned: boolean }
  | { type: "step-start"; step: PlannedStep; model: ModelInfo; estCostUsd: number }
  | { type: "text"; delta: string }
  | { type: "tool-call"; name: string; args: string }
  | { type: "tool-result"; name: string; result: string }
  | { type: "usage"; entry: UsageEntry }
  | { type: "step-end"; step: PlannedStep; summary: string }
  | { type: "verify-start"; model: string; attempt: number }
  | { type: "verdict"; attempt: number; metCount: number; total: number; allMet: boolean; unmet: { criterion: string; reason: string }[] }
  | { type: "escalate"; toRung: string; reason: string }
  | { type: "done"; totalCostUsd: number; totalTokens: number; calls: number; passed: boolean | null; attempts: number }
  | { type: "error"; message: string };

export interface AgentDeps {
  client: OpenRouterClient;
  models: ModelInfo[];
  policy: RoutingPolicy;
  sessionId: string;
  cwd: string;
  allowWrite: boolean;
  allowCommands: boolean;
  /** Verify the result against acceptance criteria and escalate on failure (default true). */
  verify?: boolean;
  /** Max coding+verify attempts before giving up (default 3). */
  maxAttempts?: number;
}

interface Acc {
  cost: number;
  tokens: number;
  prompt: number;
  completion: number;
  calls: number;
}

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function runAgent(
  goal: string,
  deps: AgentDeps,
  emit: (e: AgentEvent) => void
): Promise<{ totalCostUsd: number; totalTokens: number; calls: number; passed: boolean | null }> {
  const { client, models, cwd } = deps;
  const verifyOn = deps.verify ?? true;
  const maxAttempts = deps.maxAttempts ?? 3;
  const acc: Acc = { cost: 0, tokens: 0, prompt: 0, completion: 0, calls: 0 };
  const sessionStart = Date.now();
  const toolCtx: ToolContext = { cwd, allowWrite: deps.allowWrite, allowCommands: deps.allowCommands };

  const logUsage = (r: CompletionResult, taskType: string) => {
    const entry = logCompletion(r, taskType, deps.sessionId);
    emit({ type: "usage", entry });
    acc.cost += entry.costUsd;
    acc.tokens += entry.totalTokens;
    acc.prompt += entry.promptTokens;
    acc.completion += entry.completionTokens;
    acc.calls++;
    return entry;
  };

  // 1) Plan (+ goal type + acceptance criteria).
  const planRoute = route("plan", models, deps.policy);
  let plan: Plan;
  if (planRoute) {
    try {
      plan = await planRequest(goal, client, planRoute.model, (r) => logUsage(r, "plan"));
    } catch {
      plan = heuristicPlan(goal);
    }
  } else {
    plan = heuristicPlan(goal);
  }
  emit({ type: "plan", plan, planModel: planRoute?.model.id ?? "heuristic" });

  // 2) Learned starting rung: if history says this goal type needs a stronger start,
  //    begin there instead of wasting cheap attempts (statistical optimization applied).
  let startRung = 0;
  let learned = false;
  if (verifyOn) {
    const tier = optimalStartTier(plan.goalType);
    if (tier) {
      const r = rungForTier(tier as any);
      if (r > 0) {
        startRung = r;
        learned = true;
      }
    }
  }
  const startTier = ESCALATION_LADDER[startRung].tierFloor ?? "cheap";
  emit({ type: "criteria", goalType: plan.goalType, criteria: plan.criteria, startTier, learned });

  startSession({
    id: deps.sessionId,
    ts: sessionStart,
    date: localDate(),
    goal,
    command: "run",
    objective: deps.policy.objective,
    plannedSteps: plan.steps.length,
    goalType: plan.goalType,
    startTier,
  });

  // 3) Outcome-driven attempt loop.
  let rung = startRung;
  let attemptNo = 0;
  let verdict: Verdict | null = null;
  let completedSteps = 0;
  let failedSteps = 0;
  const priorSummaries: string[] = [];

  while (attemptNo < maxAttempts) {
    const rungDef = ESCALATION_LADDER[Math.min(rung, ESCALATION_LADDER.length - 1)];
    const rungPolicy = applyRung(deps.policy, rungDef);
    const attemptStart = Date.now();
    const before = { ...acc };

    if (attemptNo === 0) {
      // First attempt: execute the whole plan. Only plan steps move the session-level
      // completed/failed counters (so completed+failed == plannedSteps).
      for (const step of plan.steps) {
        const res = await runStep(step, rungPolicy, rungDef, deps, toolCtx, priorSummaries, emit, logUsage, goal);
        if (res.success) completedSteps++;
        else failedSteps++;
      }
    } else {
      // Re-attempt: a focused fix pass driven by the verifier's feedback. Recorded in
      // step_runs + the attempts table; it is NOT a plan step, so it must not mutate the
      // session plan-step counters (would inflate completed_steps beyond plannedSteps).
      await runFix(goal, plan, verdict!, rungPolicy, rungDef, deps, toolCtx, emit, logUsage);
    }

    if (!verifyOn) {
      attemptNo++;
      break;
    }

    // VERIFY: measure the actual result against the acceptance criteria.
    const verifyPolicy: RoutingPolicy = { ...deps.policy, objective: "quality", tierFloor: rungDef.tierFloor };
    const verifier = routeOrBest("verify", models, verifyPolicy);
    if (!verifier) {
      emit({ type: "error", message: "No model available to verify." });
      attemptNo++;
      break;
    }
    emit({ type: "verify-start", model: verifier.model.id, attempt: attemptNo + 1 });
    verdict = await verifyGoal(goal, plan.criteria, { client, model: verifier.model, cwd, allowCommands: deps.allowCommands }, {
      onToolCall: (name, args) => emit({ type: "tool-call", name, args }),
      onToolResult: (name, result) => emit({ type: "tool-result", name, result }),
      onUsage: (r) => logUsage(r, "review"),
    });
    emit({ type: "verdict", attempt: attemptNo + 1, metCount: verdict.metCount, total: verdict.total, allMet: verdict.allMet, unmet: verdict.unmet });

    recordAttempt({
      sessionId: deps.sessionId,
      attemptNo: attemptNo + 1,
      goalType: plan.goalType,
      tierFloor: rungDef.tierFloor ?? null,
      objective: rungDef.objective,
      promptTokens: acc.prompt - before.prompt,
      completionTokens: acc.completion - before.completion,
      costUsd: acc.cost - before.cost,
      criteriaTotal: verdict.total,
      criteriaMet: verdict.metCount,
      passed: verdict.allMet,
      durationMs: Date.now() - attemptStart,
    });

    attemptNo++;
    if (verdict.allMet) break;

    // Escalate: more tokens, higher tier, pricier model — until goals are met.
    if (attemptNo < maxAttempts) {
      const next = Math.min(rung + 1, ESCALATION_LADDER.length - 1);
      rung = next;
      emit({
        type: "escalate",
        toRung: ESCALATION_LADDER[next].label,
        reason: `${verdict.unmet.length}/${verdict.total} criteria unmet`,
      });
    }
  }

  const passed = verifyOn ? (verdict ? verdict.allMet : false) : null;
  finishSession(deps.sessionId, {
    plannedSteps: plan.steps.length,
    completedSteps,
    failedSteps,
    autoScore: verdict ? verdict.metCount / Math.max(verdict.total, 1) : plan.steps.length ? completedSteps / plan.steps.length : null,
    promptTokens: acc.prompt,
    completionTokens: acc.completion,
    costUsd: acc.cost,
    durationMs: Date.now() - sessionStart,
    attempts: attemptNo,
    finalPassed: passed,
  });

  emit({ type: "done", totalCostUsd: acc.cost, totalTokens: acc.tokens, calls: acc.calls, passed, attempts: attemptNo });
  return { totalCostUsd: acc.cost, totalTokens: acc.tokens, calls: acc.calls, passed };
}

// ---------------------------------------------------------------------------

interface StepResult {
  summary: string;
  success: boolean;
}

async function runStep(
  step: PlannedStep,
  policy: RoutingPolicy,
  rungDef: (typeof ESCALATION_LADDER)[number],
  deps: AgentDeps,
  toolCtx: ToolContext,
  priorSummaries: string[],
  emit: (e: AgentEvent) => void,
  logUsage: (r: CompletionResult, taskType: string) => UsageEntry,
  goal: string
): Promise<StepResult> {
  const r = routeOrBest(step.type, deps.models, policy, {
    promptTokens: step.estPromptTokens,
    completionTokens: step.estCompletionTokens,
  });
  if (!r) {
    emit({ type: "error", message: `No capable model for step ${step.id} (${step.type}).` });
    return { summary: "(no model)", success: false };
  }
  const model = r.model;
  emit({ type: "step-start", step, model, estCostUsd: r.estCostUsd });

  const messages: ChatMessage[] = [
    { role: "system", content: stepSystemPrompt(goal, step, priorSummaries, model.capabilities.tools) },
    { role: "user", content: step.description },
  ];
  const loop = await runToolLoop(model, messages, step.type, rungDef, deps, toolCtx, emit, logUsage);

  recordStepRun({
    sessionId: deps.sessionId,
    stepNo: step.id,
    taskType: step.type,
    skill: TASK_SKILL[step.type],
    model: model.id,
    provider: model.provider,
    iterations: loop.iterations,
    toolCalls: loop.toolCalls,
    promptTokens: loop.prompt,
    completionTokens: loop.completion,
    costUsd: loop.cost,
    finishedBy: loop.finishedBy,
    success: loop.success,
    durationMs: loop.durationMs,
  });

  const summary = loop.summary || "(no summary)";
  priorSummaries.push(`Step ${step.id} (${step.type}): ${summary}`);
  emit({ type: "step-end", step, summary });
  return { summary, success: loop.success };
}

async function runFix(
  goal: string,
  plan: Plan,
  verdict: Verdict,
  policy: RoutingPolicy,
  rungDef: (typeof ESCALATION_LADDER)[number],
  deps: AgentDeps,
  toolCtx: ToolContext,
  emit: (e: AgentEvent) => void,
  logUsage: (r: CompletionResult, taskType: string) => UsageEntry
): Promise<StepResult> {
  const r = routeOrBest("edit", deps.models, policy);
  if (!r) return { summary: "(no model)", success: false };
  const model = r.model;
  const fixStep: PlannedStep = {
    id: 100,
    type: "edit",
    description: "Fix the unmet acceptance criteria",
    estPromptTokens: 9000,
    estCompletionTokens: 1500,
  };
  emit({ type: "step-start", step: fixStep, model, estCostUsd: r.estCostUsd });

  const unmet = verdict.unmet.map((u, i) => `${i + 1}. ${u.criterion} — ${u.reason}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are the FIX stage of an autonomous coding agent (escalated model). The verify gate found unmet acceptance criteria; resolve them.
Overall goal: ${goal}
You may use the tools (read_file, write_file, list_dir, run_command). Inspect what's there, then make the changes. Call \`finish\` with a one-line summary when all listed criteria should now pass.
If you cannot call tools natively, reply with ONLY one JSON object per turn: {"name":"<tool>","arguments":{...}}`,
    },
    { role: "user", content: `Unmet criteria:\n${unmet}\n\nVerifier feedback: ${verdict.feedback}` },
  ];
  const loop = await runToolLoop(model, messages, "edit", rungDef, deps, toolCtx, emit, logUsage);

  recordStepRun({
    sessionId: deps.sessionId,
    stepNo: fixStep.id,
    taskType: "edit",
    skill: TASK_SKILL.edit,
    model: model.id,
    provider: model.provider,
    iterations: loop.iterations,
    toolCalls: loop.toolCalls,
    promptTokens: loop.prompt,
    completionTokens: loop.completion,
    costUsd: loop.cost,
    finishedBy: loop.finishedBy,
    success: loop.success,
    durationMs: loop.durationMs,
  });
  emit({ type: "step-end", step: fixStep, summary: loop.summary || "(fix pass)" });
  return { summary: loop.summary, success: loop.success };
}

interface LoopResult {
  summary: string;
  success: boolean;
  finishedBy: StepRunRow["finishedBy"];
  iterations: number;
  toolCalls: number;
  prompt: number;
  completion: number;
  cost: number;
  durationMs: number;
}

/** The shared tool-use loop (used by steps and the fix pass). */
async function runToolLoop(
  model: ModelInfo,
  messages: ChatMessage[],
  taskTypeForLog: string,
  rungDef: (typeof ESCALATION_LADDER)[number],
  deps: AgentDeps,
  toolCtx: ToolContext,
  emit: (e: AgentEvent) => void,
  logUsage: (r: CompletionResult, taskType: string) => UsageEntry
): Promise<LoopResult> {
  const useTools = model.capabilities.tools;
  const start = Date.now();
  let prompt = 0,
    completion = 0,
    cost = 0,
    toolCalls = 0,
    iterations = 0;
  let summary = "";
  let finishedBy: StepRunRow["finishedBy"] = "max-iters";

  try {
    for (let iter = 0; iter < rungDef.maxIters; iter++) {
      iterations = iter + 1;
      const gen = deps.client.stream(
        { model: model.id, messages, tools: useTools ? TOOL_SCHEMAS : undefined, temperature: 0.2, maxTokens: rungDef.maxTokens },
        model.pricing
      );
      let next = await gen.next();
      while (!next.done) {
        emit({ type: "text", delta: next.value });
        next = await gen.next();
      }
      const result = next.value;
      const entry = logUsage(result, taskTypeForLog);
      prompt += entry.promptTokens;
      completion += entry.completionTokens;
      cost += entry.costUsd;

      if (result.toolCalls.length && useTools) {
        messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        let finished = false;
        for (const tc of result.toolCalls) {
          toolCalls++;
          emit({ type: "tool-call", name: tc.function.name, args: tc.function.arguments });
          const outcome = executeTool(tc.function.name, tc.function.arguments, toolCtx);
          emit({ type: "tool-result", name: tc.function.name, result: outcome.result });
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: outcome.result });
          if (outcome.finishSummary != null) {
            summary = outcome.finishSummary;
            finished = true;
          }
        }
        if (finished) {
          finishedBy = "finish-tool";
          break;
        }
        continue;
      }

      // Non-native tool calling: parse a JSON tool call from the text.
      const textCall = useTools ? parseTextToolCall(result.content) : null;
      if (textCall) {
        toolCalls++;
        emit({ type: "tool-call", name: textCall.function.name, args: textCall.function.arguments });
        const outcome = executeTool(textCall.function.name, textCall.function.arguments, toolCtx);
        emit({ type: "tool-result", name: textCall.function.name, result: outcome.result });
        if (outcome.finishSummary != null) {
          summary = outcome.finishSummary;
          finishedBy = "finish-tool";
          break;
        }
        messages.push({ role: "assistant", content: result.content });
        messages.push({
          role: "user",
          content: `Tool ${textCall.function.name} returned:\n${outcome.result}\nContinue. When done, reply with ONLY {"name":"finish","arguments":{"summary":"<one line>"}}.`,
        });
        continue;
      }

      summary = result.content || summary;
      if (summary) finishedBy = "text";
      break;
    }
  } catch (err: any) {
    finishedBy = "error";
    emit({ type: "error", message: `${taskTypeForLog} failed: ${err?.message ?? err}` });
  }

  return {
    summary,
    success: finishedBy === "finish-tool" || finishedBy === "text",
    finishedBy,
    iterations,
    toolCalls,
    prompt,
    completion,
    cost,
    durationMs: Date.now() - start,
  };
}

function stepSystemPrompt(goal: string, step: PlannedStep, priorSummaries: string[], useTools: boolean): string {
  const context = priorSummaries.length ? `\n\nWhat previous steps accomplished:\n${priorSummaries.join("\n")}` : "";
  const toolNote = useTools
    ? `\nYou may use the provided tools (read_file, write_file, list_dir, run_command). Call the \`finish\` tool with a one-line summary when this step's objective is met.
If you cannot call tools natively, reply with ONLY one JSON object per turn, no prose: {"name":"<tool>","arguments":{...}}`
    : `\nReturn a concise result for this step. Do not ask the user questions.`;
  return `You are the "${step.type}" stage of an autonomous coding agent.
Overall goal: ${goal}
Your current step: ${step.description}${context}${toolNote}
Be efficient — you were selected as the most cost-effective capable model for this step.`;
}
