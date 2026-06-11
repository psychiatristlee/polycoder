// The headline analytics: which approach reaches the goal with the FEWEST tokens.
// Three lenses: (1) per task type, the most token-efficient model among models that
// actually succeed; (2) per routing objective ("approach"), tokens vs achievement;
// (3) per CLI command, where the tokens go.
import {
  modelTaskEfficiency,
  objectiveEfficiency,
  commandUsage,
  type ReportFilter,
  type ModelTaskEfficiency,
} from "./db.js";
import { distillInsights, renderPlaybook } from "./insights.js";
import { table, usd, tokens, c } from "../util/format.js";

const MIN_SUCCESS_RATE = 0.5; // a model must succeed at least half the time to be "best"

export function renderAnalysis(filter: ReportFilter = {}): string {
  const out: string[] = [];
  const byModelTask = modelTaskEfficiency(filter);
  const byObjective = objectiveEfficiency(filter);
  const byCommand = commandUsage(filter);

  if (!byModelTask.length && !byObjective.length && !byCommand.length) {
    return c.dim("No analytics yet. Run `poly run \"<task>\"` a few times (and rate the result) first.");
  }

  // ---- 0) Distill + show the playbook (what actually gets synced) ----------
  const insights = distillInsights();
  out.push(renderPlaybook(insights));
  out.push("");

  // ---- 1) Best (min-token, still-successful) model per task type ----------
  if (byModelTask.length) {
    const byTask = new Map<string, ModelTaskEfficiency[]>();
    for (const r of byModelTask) {
      const list = byTask.get(r.taskType) ?? [];
      list.push(r);
      byTask.set(r.taskType, list);
    }
    const rows: string[][] = [];
    for (const [task, list] of byTask) {
      const eligible = list
        .filter((r) => r.successRate >= MIN_SUCCESS_RATE && r.avgTokensPerSuccess > 0)
        .sort((a, b) => a.avgTokensPerSuccess - b.avgTokensPerSuccess);
      const best = eligible[0];
      const runnerUp = eligible[1];
      if (!best) {
        rows.push([task, c.dim("(no reliable model yet)"), "-", "-", "-"]);
        continue;
      }
      rows.push([
        task,
        c.green(best.model),
        tokens(Math.round(best.avgTokensPerSuccess)),
        `${Math.round(best.successRate * 100)}%`,
        runnerUp
          ? `${runnerUp.model} ${c.dim(tokens(Math.round(runnerUp.avgTokensPerSuccess)))}`
          : c.dim("—"),
      ]);
    }
    out.push(c.bold("Minimum-token model per task") + c.dim(`  (successful steps only, success ≥ ${MIN_SUCCESS_RATE * 100}%)`));
    out.push(table(["Task", "Best model", "Avg tok/success", "Success", "Runner-up"], rows));
    out.push("");

    // Full matrix for transparency.
    out.push(c.bold("Model × task efficiency (all observations)"));
    out.push(
      table(
        ["Task", "Model", "Steps", "Success", "Avg tok", "Avg iters", "Avg cost"],
        byModelTask.map((r) => [
          r.taskType,
          r.model,
          String(r.steps),
          `${Math.round(r.successRate * 100)}%`,
          r.avgTokensPerSuccess ? tokens(Math.round(r.avgTokensPerSuccess)) : c.dim("-"),
          r.avgIterations.toFixed(1),
          r.avgCostPerSuccess ? usd(r.avgCostPerSuccess) : c.dim("-"),
        ])
      )
    );
    out.push("");
  }

  // ---- 2) Approach (routing objective): tokens vs achievement --------------
  if (byObjective.length) {
    out.push(c.bold("Approach efficiency") + c.dim("  (routing objective: tokens spent vs goal achievement)"));
    out.push(
      table(
        ["Objective", "Sessions", "Avg tokens", "Avg cost", "Auto score", "Your rating"],
        byObjective.map((r) => [
          r.objective,
          String(r.sessions),
          tokens(Math.round(r.avgTokens)),
          usd(r.avgCostUsd),
          r.avgAutoScore == null ? c.dim("-") : `${Math.round(r.avgAutoScore * 100)}%`,
          r.avgUserScore == null ? c.dim("unrated") : `${r.avgUserScore.toFixed(1)}/9`,
        ])
      )
    );
    // Verdict: cheapest approach that doesn't sacrifice achievement.
    const scored = byObjective.filter((r) => r.avgAutoScore != null);
    if (scored.length >= 2) {
      const bestScore = Math.max(...scored.map((r) => r.avgAutoScore!));
      const winner = scored
        .filter((r) => r.avgAutoScore! >= bestScore - 0.1) // within 10pp of the best
        .sort((a, b) => a.avgTokens - b.avgTokens)[0];
      if (winner) {
        out.push(
          c.green(
            `→ Lowest-token approach with top-tier achievement: "${winner.objective}" ` +
              `(${tokens(Math.round(winner.avgTokens))} avg tokens, ${Math.round(winner.avgAutoScore! * 100)}% auto score)`
          )
        );
      }
    }
    out.push("");
  }

  // ---- 3) Where tokens go, per CLI command ---------------------------------
  if (byCommand.length) {
    out.push(c.bold("Usage by command"));
    out.push(
      table(
        ["Command", "Runs", "Prompt", "Compl.", "Cost"],
        byCommand.map((r) => [r.command, String(r.runs), tokens(r.promptTokens), tokens(r.completionTokens), usd(r.costUsd)])
      )
    );
  }

  return out.join("\n");
}
