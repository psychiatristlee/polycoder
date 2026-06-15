// The "supervisor brain": given the goal, the last instruction, the diff the external
// agent produced, and its console output, poly judges whether the change advances the
// goal and proposes the NEXT instruction (or declares done). One cheap LLM call per step
// — the expensive editing is done by the supervised agent, poly only steers.
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { CompletionResult, ModelInfo } from "../providers/types.js";
import { extractJson } from "../planner/planner.js";
import type { DiffResult } from "./diff.js";

const SYSTEM = `You are a SUPERVISOR overseeing another coding agent. You do not edit code yourself.
Given a GOAL, the instruction just given to the worker agent, the DIFF it produced, and its console output, judge progress and decide the next move.
Be strict: an empty/irrelevant diff, a build break, or drift from the goal is NOT progress.
Return ONLY minified JSON:
{"summary":"<1-2 sentences: what the agent actually changed>","aligned":true|false,"done":true|false,"progress":0-100,"concerns":["<issue>","..."],"nextInstruction":"<the single concrete instruction to give the worker next; empty string if done>"}
Rules:
- "done" only when the goal is fully met and you have no further instruction.
- "nextInstruction" must be ONE actionable instruction for the worker, phrased as a direct command. If the last diff was empty or wrong, tell it specifically what to do/fix.
- Keep "nextInstruction" self-contained (the worker has no memory of prior turns).`;

export interface Recommendation {
  summary: string;
  aligned: boolean;
  done: boolean;
  progress: number;
  concerns: string[];
  nextInstruction: string;
  /** True when this came from the heuristic fallback (no/failed LLM call). */
  heuristic?: boolean;
}

export interface RecommendInput {
  goal: string;
  lastInstruction: string;
  diff: DiffResult;
  agentOutput: string;
  step: number;
}

function clampProgress(n: any): number {
  const v = typeof n === "number" ? n : parseInt(String(n), 10);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 0;
}

/** Deterministic fallback when no model is available or the LLM call fails. */
export function heuristicRecommendation(input: RecommendInput): Recommendation {
  if (input.diff.empty) {
    return {
      summary: "The agent produced no file changes.",
      aligned: false,
      done: false,
      progress: 0,
      concerns: ["Empty diff — the agent may have stalled, asked for input, or misread the task."],
      nextInstruction: `Make concrete edits to accomplish: ${input.goal}. Start by changing the most relevant file.`,
      heuristic: true,
    };
  }
  return {
    summary: `Agent changed ${input.diff.filesChanged} file(s) (+${input.diff.insertions}/-${input.diff.deletions}).`,
    aligned: true,
    done: false,
    progress: Math.min(80, 20 + input.step * 20),
    concerns: [],
    nextInstruction: `Continue toward the goal: ${input.goal}. Verify the build/tests pass and address anything incomplete.`,
    heuristic: true,
  };
}

export async function recommend(
  input: RecommendInput,
  deps: { client: OpenRouterClient; model: ModelInfo; onUsage?: (r: CompletionResult) => void }
): Promise<Recommendation> {
  const user = [
    `GOAL:\n${input.goal}`,
    `\nINSTRUCTION GIVEN TO WORKER (step ${input.step}):\n${input.lastInstruction}`,
    `\nDIFF SUMMARY: ${input.diff.empty ? "(no changes)" : input.diff.stat}`,
    `\nDIFF:\n${input.diff.patch || "(none)"}`,
    `\nWORKER CONSOLE OUTPUT (tail):\n${input.agentOutput.slice(-4000) || "(none)"}`,
  ].join("\n");
  try {
    const r = await deps.client.complete(
      {
        model: deps.model.id,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0.1,
        maxTokens: 700,
      },
      deps.model.pricing
    );
    deps.onUsage?.(r);
    const json = extractJson(r.content);
    if (json) {
      const o = JSON.parse(json) as any;
      const rec: Recommendation = {
        summary: String(o.summary ?? "").slice(0, 600),
        aligned: !!o.aligned,
        done: !!o.done,
        progress: clampProgress(o.progress),
        concerns: Array.isArray(o.concerns) ? o.concerns.map((x: any) => String(x).slice(0, 200)).slice(0, 6) : [],
        nextInstruction: String(o.nextInstruction ?? "").slice(0, 1000),
        heuristic: false,
      };
      // A "not done" verdict with no next instruction is unusable — fall back.
      if (!rec.done && !rec.nextInstruction.trim()) rec.nextInstruction = heuristicRecommendation(input).nextInstruction;
      if (rec.summary) return rec;
    }
  } catch {
    /* fall through to heuristic */
  }
  return heuristicRecommendation(input);
}
