import type { ModelInfo, Tier } from "../providers/types.js";

/**
 * How the router breaks ties when several models can do a task:
 *  - cheapest: minimize blended $/token, period.
 *  - value:    maximize capability-per-dollar (best bang for buck).
 *  - quality:  pick the strongest model in the required tier (cost is secondary).
 */
export type RoutingObjective = "cheapest" | "value" | "quality";

export interface RoutingPolicy {
  objective: RoutingObjective;
  /** Exclude any model whose projected per-call cost exceeds this (USD). undefined = no cap. */
  maxCostPerCallUsd?: number;
  /** Hard pins: taskType -> model id. Overrides routing entirely. */
  pinned?: Record<string, string>;
}

const TIER_RANK: Record<Tier, number> = { cheap: 0, standard: 1, frontier: 2 };

export function tierAtLeast(tier: Tier, min: Tier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[min];
}

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

/** Blended price assuming a 3:1 prompt:completion ratio — a decent default for coding work. */
export function blendedPrice(m: ModelInfo): number {
  return (m.pricing.promptUsdPerMTok * 3 + m.pricing.completionUsdPerMTok) / 4;
}

/**
 * Value score: capability per dollar. Higher tiers are worth more; cheaper is better.
 * Free models get a small synthetic price so they don't dominate to infinity.
 */
export function valueScore(m: ModelInfo): number {
  const price = Math.max(blendedPrice(m), 0.01);
  const capability = TIER_RANK[m.tier] + 1; // 1..3
  return capability / price;
}
