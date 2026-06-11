import { reportByDateModel, totals, type ReportFilter } from "./db.js";
import { table, usd, tokens, c } from "../util/format.js";

/** Render the date+model usage report as a printable string. */
export function renderUsageReport(filter: ReportFilter = {}): string {
  const rows = reportByDateModel(filter);
  if (!rows.length) {
    return c.dim("No usage recorded yet. Run `poly run \"<task>\"` to start tracking.");
  }

  const body = table(
    ["Date", "Model", "Calls", "Prompt", "Compl.", "Cost"],
    rows.map((r) => [
      r.date,
      r.model,
      String(r.calls),
      tokens(r.promptTokens),
      tokens(r.completionTokens),
      usd(r.costUsd),
    ])
  );

  const t = totals(filter);
  // Per-model rollup (across all dates in range).
  const byModel = new Map<string, { cost: number; tokens: number; calls: number }>();
  for (const r of rows) {
    const cur = byModel.get(r.model) ?? { cost: 0, tokens: 0, calls: 0 };
    cur.cost += r.costUsd;
    cur.tokens += r.totalTokens;
    cur.calls += r.calls;
    byModel.set(r.model, cur);
  }
  const modelRollup = table(
    ["Model", "Calls", "Tokens", "Cost"],
    [...byModel.entries()]
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([model, v]) => [model, String(v.calls), tokens(v.tokens), usd(v.cost)])
  );

  return [
    c.bold("Usage by date + model"),
    body,
    "",
    c.bold("Totals by model"),
    modelRollup,
    "",
    `${c.bold("TOTAL")}  ${t.calls} calls · ${tokens(t.totalTokens)} tokens · ${c.green(usd(t.costUsd))}`,
  ].join("\n");
}
