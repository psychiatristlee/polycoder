import type { ModelInfo } from "../providers/types.js";
import { TASK_SPECS, type TaskType } from "../planner/tasks.js";
import { blendedPrice, tierAtLeast, tierRank, type RoutingPolicy } from "./policy.js";
import { taskStrength, TASK_MIN_STRENGTH, TASK_SKILL, isReasoningModel } from "../models/strengths.js";
import type { Tier } from "../providers/types.js";
import { findModel } from "../models/parse.js";

export interface TokenEstimate {
  promptTokens: number;
  completionTokens: number;
}

export interface RouteResult {
  model: ModelInfo;
  reason: string;
  estCostUsd: number;
  /** true when this pick was an epsilon-greedy exploration, not the top route. */
  explored?: boolean;
}

/**
 * Pick a non-top candidate to SAMPLE (exploration). Biases toward models we have no
 * learned insight for yet (under-explored), within a plausible band of the ranking so
 * we don't waste a run on an obviously-bad pick.
 */
function pickExploration(ranked: ModelInfo[], policy: RoutingPolicy, taskType: TaskType): ModelInfo {
  const band = ranked.slice(1, 8); // skip the exploit pick; stay near the top
  if (!band.length) return ranked[0];
  const novel = band.filter((m) => policy.empirical?.[`${taskType}:${m.id}`] == null);
  const pool = novel.length ? novel : band;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function projectCost(m: ModelInfo, est: TokenEstimate): number {
  return (
    (est.promptTokens / 1_000_000) * m.pricing.promptUsdPerMTok +
    (est.completionTokens / 1_000_000) * m.pricing.completionUsdPerMTok
  );
}

/** Strength-per-dollar for a specific task — the core "performance/cost" metric. */
export function taskValue(m: ModelInfo, taskType: TaskType, empirical?: Record<string, number>): number {
  const base = taskStrength(m, taskType) / Math.max(blendedPrice(m), 0.01);
  // Learned routing: a model PROVEN notably token-efficient on this task (from the
  // local playbook) gets boosted proportionally to its measured savings, capped 2×.
  const savings = empirical?.[`${taskType}:${m.id}`];
  const boost = savings ? 1 + Math.min(savings, 100) / 100 : 1;
  return base * boost;
}

/**
 * Models that can actually serve this task type. A model qualifies if it meets the
 * task's price tier OR is strong enough at the task's skill to cover it — so a
 * cheap, coder-tuned model becomes eligible for an `edit` even below the tier floor.
 */
export function candidatesFor(
  taskType: TaskType,
  models: ModelInfo[],
  policy: RoutingPolicy,
  est?: TokenEstimate
): ModelInfo[] {
  const spec = TASK_SPECS[taskType];
  const strengthFloor = TASK_MIN_STRENGTH[taskType] ?? 0;
  // Effective floor is the higher of the task's own floor and any escalation floor.
  const minTier: Tier =
    policy.tierFloor && tierRank(policy.tierFloor) > tierRank(spec.minTier) ? policy.tierFloor : spec.minTier;
  const eligible = models.filter((m) => {
    if (m.id === "openrouter/auto") return false;
    // Route to cloud only (user has a key and wants the stronger models).
    if (policy.excludeLocal && m.id.startsWith("local/")) return false;
    // Drop unreliable $0 cloud (free-tier) models when asked; keep local $0 models.
    if (policy.excludeFree && !m.id.startsWith("local/") && blendedPrice(m) <= 0) return false;
    // The strength-floor bypass only applies when not escalating past the task's own floor.
    const covers =
      tierAtLeast(m.tier, minTier) ||
      (!policy.tierFloor && taskStrength(m, taskType) >= strengthFloor);
    if (!covers) return false;
    if (spec.needsTools && !m.capabilities.tools) return false;
    if (policy.maxCostPerCallUsd != null && est) {
      if (projectCost(m, est) > policy.maxCostPerCallUsd) return false;
    }
    return true;
  });
  // Keep slow "thinking"/reasoning models out of simple non-reasoning tasks (edit/command/read/
  // search/…) — they deliberate for many tokens with no coding benefit. Reserve them for reasoning
  // tasks. Fall back to including them only if nothing else qualifies.
  if (TASK_SKILL[taskType] !== "reasoning") {
    const fast = eligible.filter((m) => !isReasoningModel(m.id));
    if (fast.length) return fast;
  }
  return eligible;
}

/**
 * Ranked models for a task (best first) — the full fallback chain. Never empty when any
 * model exists: if nothing clears the capability floor, fall back to all usable models
 * (tool-capable first), strongest-for-task first. The agent loop walks this to switch
 * models when one fails (e.g. a local model that can't load), with no API key needed.
 */
// Hard policy exclusions that must also apply in the no-eligible-candidate fallback paths
// (otherwise --no-local / --no-free silently leak local/free models back in).
function policyExcludes(m: ModelInfo, policy: RoutingPolicy): boolean {
  if (policy.excludeLocal && m.id.startsWith("local/")) return true;
  if (policy.excludeFree && !m.id.startsWith("local/") && blendedPrice(m) <= 0) return true;
  return false;
}

export function rankedCandidates(
  taskType: TaskType,
  models: ModelInfo[],
  policy: RoutingPolicy,
  est?: TokenEstimate
): ModelInfo[] {
  const cands = candidatesFor(taskType, models, policy, est);
  if (cands.length) return rank(cands, policy, taskType);
  const spec = TASK_SPECS[taskType];
  const usable = models.filter((m) => m.id !== "openrouter/auto" && (!spec.needsTools || m.capabilities.tools) && !policyExcludes(m, policy));
  const byStrength = (a: ModelInfo, b: ModelInfo) => taskStrength(b, taskType) - taskStrength(a, taskType);
  const withTools = usable.filter((m) => m.capabilities.tools).sort(byStrength);
  return (withTools.length ? withTools : [...usable].sort(byStrength));
}

function rank(models: ModelInfo[], policy: RoutingPolicy, taskType: TaskType): ModelInfo[] {
  const sorted = [...models];
  switch (policy.objective) {
    case "cheapest":
      // Cheapest that still cleared the capability floor in candidatesFor.
      sorted.sort((a, b) => blendedPrice(a) - blendedPrice(b));
      break;
    case "quality":
      // Strongest at THIS task's skill, price as tiebreak.
      sorted.sort(
        (a, b) =>
          taskStrength(b, taskType) - taskStrength(a, taskType) || blendedPrice(b) - blendedPrice(a)
      );
      break;
    case "value":
    default:
      // Best strength-per-dollar for THIS task — the cheapest model that covers it,
      // with empirically-proven-efficient models (playbook) preferred.
      sorted.sort(
        (a, b) => taskValue(b, taskType, policy.empirical) - taskValue(a, taskType, policy.empirical)
      );
      break;
  }
  return sorted;
}

/** Pick the best model for a task under the policy. Returns null if nothing qualifies. */
export function route(
  taskType: TaskType,
  models: ModelInfo[],
  policy: RoutingPolicy,
  est: TokenEstimate = { promptTokens: 4000, completionTokens: 1000 }
): RouteResult | null {
  // Hard pin wins.
  const pinId = policy.pinned?.[taskType];
  if (pinId) {
    const pinned = findModel(models, pinId);
    if (pinned) {
      return { model: pinned, reason: `pinned for ${taskType}`, estCostUsd: projectCost(pinned, est) };
    }
  }

  const cands = candidatesFor(taskType, models, policy, est);
  if (!cands.length) return null;
  const ranked = rank(cands, policy, taskType);
  const skill = TASK_SKILL[taskType];

  // Epsilon-greedy: occasionally sample a non-top candidate so the learned route
  // doesn't calcify and new combos keep being tested under real workloads.
  const eps = policy.explore ?? 0;
  if (eps > 0 && ranked.length > 1 && Math.random() < eps) {
    const pick = pickExploration(ranked, policy, taskType);
    if (pick.id !== ranked[0].id) {
      return {
        model: pick,
        reason: `🎲 exploring (ε=${eps}): sampling ${pick.id} off the top ${skill} route`,
        estCostUsd: projectCost(pick, est),
        explored: true,
      };
    }
  }

  const chosen = ranked[0];
  const proven = policy.empirical?.[`${taskType}:${chosen.id}`];
  const reason =
    policy.objective === "cheapest"
      ? `cheapest model that covers ${skill}`
      : policy.objective === "quality"
      ? `strongest at ${skill}`
      : proven
      ? `proven ${Math.round(proven)}% fewer tokens on ${taskType} (playbook)`
      : `best ${skill}-per-dollar`;
  return { model: chosen, reason, estCostUsd: projectCost(chosen, est) };
}

/**
 * Like route(), but never returns null: if nothing meets the constraints (e.g. a
 * local-only catalog asked for a frontier `review`), fall back to the single
 * strongest available model for the task. Used for steps and the verify gate.
 */
export function routeOrBest(
  taskType: TaskType,
  models: ModelInfo[],
  policy: RoutingPolicy,
  est: TokenEstimate = { promptTokens: 4000, completionTokens: 1000 }
): RouteResult | null {
  const r = route(taskType, models, policy, est);
  if (r) return r;
  const spec = TASK_SPECS[taskType];
  const usable = models.filter(
    (m) => m.id !== "openrouter/auto" && (!spec.needsTools || m.capabilities.tools) && !policyExcludes(m, policy)
  );
  if (!usable.length) return null;
  const byStrength = (a: ModelInfo, b: ModelInfo) => taskStrength(b, taskType) - taskStrength(a, taskType);
  // Prefer a tool-capable model (the verify gate and tool tasks depend on it); only
  // fall back to a tool-less model when no tool-capable one exists.
  const withTools = usable.filter((m) => m.capabilities.tools).sort(byStrength);
  const best = (withTools.length ? withTools : [...usable].sort(byStrength))[0];
  return { model: best, reason: `best available for ${TASK_SKILL[taskType]} (fallback)`, estCostUsd: projectCost(best, est) };
}
