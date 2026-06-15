import fs from "node:fs";
import path from "node:path";
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ChatMessage, CompletionResult, ModelInfo } from "../providers/types.js";
import {
  type RoutingPolicy,
  ESCALATION_LADDER,
  applyRung,
  rungForTier,
} from "../router/policy.js";
import { route, routeOrBest, rankedCandidates } from "../router/router.js";
import { planRequest, heuristicPlan, classifyGoalType } from "../planner/planner.js";
import type { Plan, PlannedStep } from "../planner/tasks.js";
import { TOOL_SCHEMAS, executeTool, parseTextToolCall, type ToolContext, type ToolOutcome } from "./tools.js";
import { verifyGoal, type Verdict } from "./verify.js";
import { diagnose, remediate } from "./heal.js";
import { scoreQuality, scoreDesignVision } from "./quality.js";
import { renderScreenshot, pngDataUrl } from "./render.js";
import { listSkills, saveSkill, type Skill } from "../skills/store.js";
import { matchSkill, renderSkillForPrompt } from "../skills/match.js";
import { distill, heuristicSkill, saveOrReinforce } from "../skills/distill.js";
import { logCompletion } from "../usage/logger.js";
import {
  startSession,
  finishSession,
  recordStepRun,
  recordAttempt,
  recordQuality,
  optimalStartTier,
  type UsageEntry,
  type StepRunRow,
} from "../usage/db.js";
import { TASK_SKILL, taskStrength } from "../models/strengths.js";

export type AgentEvent =
  | { type: "plan"; plan: Plan; planModel: string }
  | { type: "skill-applied"; name: string; description: string; score: number }
  | { type: "skill-saved"; name: string; isNew: boolean; description: string }
  | { type: "criteria"; goalType: string; criteria: string[]; startTier: string; learned: boolean }
  | { type: "step-start"; step: PlannedStep; model: ModelInfo; estCostUsd: number; explored?: boolean }
  | { type: "text"; delta: string }
  | { type: "tool-call"; name: string; args: string }
  | { type: "tool-result"; name: string; result: string }
  | { type: "question"; question: string; options: string[] }
  | { type: "usage"; entry: UsageEntry }
  | { type: "step-end"; step: PlannedStep; summary: string }
  | { type: "verify-start"; model: string; attempt: number }
  | { type: "verdict"; attempt: number; metCount: number; total: number; allMet: boolean; unmet: { criterion: string; reason: string }[] }
  | { type: "quality"; overall: number; dims: { correctness: number; completeness: number; codeQuality: number; uxPolish: number; design?: number }; summary: string; judge: string; screenshot?: string }
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
  /** Allow web_search + web_fetch (network egress) during the run. */
  allowWeb?: boolean;
  /** Verify the result against acceptance criteria and escalate on failure (default true). */
  verify?: boolean;
  /** Max coding+verify attempts before giving up (default 3). */
  maxAttempts?: number;
  /** Reuse + distill reusable skill playbooks (default true). */
  skills?: boolean;
  /** Score the delivered result's quality with an LLM judge at the end (default true). */
  quality?: boolean;
  /** Interactive clarifier: when the agent calls ask_user, resolve the chosen option. */
  ask?: (question: string, options: string[]) => Promise<string>;
}

/** Handle the ask_user tool: surface the question + options, await the user's choice. */
async function handleAskUser(
  argsJson: string,
  deps: AgentDeps,
  emit: (e: AgentEvent) => void
): Promise<ToolOutcome> {
  let question = "";
  let options: string[] = [];
  try {
    const a = JSON.parse(argsJson || "{}");
    question = String(a.question ?? "");
    options = Array.isArray(a.options) ? a.options.map((o: any) => String(o)) : [];
  } catch {
    /* keep defaults */
  }
  // Only surface a question when there's an interactive resolver. Under --no-ask (deps.ask
  // undefined) the model may still emit a TEXT ask_user call; we must NOT emit a question event
  // (autonomous) and instead tell it to proceed.
  if (deps.ask) {
    emit({ type: "question", question, options });
    try {
      const answer = await deps.ask(question, options);
      return { result: `The user chose: ${answer}. Proceed accordingly.` };
    } catch {
      /* fall through */
    }
  }
  return { result: "No interactive user is available. Proceed with the most reasonable default and clearly state the assumption you made — do NOT ask again." };
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

// Detect a JS/TS project in `dir` (framework + router + scripts) from its package.json.
function detectProject(dir: string): string | null {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    let fw = "Node";
    if (deps.next) fw = "Next.js";
    else if (deps.vite) fw = "Vite";
    else if (deps["react-scripts"]) fw = "Create React App";
    else if (deps.react) fw = "React";
    else if (deps.express || deps.fastify || deps.koa) fw = "Node server";
    let router = "";
    if (fw === "Next.js") router = fs.existsSync(path.join(dir, "app")) ? " (App Router — app/)" : fs.existsSync(path.join(dir, "pages")) ? " (Pages Router — pages/)" : "";
    const scripts = Object.keys(pkg.scripts || {}).join(", ");
    return `${fw}${router}${scripts ? ` · scripts: ${scripts}` : ""}`;
  } catch {
    return null;
  }
}

// A cheap, bounded snapshot of the working directory injected into the planner + step prompts so
// the agent knows what already exists (empty → scaffold in place; existing project → work within
// it / cd into the right subdir) instead of planning blind and re-scaffolding. Recomputed per use.
function dirSnapshot(cwd: string): string | undefined {
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((d) => !d.name.startsWith(".") || d.name === ".env" || d.name === ".gitignore")
      .slice(0, 50)
      .map((d) => (d.isDirectory() ? d.name + "/" : d.name))
      .sort();
    if (!entries.length) {
      return "WORKING DIRECTORY is EMPTY. Scaffold the project IN PLACE here (e.g. `npx --yes create-next-app@latest . --ts --eslint --app --tailwind --use-npm --no-src-dir --no-import-alias --yes`) so later build/edit commands land in the right place.";
    }
    const here = detectProject(cwd);
    let note = "";
    if (here) {
      note = `\nA ${here} project ALREADY EXISTS in the working directory. Work WITHIN it — do NOT scaffold a new project (re-running create-* fails with "directory not empty"). Edit the existing files and run build/test from here.`;
    } else {
      for (const e of entries.filter((x) => x.endsWith("/")).map((x) => x.slice(0, -1))) {
        const sub = detectProject(path.join(cwd, e));
        if (sub) { note = `\nThe project lives in the subdirectory ./${e} (a ${sub} project); the working directory itself has no package.json. Prefix every command with \`cd ${e} && …\` and target files under ${e}/.`; break; }
      }
    }
    return `WORKING DIRECTORY contents (the agent's FIXED --cwd; read_file/write_file/list_dir paths are relative to it):\n${entries.join("  ")}${note}`;
  } catch {
    return undefined;
  }
}
const mergeCtx = (...parts: (string | undefined)[]) => parts.filter(Boolean).join("\n\n") || undefined;

export async function runAgent(
  goal: string,
  deps: AgentDeps,
  emit: (e: AgentEvent) => void
): Promise<{ totalCostUsd: number; totalTokens: number; calls: number; passed: boolean | null }> {
  const { client, models, cwd } = deps;
  const verifyOn = deps.verify ?? true;
  const skillsOn = deps.skills ?? true;
  const maxAttempts = deps.maxAttempts ?? 3;
  const acc: Acc = { cost: 0, tokens: 0, prompt: 0, completion: 0, calls: 0 };
  const sessionStart = Date.now();
  const toolCtx: ToolContext = { cwd, allowWrite: deps.allowWrite, allowCommands: deps.allowCommands, allowWeb: deps.allowWeb ?? false };

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

  // 0) Skill recall: replay a proven playbook for similar goals (free, deterministic
  //    match — no model cost) so the agent skips re-deriving an approach. Matched here,
  //    BEFORE planning, so it can bias the plan too. Reuse is recorded immediately.
  let appliedSkill: Skill | null = null;
  let skillContext: string | undefined;
  if (skillsOn) {
    try {
      const all = listSkills();
      const m = all.length ? matchSkill(goal, classifyGoalType(goal), all) : null;
      if (m) {
        appliedSkill = m.skill;
        skillContext = renderSkillForPrompt(appliedSkill);
        emit({ type: "skill-applied", name: appliedSkill.name, description: appliedSkill.description, score: m.score });
        try {
          saveSkill({ ...appliedSkill, uses: appliedSkill.uses + 1, updatedAt: new Date().toISOString() });
        } catch {
          /* recording reuse is best-effort */
        }
      }
    } catch {
      appliedSkill = null;
    }
  }

  // 1) Plan (+ goal type + acceptance criteria).
  const planRoute = route("plan", models, deps.policy);
  let plan: Plan;
  if (planRoute) {
    try {
      plan = await planRequest(goal, client, planRoute.model, (r) => logUsage(r, "plan"), mergeCtx(skillContext, dirSnapshot(cwd)));
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
        const res = await runStep(step, rungPolicy, rungDef, deps, toolCtx, priorSummaries, emit, logUsage, goal, skillContext);
        if (res.success) completedSteps++;
        else failedSteps++;
      }
    } else {
      // Re-attempt: a focused fix pass driven by the verifier's feedback. Recorded in
      // step_runs + the attempts table; it is NOT a plan step, so it must not mutate the
      // session plan-step counters (would inflate completed_steps beyond plannedSteps).
      await runFix(goal, plan, verdict!, rungPolicy, rungDef, deps, toolCtx, emit, logUsage, skillContext);
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
    verdict = await verifyGoal(goal, plan.criteria, { client, model: verifier.model, cwd, allowCommands: deps.allowCommands, allowWeb: deps.allowWeb }, {
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

  // Learn: distill a VERIFIED success into a reusable skill (or reinforce a matching
  // one). Gated on verify so we only learn from approaches we KNOW worked. Best-effort
  // and uses the cheapest capable model — its tokens are logged into this session.
  if (skillsOn && verifyOn && verdict?.allMet) {
    try {
      const distillRoute = route("summarize", models, deps.policy);
      const distilled = distillRoute
        ? await distill(goal, plan, priorSummaries, {
            client,
            model: distillRoute.model,
            onUsage: (r) => logUsage(r, "summarize"),
          })
        : heuristicSkill(goal, plan, priorSummaries);
      const res = saveOrReinforce(distilled, {
        goalType: plan.goalType,
        tools: deps.allowWrite || deps.allowCommands,
        costUsd: acc.cost,
        now: new Date().toISOString(),
      });
      emit({ type: "skill-saved", name: res.skill.name, isNew: res.isNew, description: res.skill.description });
    } catch {
      /* learning is best-effort; never break a run */
    }
  }

  // QUALITY: grade the delivered result every run (correctness/completeness/code/UX),
  // report it, and persist to the DB — so quality, not just pass/fail, is tracked per
  // model over time. Best-effort; one extra judge call (logged into this session).
  if (deps.quality !== false) {
    try {
      const judge = routeOrBest("review", models, { ...deps.policy, objective: "quality", tierFloor: "standard" });
      if (judge) {
        const q = await scoreQuality(
          goal,
          plan.criteria,
          { client, model: judge.model, cwd, allowCommands: deps.allowCommands, allowWeb: deps.allowWeb },
          {
            onToolCall: (name, args) => emit({ type: "tool-call", name, args }),
            onToolResult: (name, result) => emit({ type: "tool-result", name, result }),
            onUsage: (r) => logUsage(r, "review"),
          }
        );
        if (q) {
          // Vision augmentation: if this is a runnable web app, render it, screenshot,
          // and let a vision model grade the actual DESIGN — then blend into the score.
          try {
            const render = await renderScreenshot(cwd);
            if (render) {
              const dataUrl = pngDataUrl(render.screenshotPath);
              const visionModel =
                (judge.model.capabilities.vision ? judge.model : undefined) ??
                models.find((m) => m.capabilities.vision && !m.id.startsWith("local/")) ??
                models.find((m) => m.capabilities.vision);
              if (dataUrl && visionModel) {
                const vd = await scoreDesignVision(client, visionModel, dataUrl, goal, (r) => logUsage(r, "review"));
                if (vd) {
                  q.dims.design = vd.design;
                  q.dims.uxPolish = Math.round((q.dims.uxPolish + vd.polish) / 2);
                  q.overall = Math.round(q.overall * 0.6 + vd.overall * 0.4);
                  q.screenshot = render.screenshotPath;
                  q.visionJudge = visionModel.id;
                  q.summary = `${q.summary} | design: ${vd.summary}`.slice(0, 500);
                }
              }
            }
          } catch {
            /* vision design scoring is best-effort */
          }
          emit({ type: "quality", overall: q.overall, dims: q.dims, summary: q.summary, judge: q.judge, screenshot: q.screenshot });
          try {
            recordQuality(deps.sessionId, q);
          } catch {
            /* persistence best-effort */
          }
        }
      }
    } catch {
      /* quality scoring must never break a run */
    }
  }

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
  goal: string,
  skillContext?: string
): Promise<StepResult> {
  const est = { promptTokens: step.estPromptTokens, completionTokens: step.estCompletionTokens };
  const eligible = rankedCandidates(step.type, deps.models, policy, est); // best-value first, never empty
  if (!eligible.length) {
    emit({ type: "error", message: `No capable model for step ${step.id} (${step.type}).` });
    return { summary: "(no model)", success: false };
  }
  const explore = route(step.type, deps.models, policy, est);
  const strengthOf = (m: ModelInfo): number => taskStrength(m, step.type);
  const tried = new Set<string>();
  const localOnly = deps.models.every((m) => m.id.startsWith("local/"));
  let next: ModelInfo | undefined = explore?.explored && explore.model ? explore.model : eligible[0];

  let loop: LoopResult | null = null;
  for (let i = 0; i < 6 && next; i++) {
    const model: ModelInfo = next;
    tried.add(model.id);
    emit({ type: "step-start", step, model, estCostUsd: 0, explored: i === 0 && !!explore?.explored });
    const messages: ChatMessage[] = [
      { role: "system", content: stepSystemPrompt(goal, step, priorSummaries, model.capabilities.tools, deps.ask != null, mergeCtx(skillContext, dirSnapshot(toolCtx.cwd))) },
      { role: "user", content: step.description },
    ];
    loop = await runToolLoop(model, messages, step.type, rungDef, deps, toolCtx, emit, logUsage);
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
    if (loop.success || loop.finishedBy !== "error") break; // only a hard model error triggers a switch

    // Pick the next model by WHY it failed. Default: escalate UP to the strongest untried
    // model. Only when the model couldn't LOAD (out of memory) does a bigger model make no
    // sense → step down to the largest one that still fits.
    const pool: ModelInfo[] = eligible.filter((m) => !tried.has(m.id));
    const msg: string = (loop.errorMessage || "").toLowerCase();
    const resource = /memory|vram|\bram\b|oom|cudamalloc|error loading model|failed to load|llama_model_loader|llama-server|llama runner|terminated/.test(msg);
    let pick: ModelInfo | undefined;
    if (resource) {
      const smaller = pool.filter((m) => strengthOf(m) < strengthOf(model)).sort((a, b) => strengthOf(b) - strengthOf(a));
      pick = smaller[0];
      if (pick) emit({ type: "error", message: `↻ 메모리/로드 실패 → 더 작은 모델로 전환: ${pick.id}` });
    } else {
      const stronger = pool.filter((m) => strengthOf(m) > strengthOf(model)).sort((a, b) => strengthOf(a) - strengthOf(b));
      pick = stronger[0] || pool.sort((a, b) => strengthOf(b) - strengthOf(a))[0];
      if (pick) emit({ type: "error", message: `↻ 실패 → 더 ${stronger.length ? "강한" : "다른"} 모델로 전환: ${pick.id}` });
    }
    next = pick; // undefined → loop ends (no models left to try)
  }

  // Exhausted every available model and still failing → final, actionable error. With only
  // local models (no key, by design), point the user at a remote LLM (the subagent: a bigger
  // model on another machine) instead of silently giving up.
  if (loop && !loop.success && loop.finishedBy === "error") {
    emit({
      type: "error",
      message: localOnly
        ? "⛔ 설치된 로컬 모델(가장 강한 것까지)로 이 단계를 끝내지 못했습니다. 더 큰 원격 LLM을 연결하세요 — 다른 GPU 머신에서 `poly subagent serve` 후 이 컴퓨터에서 `poly subagent link` (또는 OpenRouter 키)."
        : "⛔ 사용 가능한 모델들로 이 단계를 끝내지 못했습니다. 더 강한 모델(상위 티어/프론티어)을 허용하거나 원격 LLM을 연결하세요.",
    });
  }

  const summary = loop!.summary || "(no summary)";
  priorSummaries.push(`Step ${step.id} (${step.type}): ${summary}`);
  emit({ type: "step-end", step, summary });
  return { summary, success: loop!.success };
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
  logUsage: (r: CompletionResult, taskType: string) => UsageEntry,
  skillContext?: string
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
  emit({ type: "step-start", step: fixStep, model, estCostUsd: r.estCostUsd, explored: r.explored });

  const unmet = verdict.unmet.map((u, i) => `${i + 1}. ${u.criterion} — ${u.reason}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are the FIX stage of an autonomous coding agent (escalated model). The verify gate found unmet acceptance criteria; resolve them so the ORIGINAL intent is fully achieved.
Overall goal: ${goal}
Tools: read_file, write_file, list_dir, run_command, web_search, web_fetch, finish. Inspect what's there, then make the changes.
- SELF-UNBLOCK: if something is missing or failing, install it, write a helper script, or web_search the fix — don't stop until the criteria pass.
- web_search/web_fetch if you need the concrete/correct approach.
Call \`finish\` with a one-line summary when all listed criteria should now pass.
If you cannot call tools natively, reply with ONLY one JSON object per turn: {"name":"<tool>","arguments":{...}}${skillContext ? `\n\n${skillContext}` : ""}`,
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
  errorMessage?: string; // raw error (when finishedBy === "error") — used to pick the next model
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
  let useTools = model.capabilities.tools; // may flip off if the model rejects tools at runtime
  let forceTextTools = false; // model rejected native tools → parse tool calls from its text
  const start = Date.now();
  let prompt = 0,
    completion = 0,
    cost = 0,
    toolCalls = 0,
    iterations = 0;
  let summary = "";
  let finishedBy: StepRunRow["finishedBy"] = "max-iters";
  let errorMessage: string | undefined;
  let healUsed = 0;
  const MAX_HEAL = 3;

  // One streamed model turn, with self-heal: on failure, diagnose the cause and (if it's
  // auto-fixable) remediate + retry the SAME turn, emitting why+fix so the user sees it.
  const streamTurn = async (): Promise<CompletionResult> => {
    while (true) {
      try {
        const gen = deps.client.stream(
          { model: model.id, messages, tools: useTools ? (deps.ask ? TOOL_SCHEMAS : TOOL_SCHEMAS.filter((t) => t.function?.name !== "ask_user")) : undefined, temperature: 0.2, maxTokens: rungDef.maxTokens },
          model.pricing
        );
        let next = await gen.next();
        while (!next.done) {
          emit({ type: "text", delta: next.value });
          next = await gen.next();
        }
        return next.value;
      } catch (err: any) {
        const raw = err?.message ?? String(err);
        // The model can't do native tool calls → drop tools and retry with text-based tool
        // calling (the loop parses a JSON tool call from the reply). No 400, no model switch.
        if (useTools && /does not support tools|tools.*not supported|tool use is not|function calling/i.test(raw)) {
          useTools = false;
          forceTextTools = true; // keep doing tools, just parse them from text instead of native
          emit({ type: "error", message: `ℹ ${model.id}는 네이티브 도구 미지원 — 텍스트 기반 도구 호출로 전환합니다.` });
          continue;
        }
        const d = diagnose(raw, model.id);
        if (d && d.retryable && d.action && healUsed < MAX_HEAL) {
          healUsed++;
          emit({ type: "error", message: `⚠ 원인: ${d.cause} → 자동 수정 중: ${d.fix}…` });
          const fixed = await remediate(d);
          if (fixed) {
            emit({ type: "error", message: `✓ 수정 적용 — 재시도합니다 (${healUsed}/${MAX_HEAL}).` });
            continue; // retry the turn
          }
          emit({ type: "error", message: `자동 수정 실패 — ${d.fix}` });
        }
        throw err; // not auto-fixable (or out of budget) → outer catch enriches + records
      }
    }
  };

  try {
    for (let iter = 0; iter < rungDef.maxIters; iter++) {
      iterations = iter + 1;
      const result = await streamTurn();
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
          const outcome =
            tc.function.name === "ask_user"
              ? await handleAskUser(tc.function.arguments, deps, emit)
              : await executeTool(tc.function.name, tc.function.arguments, toolCtx);
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
      const textCall = useTools || forceTextTools ? parseTextToolCall(result.content) : null;
      if (textCall) {
        toolCalls++;
        emit({ type: "tool-call", name: textCall.function.name, args: textCall.function.arguments });
        const outcome =
          textCall.function.name === "ask_user"
            ? await handleAskUser(textCall.function.arguments, deps, emit)
            : await executeTool(textCall.function.name, textCall.function.arguments, toolCtx);
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
    const raw: string = err?.message ?? String(err);
    errorMessage = raw;
    const d = diagnose(raw, model.id);
    emit({
      type: "error",
      message: d
        ? `${taskTypeForLog} 실패 — 원인: ${d.cause} · 해결: ${d.fix}`
        : `${taskTypeForLog} failed: ${raw}`,
    });
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
    errorMessage,
  };
}

function stepSystemPrompt(
  goal: string,
  step: PlannedStep,
  priorSummaries: string[],
  useTools: boolean,
  askEnabled: boolean,
  skillContext?: string
): string {
  const context = priorSummaries.length ? `\n\nWhat previous steps accomplished:\n${priorSummaries.join("\n")}` : "";
  const skill = skillContext ? `\n\n${skillContext}` : "";
  const toolNote = useTools
    ? `\nTools: read_file, write_file, list_dir, run_command, web_search, web_fetch${askEnabled ? ", ask_user" : ""}, finish.
- RESEARCH FIRST when unsure: if the approach is unclear or needs current/specific knowledge, web_search/web_fetch to make it concrete before implementing.
- SELF-UNBLOCK: if you hit a blocker (missing library, tool, command, or info), do NOT give up — install it (run_command), write a small helper script/tool, or search for the fix, then use it to continue. Build whatever you need to finish the task.
${askEnabled
  ? "- ASK ONLY WHEN AMBIGUOUS: if there's a genuine fork you cannot resolve from context, call ask_user with 2-4 concrete options; otherwise proceed with sensible defaults."
  : "- AUTONOMOUS — NEVER ASK: there is no interactive user. NEVER wait for permission or clarification. Always pick the most sensible default, state the assumption briefly, and keep going until the goal is fully done."}
- COMMANDS MUST BE NON-INTERACTIVE: pass flags so scaffolders don't prompt (e.g. \`npx --yes create-next-app@latest <name> --ts --eslint --app --tailwind --use-npm --no-src-dir --no-import-alias --yes\`). A command that waits for input will be killed.
- WORKING DIRECTORY IS FIXED: every run_command starts in the SAME --cwd; \`cd\` does NOT persist between commands and there is no cd tool. To act in a subfolder, chain it in ONE command: \`cd <dir> && <command>\` (Windows: \`cd /d <dir> && <command>\`). Likewise read_file/write_file/list_dir paths are relative to that fixed cwd.
- SCAFFOLD IN PLACE: prefer creating the project in the CURRENT directory — \`create-next-app .\` when the cwd is empty — so later \`npm run build\`/edits land in the right place. If a subdir already contains the project, run all later commands as \`cd <dir> && …\`. Check with list_dir before scaffolding; if the project already exists, do NOT scaffold again (re-running create-next-app errors with "directory not empty").
- NEVER run a dev server as a step: \`npm run dev\`/\`next dev\`/\`vite\`/\`serve\` never exit. To VERIFY the app, run \`npm run build\` (and \`npm test\` if present), not the dev server.
- ONE project only, in ONE directory. Respect its router — App Router uses \`app/\`, Pages Router uses \`pages/\`; never mix the two (don't add \`pages/\` files to an \`app/\` project).
- Call \`finish\` with a one-line summary when the objective is truly met.
If you cannot call tools natively, reply with ONLY one JSON object per turn, no prose: {"name":"<tool>","arguments":{...}}`
    : `\nReturn a concise result for this step.`;
  return `You are the "${step.type}" stage of an autonomous coding agent.
Overall goal: ${goal}
Your current step: ${step.description}${context}${skill}${toolNote}
Be efficient — you were selected as the most cost-effective capable model for this step.`;
}
