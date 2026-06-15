// Supervision loop: poly puts a project under supervision, hands an instruction to an
// external coding agent, reads the diff that agent produced, and recommends the next
// instruction. MANUAL mode runs one step and stops (the caller decides whether to apply
// the recommendation via runStep again). AUTO mode feeds each recommendation back to the
// worker until the goal is met or `maxRuns` is hit.
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { CompletionResult, ModelInfo } from "../providers/types.js";
import { getAdapter, runAgentProcess, type AgentAdapter, type AgentKind } from "./agents.js";
import { ensureRepo, snapshot, diffTrees, type DiffResult } from "./diff.js";
import { recommend, type Recommendation } from "./recommend.js";

export interface SuperviseStep {
  step: number;
  instruction: string;
  agent: { code: number | null; killed: boolean; killReason?: string; ms: number; output: string };
  diff: DiffResult;
  recommendation: Recommendation;
}

export type SuperviseEvent =
  | { type: "agent-start"; step: number; instruction: string; agent: string }
  | { type: "agent-done"; step: number; code: number | null; killed: boolean; ms: number }
  | { type: "diff"; step: number; diff: DiffResult }
  | { type: "recommendation"; step: number; rec: Recommendation }
  | { type: "agent-chunk"; step: number; chunk: string };

export interface SuperviseDeps {
  client: OpenRouterClient;
  recModel: ModelInfo; // model that powers the supervisor's recommendation
  onEvent?: (e: SuperviseEvent) => void;
  onUsage?: (r: CompletionResult) => void;
  idleMs?: number;
  maxMs?: number;
}

export interface SuperviseOptions {
  cwd: string;
  goal: string;
  agentKind: AgentKind;
  cmdTemplate?: string;
}

/** Run a SINGLE supervised step: launch the worker with `instruction`, diff, recommend. */
export async function runStep(
  opts: SuperviseOptions,
  instruction: string,
  step: number,
  deps: SuperviseDeps,
  adapter: AgentAdapter
): Promise<SuperviseStep> {
  ensureRepo(opts.cwd);
  const before = snapshot(opts.cwd);

  deps.onEvent?.({ type: "agent-start", step, instruction, agent: adapter.label });
  const spec = adapter.build(instruction);
  const run = await runAgentProcess(spec, {
    cwd: opts.cwd,
    idleMs: deps.idleMs,
    maxMs: deps.maxMs,
    onChunk: (chunk) => deps.onEvent?.({ type: "agent-chunk", step, chunk }),
  });
  deps.onEvent?.({ type: "agent-done", step, code: run.code, killed: run.killed, ms: run.ms });

  const after = snapshot(opts.cwd);
  const diff = diffTrees(opts.cwd, before, after);
  deps.onEvent?.({ type: "diff", step, diff });

  const rec = await recommend(
    { goal: opts.goal, lastInstruction: instruction, diff, agentOutput: run.output, step },
    { client: deps.client, model: deps.recModel, onUsage: deps.onUsage }
  );
  deps.onEvent?.({ type: "recommendation", step, rec });

  return {
    step,
    instruction,
    agent: { code: run.code, killed: run.killed, killReason: run.killReason, ms: run.ms, output: run.output },
    diff,
    recommendation: rec,
  };
}

export interface SuperviseResult {
  steps: SuperviseStep[];
  done: boolean;
  stoppedReason: "done" | "max-runs" | "manual";
}

/**
 * AUTO mode: run up to `maxRuns` supervised steps, feeding each recommendation back to
 * the worker as the next instruction, stopping early when the supervisor declares done.
 */
export async function runAuto(
  opts: SuperviseOptions,
  firstInstruction: string,
  maxRuns: number,
  deps: SuperviseDeps
): Promise<SuperviseResult> {
  const adapter = getAdapter(opts.agentKind, opts.cmdTemplate);
  if (!adapter.available) {
    throw new Error(
      adapter.kind === "cmd"
        ? "No --agent-cmd provided for the `cmd` agent."
        : `Agent "${adapter.bin}" not found on PATH. Install it or pass --agent cmd --agent-cmd "<command>".`
    );
  }
  const steps: SuperviseStep[] = [];
  let instruction = firstInstruction;
  for (let i = 1; i <= maxRuns; i++) {
    const s = await runStep(opts, instruction, i, deps, adapter);
    steps.push(s);
    if (s.recommendation.done) return { steps, done: true, stoppedReason: "done" };
    instruction = s.recommendation.nextInstruction || instruction;
  }
  return { steps, done: false, stoppedReason: "max-runs" };
}
