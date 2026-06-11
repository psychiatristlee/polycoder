import type { ModelInfo } from "../providers/types.js";
import { TASK_SPECS, type TaskType } from "../planner/tasks.js";
import { blendedPrice, tierAtLeast, type RoutingPolicy } from "./policy.js";
import { taskStrength, TASK_MIN_STRENGTH, TASK_SKILL } from "../models/strengths.js";
import { findModel } from "../models/parse.js";

export interface TokenEstimate {
  promptTokens: number;
  completionTokens: number;
}

export interface RouteResult {
  model: ModelInfo;
  reason: string;
  estCostUsd: number;
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
  return models.filter((m) => {
    if (m.id === "openrouter/auto") return false;
    const covers = tierAtLeast(m.tier, spec.minTier) || taskStrength(m, taskType) >= strengthFloor;
    if (!covers) return false;
    if (spec.needsTools && !m.capabilities.tools) return false;
    if (policy.maxCostPerCallUsd != null && est) {
      if (projectCost(m, est) > policy.maxCostPerCallUsd) return false;
    }
    return true;
  });
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
  const chosen = ranked[0];
  const skill = TASK_SKILL[taskType];
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
