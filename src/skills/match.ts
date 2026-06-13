// Deterministic goal→skill matching. This runs on EVERY run before planning, so it
// must add ZERO model cost (the whole point of a skill is to SAVE tokens). We match
// purely on token overlap between the goal and the skill's name+description, with a
// small bonus when the classified goalType agrees.
import type { GoalType } from "../planner/tasks.js";
import type { Skill } from "./store.js";

// Generic verbs/nouns that don't help disambiguate which skill applies.
const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "this",
  "that", "is", "are", "be", "it", "as", "at", "by", "from", "into", "add", "make",
  "create", "use", "using", "new", "code", "file", "files", "function", "please",
  "help", "implement", "update", "change", "fix", "support", "via", "should",
]);

export function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

export interface SkillMatch {
  skill: Skill;
  score: number;
}

// Heuristic; raise to be stricter (fewer false reuses), lower to reuse more eagerly.
export const MATCH_THRESHOLD = 0.22;

/** Overlap of `goalTokens` with the skill's own tokens, blended Jaccard + coverage. */
export function scoreSkill(goalTokens: Set<string>, goalType: GoalType, skill: Skill): number {
  const skillTokens = tokenize(`${skill.name} ${skill.description}`);
  if (!skillTokens.size || !goalTokens.size) return 0;
  let shared = 0;
  for (const t of skillTokens) if (goalTokens.has(t)) shared++;
  if (!shared) return 0;
  const union = new Set([...goalTokens, ...skillTokens]).size;
  const jaccard = shared / union;
  const coverage = shared / skillTokens.size; // how much of the skill the goal covers
  let score = 0.5 * jaccard + 0.5 * coverage;
  if (skill.goalType === goalType) score += 0.12;
  return score;
}

/** Best skill for a goal, or null if nothing clears the threshold. */
export function matchSkill(goal: string, goalType: GoalType, skills: Skill[]): SkillMatch | null {
  const goalTokens = tokenize(goal);
  let best: SkillMatch | null = null;
  for (const skill of skills) {
    const score = scoreSkill(goalTokens, goalType, skill);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { skill, score };
  }
  return best;
}

/** Compact context block injected into the planner / step prompts. */
export function renderSkillForPrompt(skill: Skill): string {
  const body = skill.body.trim().slice(0, 1600);
  return `A reusable skill distilled from past VERIFIED successes matches this goal. Follow its proven approach where it fits — but adapt to the ACTUAL repository and don't follow it blindly.

### Skill: ${skill.name}
${skill.description}

${body}`;
}
