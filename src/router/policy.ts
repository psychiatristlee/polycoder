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
  /**
   * Empirical efficiency boosts from the local playbook: "<taskType>:<modelId>" -> savingsPct.
   * Models PROVEN notably efficient on a task get preferred under the `value` objective.
   */
  empirical?: Record<string, number>;
  /** Minimum tier to consider (escalation raises this on verification failure). */
  tierFloor?: Tier;
  /**
   * Exclude $0 *cloud* models (OpenRouter `:free` tier). They're heavily rate-limited
   * (429) and unreliable for multi-call agent runs — the real "value" pick is a cheap
   * PAID model. Local ($0) models are never excluded by this.
   */
  excludeFree?: boolean;
  /**
   * Epsilon-greedy exploration rate (0..1). With this probability the router picks a
   * non-top, under-sampled candidate instead of the learned-best one — so the optimal
   * route doesn't calcify and new models keep getting sampled. 0 = always exploit.
   */
  explore?: number;
}

/**
 * Escalation ladder: when the verify gate fails, climb a rung — a higher tier floor,
 * a stronger objective, more tokens per call, and the cost cap lifted. This is the
 * "spend more / use a pricier model until the goal is met" behavior.
 */
export interface EscalationRung {
  tierFloor?: Tier;
  objective: RoutingObjective;
  maxTokens: number;
  maxIters: number;
  liftCostCap: boolean;
  label: string;
}

export const ESCALATION_LADDER: EscalationRung[] = [
  { objective: "value", maxTokens: 2000, maxIters: 6, liftCostCap: false, label: "value · cheapest-capable" },
  { tierFloor: "standard", objective: "value", maxTokens: 4000, maxIters: 8, liftCostCap: true, label: "standard+ · more tokens" },
  { tierFloor: "frontier", objective: "quality", maxTokens: 8000, maxIters: 10, liftCostCap: true, label: "frontier · strongest" },
];

export function rungForTier(tier: Tier): number {
  return ESCALATION_LADDER.findIndex((r) => r.tierFloor === tier || (!r.tierFloor && tier === "cheap"));
}

/** Apply an escalation rung on top of a base policy. */
export function applyRung(base: RoutingPolicy, rung: EscalationRung): RoutingPolicy {
  return {
    ...base,
    objective: rung.objective,
    tierFloor: rung.tierFloor,
    maxCostPerCallUsd: rung.liftCostCap ? undefined : base.maxCostPerCallUsd,
  };
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
