// Usage ledger by date + model, persisted in chrome.storage.local (aggregated to
// keep it bounded). Mirrors the CLI's SQLite report, browser-side.
import type { CompletionResult } from "../../src/providers/types.js";

export interface UsageRow {
  date: string;
  model: string;
  provider: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function logCompletion(result: CompletionResult, _taskType: string): Promise<UsageRow> {
  const r = await chrome.storage.local.get("usage");
  const map: Record<string, UsageRow> = r.usage ?? {};
  const date = localDate();
  const key = `${date}__${result.model}`;
  const provider = result.model.split("/")[0] ?? "unknown";
  const cur: UsageRow =
    map[key] ??
    { date, model: result.model, provider, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  cur.calls += 1;
  cur.promptTokens += result.usage.promptTokens;
  cur.completionTokens += result.usage.completionTokens;
  cur.totalTokens += result.usage.totalTokens;
  cur.costUsd += result.costUsd;
  map[key] = cur;
  await chrome.storage.local.set({ usage: map });
  return cur;
}

export async function reportByDateModel(): Promise<UsageRow[]> {
  const r = await chrome.storage.local.get("usage");
  const map: Record<string, UsageRow> = r.usage ?? {};
  return Object.values(map).sort((a, b) =>
    a.date === b.date ? b.costUsd - a.costUsd : a.date < b.date ? 1 : -1
  );
}

export async function totals(): Promise<{ calls: number; totalTokens: number; costUsd: number }> {
  const rows = await reportByDateModel();
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { calls: 0, totalTokens: 0, costUsd: 0 }
  );
}
