// Distillation: from the full local ledger, extract ONLY the notably cost-efficient
// approaches ("유독 비용 효율적인 방식"). These compact insights are what sync to the
// cloud by default — raw logs (goals, step details) never leave the machine unless
// the user opts in with `poly sync --raw`.
//
// An insight = (taskType, model) that:
//   1. has enough evidence:        samples ≥ MIN_SAMPLES successful steps
//   2. is reliable:                success rate ≥ MIN_SUCCESS
//   3. is NOTABLY efficient:       avg tokens ≤ (1 - MIN_MARGIN) × median of
//                                  qualified competitors on the same task type
// If fewer than 2 models qualify for a task type there is no baseline to beat,
// so nothing is stored — "efficient" is always relative, never absolute.
import {
  modelTaskEfficiency,
  upsertInsight,
  deleteInsightsExcept,
  listInsights,
  type InsightRow,
} from "./db.js";
import { table, tokens, c } from "../util/format.js";

export const MIN_SAMPLES = 3;
export const MIN_SUCCESS = 0.7;
export const MIN_MARGIN = 0.2; // must beat the median by ≥20% to count as "notably" efficient

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Re-derive the insight set from step_runs. Returns the current insights. */
export function distillInsights(now = Date.now()): InsightRow[] {
  const eff = modelTaskEfficiency();
  const byTask = new Map<string, typeof eff>();
  for (const r of eff) {
    const list = byTask.get(r.taskType) ?? [];
    list.push(r);
    byTask.set(r.taskType, list);
  }

  const valid: string[] = [];
  for (const [taskType, list] of byTask) {
    const qualified = list.filter(
      (r) => r.steps >= MIN_SAMPLES && r.successRate >= MIN_SUCCESS && r.avgTokensPerSuccess > 0
    );
    if (qualified.length < 2) continue; // no baseline to compare against
    const baseline = median(qualified.map((r) => r.avgTokensPerSuccess));
    for (const r of qualified) {
      const savings = 1 - r.avgTokensPerSuccess / baseline;
      if (savings >= MIN_MARGIN) {
        const id = `${taskType}__${r.model}`;
        valid.push(id);
        upsertInsight({
          id,
          computedAt: now,
          taskType,
          model: r.model,
          provider: r.model.split("/")[0] ?? "unknown",
          samples: r.steps,
          successRate: r.successRate,
          avgTokens: r.avgTokensPerSuccess,
          baselineTokens: baseline,
          savingsPct: savings * 100,
          avgCostUsd: r.avgCostPerSuccess,
        });
      }
    }
  }
  // Drop insights whose edge evaporated with new evidence.
  deleteInsightsExcept(valid);
  return listInsights();
}

/** Map for the router: "<taskType>:<modelId>" -> savingsPct. */
export function insightBoostMap(insights: InsightRow[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const i of insights) map[`${i.taskType}:${i.model}`] = i.savingsPct;
  return map;
}

export function renderPlaybook(insights: InsightRow[]): string {
  if (!insights.length) {
    return (
      c.bold("Efficiency playbook") +
      "\n" +
      c.dim(
        `Nothing distilled yet — needs ≥2 models with ≥${MIN_SAMPLES} successful steps on the same task type,\n` +
          `where one beats the median by ≥${MIN_MARGIN * 100}% tokens. Keep running tasks (vary models with -o / pins).`
      )
    );
  }
  return (
    c.bold("Efficiency playbook") +
    c.dim("  (the notably efficient approaches — this is what `poly sync` uploads)") +
    "\n" +
    table(
      ["Task", "Model", "Avg tok", "Baseline", "Savings", "Success", "n"],
      insights.map((i) => [
        i.taskType,
        c.green(i.model),
        tokens(Math.round(i.avgTokens)),
        tokens(Math.round(i.baselineTokens)),
        c.green(`-${i.savingsPct.toFixed(0)}%`),
        `${Math.round(i.successRate * 100)}%`,
        String(i.samples),
      ])
    )
  );
}
