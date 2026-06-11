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
  command?: string; // CLI command this call belongs to (default 'run')
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

    -- One row per agent session (a \`poly run\`): goal + outcome + achievement scores.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      goal TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT 'run',
      objective TEXT NOT NULL,
      planned_steps INTEGER NOT NULL DEFAULT 0,
      completed_steps INTEGER NOT NULL DEFAULT 0,
      failed_steps INTEGER NOT NULL DEFAULT 0,
      auto_score REAL,                -- 0..1 = completed/planned (agent-computed)
      user_score INTEGER,             -- 0..9 user-rated goal achievement (nullable)
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date);

    -- One row per executed plan step: which model, how many round-trips, how it ended.
    CREATE TABLE IF NOT EXISTS step_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      step_no INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      skill TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      iterations INTEGER NOT NULL,    -- LLM round-trips used for this step
      tool_calls INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      finished_by TEXT NOT NULL,      -- 'finish-tool' | 'text' | 'max-iters' | 'error'
      success INTEGER NOT NULL,       -- 1 = ended cleanly (finish-tool or text)
      duration_ms INTEGER NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_steps_session ON step_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_steps_model ON step_runs(model, task_type);

    -- One row per CLI command invocation (run/recommend/...): tokens spent per command.
    CREATE TABLE IF NOT EXISTS command_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      command TEXT NOT NULL,
      args TEXT,
      objective TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cmd_date ON command_runs(date);

    -- Distilled efficiency insights: ONLY the notably cost-efficient approaches.
    -- This is what syncs to the cloud by default (raw logs stay local).
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,            -- "<task_type>__<model>"
      computed_at INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      samples INTEGER NOT NULL,       -- successful steps observed
      success_rate REAL NOT NULL,
      avg_tokens REAL NOT NULL,       -- per successful step
      baseline_tokens REAL NOT NULL,  -- median across qualified competitors
      savings_pct REAL NOT NULL,      -- vs baseline (the "유독" margin)
      avg_cost_usd REAL NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Migration: usage_log.command (per-call command attribution), added after v0.1.0.
  const cols = db.prepare(`PRAGMA table_info(usage_log)`).all() as any[];
  if (!cols.some((c) => c.name === "command")) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN command TEXT NOT NULL DEFAULT 'run'`);
  }
  return db;
}

export function recordUsage(e: UsageEntry): void {
  const stmt = getDb().prepare(`
    INSERT INTO usage_log
      (ts, date, provider, model, task_type, prompt_tokens, completion_tokens, total_tokens, cost_usd, session_id, command)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    e.sessionId ?? null,
    e.command ?? "run"
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
    command: r.command ? String(r.command) : "run",
  }));
}

export function markSynced(ids: number[]): void {
  if (!ids.length) return;
  const stmt = getDb().prepare(`UPDATE usage_log SET synced = 1 WHERE id = ?`);
  for (const id of ids) stmt.run(id);
}

// ---------------------------------------------------------------------------
// Sessions / steps / commands — the analytics capture layer.
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  ts: number;
  date: string;
  goal: string;
  command: string;
  objective: string;
  plannedSteps: number;
  completedSteps: number;
  failedSteps: number;
  autoScore: number | null;
  userScore: number | null;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface StepRunRow {
  sessionId: string;
  stepNo: number;
  taskType: string;
  skill: string;
  model: string;
  provider: string;
  iterations: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  finishedBy: "finish-tool" | "text" | "max-iters" | "error";
  success: boolean;
  durationMs: number;
}

export interface CommandRunRow {
  sessionId?: string;
  ts: number;
  date: string;
  command: string;
  args?: string;
  objective?: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
}

export function startSession(s: Omit<SessionRow, "completedSteps" | "failedSteps" | "autoScore" | "userScore" | "promptTokens" | "completionTokens" | "costUsd" | "durationMs">): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sessions (id, ts, date, goal, command, objective, planned_steps)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(s.id, s.ts, s.date, s.goal, s.command, s.objective, s.plannedSteps);
}

export function finishSession(
  id: string,
  u: Pick<SessionRow, "plannedSteps" | "completedSteps" | "failedSteps" | "autoScore" | "promptTokens" | "completionTokens" | "costUsd" | "durationMs">
): void {
  getDb()
    .prepare(
      `UPDATE sessions SET planned_steps=?, completed_steps=?, failed_steps=?, auto_score=?,
         prompt_tokens=?, completion_tokens=?, cost_usd=?, duration_ms=? WHERE id=?`
    )
    .run(
      u.plannedSteps,
      u.completedSteps,
      u.failedSteps,
      u.autoScore,
      u.promptTokens,
      u.completionTokens,
      u.costUsd,
      u.durationMs,
      id
    );
}

/** User-rated goal achievement, 0..9 (asked in the TUI after a run). */
export function setUserScore(sessionId: string, score: number): void {
  getDb().prepare(`UPDATE sessions SET user_score=? WHERE id=?`).run(score, sessionId);
}

export function recordStepRun(s: StepRunRow): void {
  getDb()
    .prepare(
      `INSERT INTO step_runs
        (session_id, step_no, task_type, skill, model, provider, iterations, tool_calls,
         prompt_tokens, completion_tokens, cost_usd, finished_by, success, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.sessionId,
      s.stepNo,
      s.taskType,
      s.skill,
      s.model,
      s.provider,
      s.iterations,
      s.toolCalls,
      s.promptTokens,
      s.completionTokens,
      s.costUsd,
      s.finishedBy,
      s.success ? 1 : 0,
      s.durationMs
    );
}

export function recordCommandRun(c: CommandRunRow): void {
  getDb()
    .prepare(
      `INSERT INTO command_runs
        (session_id, ts, date, command, args, objective, prompt_tokens, completion_tokens, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      c.sessionId ?? null,
      c.ts,
      c.date,
      c.command,
      c.args ?? null,
      c.objective ?? null,
      c.promptTokens,
      c.completionTokens,
      c.costUsd,
      c.durationMs
    );
}

/** Sum of recorded LLM usage for one session (used to attribute tokens to a command run). */
export function sessionUsageTotals(sessionId: string): {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
} {
  const r = getDb()
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c, COALESCE(SUM(cost_usd),0) AS cost
       FROM usage_log WHERE session_id = ?`
    )
    .get(sessionId) as any;
  return { promptTokens: Number(r?.p ?? 0), completionTokens: Number(r?.c ?? 0), costUsd: Number(r?.cost ?? 0) };
}

// ---------------------------------------------------------------------------
// Analysis queries — "which approach reaches the goal with the fewest tokens".
// ---------------------------------------------------------------------------

export interface ModelTaskEfficiency {
  taskType: string;
  model: string;
  steps: number;
  successRate: number; // 0..1
  avgTokensPerSuccess: number;
  avgCostPerSuccess: number;
  avgIterations: number;
}

/** Per (taskType, model): success rate and avg tokens for SUCCESSFUL steps. */
export function modelTaskEfficiency(filter: ReportFilter = {}): ModelTaskEfficiency[] {
  const { whereSql, params } = dateWhere(filter, "s.ts");
  const rows = getDb()
    .prepare(
      `SELECT task_type AS taskType, model,
              COUNT(*) AS steps,
              AVG(success) AS successRate,
              AVG(CASE WHEN success=1 THEN prompt_tokens + completion_tokens END) AS avgTokensPerSuccess,
              AVG(CASE WHEN success=1 THEN cost_usd END) AS avgCostPerSuccess,
              AVG(iterations) AS avgIterations
       FROM step_runs s ${whereSql}
       GROUP BY task_type, model
       ORDER BY task_type, avgTokensPerSuccess ASC`
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    taskType: String(r.taskType),
    model: String(r.model),
    steps: Number(r.steps),
    successRate: Number(r.successRate ?? 0),
    avgTokensPerSuccess: Number(r.avgTokensPerSuccess ?? 0),
    avgCostPerSuccess: Number(r.avgCostPerSuccess ?? 0),
    avgIterations: Number(r.avgIterations ?? 0),
  }));
}

export interface ObjectiveEfficiency {
  objective: string;
  sessions: number;
  avgTokens: number;
  avgCostUsd: number;
  avgAutoScore: number | null;
  avgUserScore: number | null;
}

/** Per routing objective (the "approach"): avg tokens vs avg goal achievement. */
export function objectiveEfficiency(filter: ReportFilter = {}): ObjectiveEfficiency[] {
  const { whereSql, params } = dateWhere(filter, "ts");
  const rows = getDb()
    .prepare(
      `SELECT objective,
              COUNT(*) AS sessions,
              AVG(prompt_tokens + completion_tokens) AS avgTokens,
              AVG(cost_usd) AS avgCostUsd,
              AVG(auto_score) AS avgAutoScore,
              AVG(user_score) AS avgUserScore
       FROM sessions ${whereSql}
       GROUP BY objective ORDER BY avgTokens ASC`
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    objective: String(r.objective),
    sessions: Number(r.sessions),
    avgTokens: Number(r.avgTokens ?? 0),
    avgCostUsd: Number(r.avgCostUsd ?? 0),
    avgAutoScore: r.avgAutoScore == null ? null : Number(r.avgAutoScore),
    avgUserScore: r.avgUserScore == null ? null : Number(r.avgUserScore),
  }));
}

export interface CommandUsageRow {
  command: string;
  runs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Tokens/cost spent per CLI command. */
export function commandUsage(filter: ReportFilter = {}): CommandUsageRow[] {
  const { whereSql, params } = dateWhere(filter, "ts");
  const rows = getDb()
    .prepare(
      `SELECT command, COUNT(*) AS runs,
              SUM(prompt_tokens) AS promptTokens,
              SUM(completion_tokens) AS completionTokens,
              SUM(cost_usd) AS costUsd
       FROM command_runs ${whereSql}
       GROUP BY command ORDER BY costUsd DESC`
    )
    .all(...params) as any[];
  return rows.map((r) => ({
    command: String(r.command),
    runs: Number(r.runs),
    promptTokens: Number(r.promptTokens ?? 0),
    completionTokens: Number(r.completionTokens ?? 0),
    costUsd: Number(r.costUsd ?? 0),
  }));
}

function dateWhere(filter: ReportFilter, tsCol: string): { whereSql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.since) {
    where.push(`date(${tsCol}/1000, 'unixepoch', 'localtime') >= ?`);
    params.push(filter.since);
  }
  if (filter.until) {
    where.push(`date(${tsCol}/1000, 'unixepoch', 'localtime') <= ?`);
    params.push(filter.until);
  }
  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// ---- unsynced rows for Data Connect sync -----------------------------------

export function unsyncedSessions(): (SessionRow & { _table: "sessions" })[] {
  const rows = getDb().prepare(`SELECT * FROM sessions WHERE synced=0 LIMIT 200`).all() as any[];
  return rows.map((r) => ({
    _table: "sessions" as const,
    id: String(r.id),
    ts: Number(r.ts),
    date: String(r.date),
    goal: String(r.goal),
    command: String(r.command),
    objective: String(r.objective),
    plannedSteps: Number(r.planned_steps),
    completedSteps: Number(r.completed_steps),
    failedSteps: Number(r.failed_steps),
    autoScore: r.auto_score == null ? null : Number(r.auto_score),
    userScore: r.user_score == null ? null : Number(r.user_score),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costUsd: Number(r.cost_usd),
    durationMs: Number(r.duration_ms),
  }));
}

export function unsyncedStepRuns(): (StepRunRow & { id: number })[] {
  const rows = getDb().prepare(`SELECT * FROM step_runs WHERE synced=0 LIMIT 500`).all() as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    sessionId: String(r.session_id),
    stepNo: Number(r.step_no),
    taskType: String(r.task_type),
    skill: String(r.skill),
    model: String(r.model),
    provider: String(r.provider),
    iterations: Number(r.iterations),
    toolCalls: Number(r.tool_calls),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costUsd: Number(r.cost_usd),
    finishedBy: String(r.finished_by) as StepRunRow["finishedBy"],
    success: Number(r.success) === 1,
    durationMs: Number(r.duration_ms),
  }));
}

export function unsyncedCommandRuns(): (CommandRunRow & { id: number })[] {
  const rows = getDb().prepare(`SELECT * FROM command_runs WHERE synced=0 LIMIT 500`).all() as any[];
  return rows.map((r) => ({
    id: Number(r.id),
    sessionId: r.session_id ? String(r.session_id) : undefined,
    ts: Number(r.ts),
    date: String(r.date),
    command: String(r.command),
    args: r.args ? String(r.args) : undefined,
    objective: r.objective ? String(r.objective) : undefined,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    costUsd: Number(r.cost_usd),
    durationMs: Number(r.duration_ms),
  }));
}

export function markTableSynced(
  table: "sessions" | "step_runs" | "command_runs" | "insights",
  ids: (number | string)[]
): void {
  if (!ids.length) return;
  const stmt = getDb().prepare(`UPDATE ${table} SET synced=1 WHERE id=?`);
  for (const id of ids) stmt.run(id);
}

// ---- insights (the distilled, sync-worthy efficiency patterns) --------------

export interface InsightRow {
  id: string;
  computedAt: number;
  taskType: string;
  model: string;
  provider: string;
  samples: number;
  successRate: number;
  avgTokens: number;
  baselineTokens: number;
  savingsPct: number;
  avgCostUsd: number;
}

/** Upsert an insight; resets synced so updated evidence re-syncs. */
export function upsertInsight(i: InsightRow): void {
  getDb()
    .prepare(
      `INSERT INTO insights (id, computed_at, task_type, model, provider, samples, success_rate,
         avg_tokens, baseline_tokens, savings_pct, avg_cost_usd, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         computed_at=excluded.computed_at, samples=excluded.samples,
         success_rate=excluded.success_rate, avg_tokens=excluded.avg_tokens,
         baseline_tokens=excluded.baseline_tokens, savings_pct=excluded.savings_pct,
         avg_cost_usd=excluded.avg_cost_usd, synced=0`
    )
    .run(
      i.id,
      i.computedAt,
      i.taskType,
      i.model,
      i.provider,
      i.samples,
      i.successRate,
      i.avgTokens,
      i.baselineTokens,
      i.savingsPct,
      i.avgCostUsd
    );
}

/** Remove insights that no longer hold after re-distillation. */
export function deleteInsightsExcept(validIds: string[]): void {
  const all = getDb().prepare(`SELECT id FROM insights`).all() as any[];
  const keep = new Set(validIds);
  const del = getDb().prepare(`DELETE FROM insights WHERE id=?`);
  for (const r of all) if (!keep.has(String(r.id))) del.run(String(r.id));
}

export function listInsights(): InsightRow[] {
  const rows = getDb().prepare(`SELECT * FROM insights ORDER BY savings_pct DESC`).all() as any[];
  return rows.map(mapInsight);
}

export function unsyncedInsights(): InsightRow[] {
  const rows = getDb().prepare(`SELECT * FROM insights WHERE synced=0`).all() as any[];
  return rows.map(mapInsight);
}

function mapInsight(r: any): InsightRow {
  return {
    id: String(r.id),
    computedAt: Number(r.computed_at),
    taskType: String(r.task_type),
    model: String(r.model),
    provider: String(r.provider),
    samples: Number(r.samples),
    successRate: Number(r.success_rate),
    avgTokens: Number(r.avg_tokens),
    baselineTokens: Number(r.baseline_tokens),
    savingsPct: Number(r.savings_pct),
    avgCostUsd: Number(r.avg_cost_usd),
  };
}
