// The QUALITY stage: after a run finishes, an LLM judge inspects the delivered
// result with read-only tools and scores it on a rubric (correctness, completeness,
// code quality, UX/polish) plus an overall 0-100. Stored in the DB and reported each
// run, so quality — not just "did it build" — is tracked over time and per model.
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ChatMessage, CompletionResult, ModelInfo } from "../providers/types.js";
import { READONLY_TOOL_SCHEMAS, executeTool, parseTextToolCall, type ToolContext } from "./tools.js";
import { extractJson } from "../planner/planner.js";

export interface QualityScore {
  overall: number; // 0..100
  dims: {
    correctness: number; // 0..10
    completeness: number; // 0..10
    codeQuality: number; // 0..10
    uxPolish: number; // 0..10
    design?: number; // 0..10, from a vision judge on a rendered screenshot (UI tasks)
  };
  summary: string;
  judge: string; // model id that scored
  screenshot?: string; // path to the rendered screenshot the vision judge graded
  visionJudge?: string; // vision model id, when design was scored
}

const VISION_SYSTEM = `You are a senior product designer grading a rendered web UI from a SCREENSHOT. Be honest and calibrated — most quick AI-built pages are mediocre; reserve 9-10 for genuinely polished, production-grade design.
Score 0-10 each: visual_design (layout, spacing, hierarchy, balance), color (palette harmony, contrast/readability), polish (rounded cards, shadows, typography, finish), requirements_visible (how much of the asked-for content is actually visible & well-presented).
Then overall 0-100 (holistic design quality) and a 1-2 sentence critique citing what you SEE.
Reply with ONLY this JSON: {"visual_design":<0-10>,"color":<0-10>,"polish":<0-10>,"requirements_visible":<0-10>,"overall":<0-100>,"summary":"<what you see>"}`;

export interface VisionDesign {
  design: number; // 0..10 headline design score (= visual_design)
  color: number;
  polish: number;
  requirementsVisible: number;
  overall: number; // 0..100
  summary: string;
}

/** Grade UI design from a rendered screenshot using a vision-capable model. */
export async function scoreDesignVision(
  client: OpenRouterClient,
  model: ModelInfo,
  imageDataUrl: string,
  goal: string,
  onUsage?: (r: CompletionResult) => void
): Promise<VisionDesign | null> {
  try {
    const r = await client.visionComplete(
      model.id,
      {
        system: VISION_SYSTEM,
        user: `Goal of the page: ${goal}\n\nGrade the DESIGN of this rendered screenshot. Return ONLY the JSON.`,
        images: [imageDataUrl],
      },
      model.pricing,
      700
    );
    onUsage?.(r);
    const json = extractJson(r.content);
    if (!json) return null;
    const o = JSON.parse(json) as any;
    return {
      design: clamp(o.visual_design ?? o.design, 10),
      color: clamp(o.color, 10),
      polish: clamp(o.polish, 10),
      requirementsVisible: clamp(o.requirements_visible ?? o.requirementsVisible, 10),
      overall: Math.round(clamp(o.overall, 100)),
      summary: String(o.summary ?? "").slice(0, 400),
    };
  } catch {
    return null;
  }
}

export interface QualityEvents {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, result: string) => void;
  onUsage?: (r: CompletionResult) => void;
}

const QUALITY_MAX_ITERS = 5;

const QUALITY_SYSTEM = `You are the QUALITY SCORING stage of an autonomous coding agent. The work is done; your job is to grade the DELIVERED result, not to fix it.
Inspect the real workspace with the read-only tools (read_file, list_dir, run_command) — look at the actual files, structure, and (if relevant) build/test output. Be calibrated and honest; do not inflate.
Score these dimensions 0-10 each:
- correctness: does it actually work / do what was asked, no obvious bugs
- completeness: are all parts of the goal delivered (not partial)
- code_quality: structure, readability, idiomatic, no dead/duplicated code
- ux_polish: for UI, visual/interaction quality; for non-UI, output/API ergonomics and robustness
Then give overall 0-100 (holistic, weight correctness + completeness most) and a 1-2 sentence summary citing concrete evidence.
When done reply with ONLY this JSON (no prose, no code fence):
{"correctness":<0-10>,"completeness":<0-10>,"code_quality":<0-10>,"ux_polish":<0-10>,"overall":<0-100>,"summary":"<evidence>"}`;

export async function scoreQuality(
  goal: string,
  criteria: string[],
  deps: { client: OpenRouterClient; model: ModelInfo; cwd: string; allowCommands: boolean; allowWeb?: boolean },
  ev: QualityEvents = {}
): Promise<QualityScore | null> {
  const toolCtx: ToolContext = { cwd: deps.cwd, allowWrite: false, allowCommands: deps.allowCommands, allowWeb: deps.allowWeb ?? false };
  const useTools = deps.model.capabilities.tools;
  const messages: ChatMessage[] = [
    { role: "system", content: QUALITY_SYSTEM },
    {
      role: "user",
      content:
        `Goal: ${goal}\n\nAcceptance criteria:\n` +
        criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
        `\n\nInspect the delivered workspace, then return the score JSON.`,
    },
  ];

  for (let iter = 0; iter < QUALITY_MAX_ITERS; iter++) {
    const gen = deps.client.stream(
      { model: deps.model.id, messages, tools: useTools ? READONLY_TOOL_SCHEMAS : undefined, temperature: 0, maxTokens: 1200 },
      deps.model.pricing
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    const result = next.value;
    ev.onUsage?.(result);

    const parsed = parseScore(result.content, deps.model.id);
    if (parsed) return parsed;

    const calls = result.toolCalls.length
      ? result.toolCalls
      : useTools && parseTextToolCall(result.content)
      ? [parseTextToolCall(result.content)!]
      : [];
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
          messages.push({ role: "user", content: `Tool ${tc.function.name} returned:\n${outcome.result}\nContinue, then return the score JSON.` });
        }
      }
      continue;
    }
    messages.push({ role: "assistant", content: result.content });
    messages.push({ role: "user", content: `Return ONLY the score JSON now.` });
  }
  return null;
}

function clamp(n: unknown, max: number): number {
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return 0;
  return Math.min(max, Math.max(0, v));
}

function parseScore(text: string, judge: string): QualityScore | null {
  const json = extractJson(text);
  if (!json) return null;
  try {
    const o = JSON.parse(json) as any;
    if (o.overall == null && o.correctness == null) return null;
    const dims = {
      correctness: clamp(o.correctness, 10),
      completeness: clamp(o.completeness, 10),
      codeQuality: clamp(o.code_quality ?? o.codeQuality, 10),
      uxPolish: clamp(o.ux_polish ?? o.uxPolish, 10),
    };
    // Derive overall if missing/implausible from the dimensions.
    let overall = clamp(o.overall, 100);
    if (!overall) {
      overall = Math.round(
        ((dims.correctness * 0.35 + dims.completeness * 0.3 + dims.codeQuality * 0.2 + dims.uxPolish * 0.15) / 10) * 100
      );
    }
    return { overall: Math.round(overall), dims, summary: String(o.summary ?? "").slice(0, 400), judge };
  } catch {
    return null;
  }
}
