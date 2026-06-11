import { DatabaseSync } from "node:sqlite";
import { ensureConfigDir, dbFilePath } from "../config/paths.js";

export interface UsageEntry {
  ts: number; // epoch ms
  date: string; // YYYY-MM-DD (local)
  provider: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  sessionId?: string;
}

export interface DateModelRow {
  date: string;
  model: string;
  provider: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  ensureConfigDir();
  db = new DatabaseSync(dbFilePath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      task_type TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      session_id TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_log(date);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_log(model);
  `);
  return db;
}

export function recordUsage(e: UsageEntry): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage_log
      (ts, date, provider, model, task_type, prompt_tokens, completion_tokens, total_tokens, cost_usd, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    e.ts,
    e.date,
    e.provider,
    e.model,
    e.taskType,
    e.promptTokens,
    e.completionTokens,
    e.totalTokens,
    e.costUsd,
    e.sessionId ?? null
  );
}

export interface ReportFilter {
  since?: string; // YYYY-MM-DD inclusive
  until?: string; // YYYY-MM-DD inclusive
}

export function reportByDateModel(filter: ReportFilter = {}): DateModelRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since) {
    where.push("date >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    where.push("date <= ?");
    params.push(filter.until);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(
      `SELECT date, model, provider,
              COUNT(*) AS calls,
              SUM(prompt_tokens) AS promptTokens,
              SUM(completion_tokens) AS completionTokens,
              SUM(total_tokens) AS totalTokens,
              SUM(cost_usd) AS costUsd
       FROM usage_log
       ${whereSql}
       GROUP BY date, model
       ORDER BY date DESC, costUsd DESC`
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    date: String(r.date),
    model: String(r.model),
    provider: String(r.provider),
    calls: Number(r.calls),
    promptTokens: Number(r.promptTokens),
    completionTokens: Number(r.completionTokens),
    totalTokens: Number(r.totalTokens),
    costUsd: Number(r.costUsd),
  }));
}

export function totals(filter: ReportFilter = {}): { calls: number; totalTokens: number; costUsd: number } {
  const rows = reportByDateModel(filter);
  return rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      totalTokens: acc.totalTokens + r.totalTokens,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { calls: 0, totalTokens: 0, costUsd: 0 }
  );
}

export function unsyncedRows(): (UsageEntry & { id: number })[] {
  const rows = getDb()
    .prepare(`SELECT * FROM usage_log WHERE synced = 0 ORDER BY id ASC LIMIT 500`)
    .all() as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    date: String(r.date),
    provider: String(r.provider),
    model: String(r.model),
    taskType: String(r.task_type),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    totalTokens: Number(r.total_tokens),
    costUsd: Number(r.cost_usd),
    sessionId: r.session_id ? String(r.session_id) : undefined,
  }));
}

export function markSynced(ids: number[]): void {
  if (!ids.length) return;
  const stmt = getDb().prepare(`UPDATE usage_log SET synced = 1 WHERE id = ?`);
  for (const id of ids) stmt.run(id);
}
