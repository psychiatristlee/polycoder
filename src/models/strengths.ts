import type { ModelInfo, Tier } from "../providers/types.js";
import type { TaskType } from "../planner/tasks.js";

/**
 * Models are not equally good at everything. A coding edit wants a coder-tuned /
 * agentic model (Claude, DeepSeek-Coder, Qwen-Coder, GPT, Codestral); hard logic
 * wants a reasoning model (o-series, DeepSeek-R1, *-thinking); searching/reading
 * wants a cheap long-context retrieval model (Gemini Flash, Haiku, small models).
 *
 * This module encodes per-family strengths so the router can optimize
 * *performance-per-dollar for the specific task* — the cheapest model that still
 * covers the required capability — instead of price alone.
 */
export type Skill = "coding" | "reasoning" | "retrieval" | "speed" | "general" | "vision";

interface StrengthRule {
  pattern: RegExp;
  skills: Partial<Record<Skill, number>>; // multiplier (>1 = notably strong)
}

// Higher = stronger. Matched against "<id> <name>" lowercased; the best matching
// bonus per skill wins (rules are not stacked).
const STRENGTH_RULES: StrengthRule[] = [
  // Anthropic — Claude Code's home turf: coding, agentic tool use, instruction following.
  { pattern: /claude.*(opus)/, skills: { coding: 1.7, reasoning: 1.5, general: 1.5 } },
  { pattern: /claude.*(sonnet)/, skills: { coding: 1.65, reasoning: 1.4, general: 1.45, vision: 1.3 } },
  { pattern: /claude.*(haiku)/, skills: { coding: 1.4, speed: 1.55, general: 1.15 } },
  // OpenAI
  { pattern: /\bo[1-4]\b|gpt-5.*(thinking|pro)|o[1-4]-(mini|pro)/, skills: { reasoning: 1.7, coding: 1.35 } },
  { pattern: /gpt-4o|gpt-4\.1|gpt-5/, skills: { coding: 1.45, reasoning: 1.3, general: 1.45, vision: 1.35 } },
  { pattern: /gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini|gpt-5-nano/, skills: { speed: 1.4, general: 1.1 } },
  // DeepSeek — strong cheap coding & reasoning.
  { pattern: /deepseek.*(r1|reasoner)/, skills: { reasoning: 1.75, coding: 1.4 } },
  { pattern: /deepseek.*(v3|chat|coder|v2)/, skills: { coding: 1.55, reasoning: 1.25 } },
  // Qwen
  { pattern: /qwen.*coder/, skills: { coding: 1.65 } },
  { pattern: /qwen.*(thinking|qwq)/, skills: { reasoning: 1.55, coding: 1.2 } },
  { pattern: /qwen(3|2\.5)?[-.]?(max|235b|72b|plus)/, skills: { coding: 1.3, reasoning: 1.3, general: 1.25 } },
  // Coding specialists
  { pattern: /codestral|codex|code-|coder|kimi/, skills: { coding: 1.55, reasoning: 1.2 } },
  // Google Gemini — long-context retrieval & cheap throughput.
  { pattern: /gemini.*(flash|lite)/, skills: { speed: 1.6, retrieval: 1.55, general: 1.15 } },
  { pattern: /gemini.*pro/, skills: { retrieval: 1.65, reasoning: 1.4, coding: 1.25, vision: 1.35 } },
  // xAI / Meta / Mistral
  { pattern: /grok-[3-9]/, skills: { reasoning: 1.4, coding: 1.3, general: 1.25 } },
  { pattern: /llama.*(405b|maverick|70b)/, skills: { general: 1.25, coding: 1.15 } },
  { pattern: /mistral-large|mixtral/, skills: { coding: 1.2, general: 1.2 } },
  // Small/fast families — strong at cheap throughput, not hard tasks.
  { pattern: /ministral|gemma|phi|nemotron-(nano|mini)|-(1|2|3|4)b\b|mini|nano|lite|small/, skills: { speed: 1.45 } },
];

/** Which skill each task type primarily exercises. */
export const TASK_SKILL: Record<TaskType, Skill> = {
  plan: "reasoning",
  search: "retrieval",
  read: "retrieval",
  edit: "coding",
  command: "speed",
  review: "reasoning",
  reason: "reasoning",
  verify: "reasoning",
  explain: "general",
  summarize: "speed",
  chat: "speed",
};

/**
 * "Reasoning-only" models (o-series, DeepSeek-R1, *-thinking, QwQ, Magistral, gpt-5-thinking).
 * They spend many tokens deliberating before answering — great for hard reasoning (plan / review /
 * reason / verify), but slow and no better at coding/retrieval, so they should NOT be routed to
 * simple edit / command / read / search tasks. The router uses this to keep them out of
 * non-reasoning task candidate sets (unless nothing else qualifies).
 */
export function isReasoningModel(id: string): boolean {
  return /(^|[/:_-])o[1-4]([-_.]|$)|thinking|qwq|reasoner|deepseek.*r1|[-_]r1([-_.:]|$)|magistral/i.test(id);
}

const TIER_BASE: Record<Tier, number> = { cheap: 1.0, standard: 1.4, frontier: 1.8 };

/** Family bonus for a skill (1.0 = no notable strength, >1 = strong). */
export function skillBonus(m: ModelInfo, skill: Skill): number {
  const s = `${m.id} ${m.name}`.toLowerCase();
  let bonus = 1.0;
  for (const rule of STRENGTH_RULES) {
    if (rule.pattern.test(s)) {
      const b = rule.skills[skill];
      if (b && b > bonus) bonus = b;
    }
  }
  return bonus;
}

/** Capability score of a model for a skill: tier baseline × best family bonus. */
export function strengthFor(m: ModelInfo, skill: Skill): number {
  return TIER_BASE[m.tier] * skillBonus(m, skill);
}

export function taskStrength(m: ModelInfo, taskType: TaskType): number {
  return strengthFor(m, TASK_SKILL[taskType]);
}

/**
 * Minimum strength a model must have to be trusted with a task even if its price
 * tier is low — this is how a cheap-but-coder-tuned model becomes eligible for an
 * `edit`, while a generic cheap model does not. Tasks not listed rely on the tier
 * floor alone (their minTier is already "cheap").
 */
export const TASK_MIN_STRENGTH: Partial<Record<TaskType, number>> = {
  edit: 1.4,
  review: 1.5,
  reason: 1.5,
  verify: 1.4,
  plan: 1.2,
};

/** Skills surfaced in the "strength by skill" recommendation view. */
export const HEADLINE_SKILLS: Skill[] = ["coding", "reasoning", "retrieval", "speed"];
