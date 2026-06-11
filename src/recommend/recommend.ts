import type { ModelInfo, Tier } from "../providers/types.js";
import type { Plan, PlannedStep } from "../planner/tasks.js";
import { TASK_SPECS } from "../planner/tasks.js";
import { route, projectCost, candidatesFor, type TokenEstimate } from "../router/router.js";
import {
  blendedPrice,
  valueScore,
  tierAtLeast,
  type RoutingObjective,
  type RoutingPolicy,
} from "../router/policy.js";
import {
  strengthFor,
  skillBonus,
  HEADLINE_SKILLS,
  TASK_SKILL,
  type Skill,
} from "../models/strengths.js";
import { table, usd, tierColor, perMTok, c } from "../util/format.js";

export interface Assignment {
  step: PlannedStep;
  model: ModelInfo | null;
  estCostUsd: number;
  reason: string;
}

export interface StrategyRec {
  objective: RoutingObjective;
  label: string;
  assignments: Assignment[];
  totalCostUsd: number;
  distinctModels: number;
}

export interface SingleModelRec {
  model: ModelInfo;
  totalCostUsd: number;
  feasible: boolean; // can it serve every step (tier + tools)?
}

export interface Recommendation {
  plan: Plan;
  strategies: StrategyRec[];
  bestValueByTier: Record<Tier, ModelInfo[]>;
  bestValueBySkill: Partial<Record<Skill, ModelInfo[]>>;
  singleModelBaselines: SingleModelRec[];
  savingsPct: number; // routing (value) vs all-frontier single model
}

const OBJECTIVES: { objective: RoutingObjective; label: string }[] = [
  { objective: "cheapest", label: "Cheapest — minimize cost" },
  { objective: "value", label: "Best value — capability per dollar" },
  { objective: "quality", label: "Best quality — strongest per task" },
];

function estOf(step: PlannedStep): TokenEstimate {
  return { promptTokens: step.estPromptTokens, completionTokens: step.estCompletionTokens };
}

function strategyFor(plan: Plan, models: ModelInfo[], objective: RoutingObjective, label: string): StrategyRec {
  const policy: RoutingPolicy = { objective };
  const assignments: Assignment[] = plan.steps.map((step) => {
    const r = route(step.type, models, policy, estOf(step));
    return r
      ? { step, model: r.model, estCostUsd: r.estCostUsd, reason: r.reason }
      : { step, model: null, estCostUsd: 0, reason: "no capable model" };
  });
  const totalCostUsd = assignments.reduce((s, a) => s + a.estCostUsd, 0);
  const distinctModels = new Set(assignments.map((a) => a.model?.id).filter(Boolean)).size;
  return { objective, label, assignments, totalCostUsd, distinctModels };
}

/** Top models that are genuinely strong at each skill, ranked by strength-per-dollar. */
function bestValueBySkill(models: ModelInfo[]): Partial<Record<Skill, ModelInfo[]>> {
  const out: Partial<Record<Skill, ModelInfo[]>> = {};
  for (const skill of HEADLINE_SKILLS) {
    out[skill] = models
      .filter((m) => m.id !== "openrouter/auto" && skillBonus(m, skill) > 1.05)
      .sort(
        (a, b) =>
          strengthFor(b, skill) / Math.max(blendedPrice(b), 0.01) -
          strengthFor(a, skill) / Math.max(blendedPrice(a), 0.01)
      )
      .slice(0, 4);
  }
  return out;
}

function bestValueByTier(models: ModelInfo[]): Record<Tier, ModelInfo[]> {
  const tiers: Tier[] = ["cheap", "standard", "frontier"];
  const out = {} as Record<Tier, ModelInfo[]>;
  for (const t of tiers) {
    out[t] = models
      .filter((m) => m.tier === t && m.id !== "openrouter/auto")
      .sort((a, b) => valueScore(b) - valueScore(a))
      .slice(0, 5);
  }
  return out;
}

function singleModelCost(plan: Plan, model: ModelInfo): SingleModelRec {
  let feasible = true;
  let total = 0;
  for (const step of plan.steps) {
    const spec = TASK_SPECS[step.type];
    if (!tierAtLeast(model.tier, spec.minTier)) feasible = false;
    if (spec.needsTools && !model.capabilities.tools) feasible = false;
    total += projectCost(model, estOf(step));
  }
  return { model, totalCostUsd: total, feasible };
}

export function buildRecommendation(plan: Plan, models: ModelInfo[]): Recommendation {
  const strategies = OBJECTIVES.map((o) => strategyFor(plan, models, o.objective, o.label));
  const byTier = bestValueByTier(models);

  // Single-model baselines: the top value pick in each tier.
  const picks = (["cheap", "standard", "frontier"] as Tier[])
    .map((t) => byTier[t][0])
    .filter(Boolean) as ModelInfo[];
  const singleModelBaselines = picks.map((m) => singleModelCost(plan, m));

  // "Savings from routing" = best-value multi-model plan vs. running every step on
  // the strongest model (the best-quality strategy total). This is the meaningful
  // comparison: it isolates what cost-aware routing buys you.
  const valueStrategy = strategies.find((s) => s.objective === "value")!;
  const qualityStrategy = strategies.find((s) => s.objective === "quality")!;
  const savingsPct =
    qualityStrategy.totalCostUsd > 0
      ? (1 - valueStrategy.totalCostUsd / qualityStrategy.totalCostUsd) * 100
      : 0;

  return {
    plan,
    strategies,
    bestValueByTier: byTier,
    bestValueBySkill: bestValueBySkill(models),
    singleModelBaselines,
    savingsPct,
  };
}

export function renderRecommendation(rec: Recommendation): string {
  const out: string[] = [];
  out.push(c.bold(`Plan for: ${c.cyan(rec.plan.goal)}`));
  out.push(
    table(
      ["#", "Task", "Type", "Needs", "Est tok (in/out)"],
      rec.plan.steps.map((s) => [
        String(s.id),
        s.description,
        tierColor(TASK_SPECS[s.type].minTier, s.type),
        TASK_SKILL[s.type],
        `${s.estPromptTokens}/${s.estCompletionTokens}`,
      ])
    )
  );
  out.push("");

  for (const strat of rec.strategies) {
    out.push(c.bold(strat.label) + c.dim(`  (${strat.distinctModels} model(s), est ${usd(strat.totalCostUsd)})`));
    out.push(
      table(
        ["Step", "Model", "Tier", "Est cost"],
        strat.assignments.map((a) => [
          `${a.step.id} ${a.step.type}`,
          a.model ? a.model.id : c.red("(none)"),
          a.model ? tierColor(a.model.tier) : "-",
          usd(a.estCostUsd),
        ])
      )
    );
    out.push("");
  }

  out.push(c.bold("Best value by skill") + c.dim("  (strongest-per-dollar for each kind of work)"));
  for (const skill of HEADLINE_SKILLS) {
    const list = rec.bestValueBySkill[skill];
    if (!list || !list.length) continue;
    out.push(
      "  " +
        c.cyan(skill.padEnd(10)) +
        list
          .slice(0, 3)
          .map((m) => `${m.id} ${c.dim(perMTok(blendedPrice(m)))}`)
          .join(c.dim("  ·  "))
    );
  }
  out.push("");

  out.push(c.bold("Best-value models by tier") + c.dim("  (capability per dollar)"));
  for (const tier of ["cheap", "standard", "frontier"] as Tier[]) {
    const list = rec.bestValueByTier[tier];
    if (!list.length) continue;
    out.push(
      "  " +
        tierColor(tier, tier.toUpperCase().padEnd(9)) +
        list
          .slice(0, 3)
          .map((m) => `${m.id} ${c.dim(perMTok(blendedPrice(m)))}`)
          .join(c.dim("  ·  "))
    );
  }
  out.push("");

  out.push(c.bold("Single-model baselines (whole plan on one model)"));
  out.push(
    table(
      ["Model", "Tier", "Feasible?", "Est cost"],
      rec.singleModelBaselines.map((b) => [
        b.model.id,
        tierColor(b.model.tier),
        b.feasible ? c.green("yes") : c.yellow("partial"),
        usd(b.totalCostUsd),
      ])
    )
  );
  out.push("");

  if (rec.savingsPct > 0) {
    out.push(
      c.green(
        `→ Best-value routing costs ~${rec.savingsPct.toFixed(
          0
        )}% less than running every step on the strongest model.`
      )
    );
  }
  out.push(
    c.dim(
      "Estimates use a heuristic plan + token guesses; actuals are logged per call and shown in `poly usage`."
    )
  );
  return out.join("\n");
}

/** Unused-export guard: keep candidatesFor reachable for future "show all options" UI. */
export { candidatesFor };
