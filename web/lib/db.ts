// Cloud SQL (Postgres) access for the search engine. Connects via the Cloud SQL
// Node connector (secure, no public IP needed) and uses Postgres native full-text
// search (tsvector + GIN + ts_rank_cd) — the real-engine version of our BM25.
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool } from "pg";
import { createHash, randomBytes } from "node:crypto";

let poolPromise: Promise<Pool> | null = null;

async function createPool(): Promise<Pool> {
  const instanceConnectionName = process.env.INSTANCE_CONNECTION_NAME;
  if (!instanceConnectionName) throw new Error("INSTANCE_CONNECTION_NAME is not set");
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName,
    ipType: IpAddressTypes.PUBLIC,
  });
  const pool = new Pool({
    ...clientOpts,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    max: 3,
  });
  await ensureSchema(pool);
  return pool;
}

/** Lazily created singleton pool (one per server instance). */
export function getPool(): Promise<Pool> {
  if (!poolPromise) poolPromise = createPool().catch((e) => ((poolPromise = null), Promise.reject(e)));
  return poolPromise;
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_docs (
      url text PRIMARY KEY,
      title text NOT NULL DEFAULT '',
      host text NOT NULL DEFAULT '',
      body text NOT NULL DEFAULT '',
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))) STORED,
      fetched_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_tsv ON search_docs USING GIN (tsv);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_search_host ON search_docs (host);`);
  // API keys for multiple consumers — only the SHA-256 hash is stored, never the key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash text PRIMARY KEY,
      label text NOT NULL DEFAULT '',
      scope text NOT NULL DEFAULT 'search',
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked boolean NOT NULL DEFAULT false
    );
  `);
  // Error telemetry from the polyrun desktop app (so issues can be triaged/fixed later).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_errors (
      id bigserial PRIMARY KEY,
      ts timestamptz NOT NULL DEFAULT now(),
      app text NOT NULL DEFAULT 'polyrun',
      app_version text NOT NULL DEFAULT '',
      platform text NOT NULL DEFAULT '',
      user_id text NOT NULL DEFAULT '',
      user_email text NOT NULL DEFAULT '',
      source text NOT NULL DEFAULT '',
      message text NOT NULL DEFAULT '',
      stack text NOT NULL DEFAULT '',
      context jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_errors_ts ON app_errors (ts DESC);`);
}

export interface ErrorEvent {
  appVersion?: string;
  platform?: string;
  userId?: string;
  userEmail?: string;
  source?: string;
  message: string;
  stack?: string;
  context?: unknown;
}

/** Record one error event from a client app. Field sizes are capped to bound abuse. */
export async function insertError(e: ErrorEvent): Promise<void> {
  const pool = await getPool();
  const cap = (s: unknown, n: number) => String(s ?? "").slice(0, n);
  let ctx = "{}";
  try {
    ctx = JSON.stringify(e.context ?? {}).slice(0, 16000);
  } catch {
    ctx = "{}";
  }
  await pool.query(
    `INSERT INTO app_errors (app_version, platform, user_id, user_email, source, message, stack, context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [cap(e.appVersion, 40), cap(e.platform, 40), cap(e.userId, 128), cap(e.userEmail, 256), cap(e.source, 60), cap(e.message, 4000), cap(e.stack, 20000), ctx]
  );
}

export interface ErrorRow {
  id: number;
  ts: string;
  app_version: string;
  platform: string;
  user_email: string;
  source: string;
  message: string;
  stack: string;
}

/** Recent errors (admin view / for triage). */
export async function listErrors(limit = 100): Promise<ErrorRow[]> {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT id, ts, app_version, platform, user_email, source, message, stack FROM app_errors ORDER BY ts DESC LIMIT $1`,
    [Math.min(Math.max(limit, 1), 500)]
  );
  return r.rows as ErrorRow[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface ApiKeyInfo {
  label: string;
  scope: string;
  createdAt: string;
  revoked: boolean;
}

/** Issue a new consumer key (returned ONCE in plaintext; only its hash is stored). */
export async function issueApiKey(label: string, scope = "search"): Promise<{ key: string; label: string; scope: string }> {
  const pool = await getPool();
  const key = "pk_" + randomBytes(24).toString("base64url");
  await pool.query(`INSERT INTO api_keys (key_hash, label, scope) VALUES ($1, $2, $3)`, [sha(key), label.slice(0, 80) || "consumer", scope]);
  return { key, label, scope };
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT label, scope, created_at, revoked FROM api_keys ORDER BY created_at DESC`);
  return rows.map((r: any) => ({ label: r.label, scope: r.scope, createdAt: r.created_at, revoked: r.revoked }));
}

export async function revokeApiKey(label: string): Promise<number> {
  const pool = await getPool();
  const { rowCount } = await pool.query(`UPDATE api_keys SET revoked=true WHERE label=$1 AND revoked=false`, [label]);
  return rowCount ?? 0;
}

/** Is this key valid for the given scope? (admin keys also satisfy 'search'.) */
export async function keyValid(provided: string, scope: string): Promise<boolean> {
  if (!provided) return false;
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT scope FROM api_keys WHERE key_hash=$1 AND revoked=false`, [sha(provided)]);
  if (!rows.length) return false;
  const s = rows[0].scope;
  return s === "all" || s === scope || (scope === "search" && s === "admin");
}

export interface Hit {
  url: string;
  title: string;
  host: string;
  score: number;
  snippet: string;
}

export async function searchDocs(q: string, k = 20): Promise<Hit[]> {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT url, title, host,
            ts_rank_cd(tsv, websearch_to_tsquery('simple', $1)) AS score,
            ts_headline('simple', body, websearch_to_tsquery('simple', $1),
              'MaxFragments=1,MaxWords=34,MinWords=12,ShortWord=2,HighlightAll=false') AS snippet
       FROM search_docs
      WHERE tsv @@ websearch_to_tsquery('simple', $1)
      ORDER BY score DESC
      LIMIT $2`,
    [q, k]
  );
  return rows.map((r: any) => ({
    url: r.url,
    title: r.title || r.url,
    host: r.host,
    score: Number(r.score),
    snippet: (r.snippet || "").replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim(),
  }));
}

export async function upsertDoc(d: { url: string; title: string; host: string; body: string }): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO search_docs (url, title, host, body) VALUES ($1, $2, $3, $4)
     ON CONFLICT (url) DO UPDATE SET title=excluded.title, host=excluded.host, body=excluded.body, fetched_at=now()`,
    [d.url, d.title, d.host, d.body.slice(0, 60000)]
  );
}

export async function docExists(url: string): Promise<boolean> {
  const pool = await getPool();
  const { rows } = await pool.query(`SELECT 1 FROM search_docs WHERE url=$1`, [url]);
  return rows.length > 0;
}

export interface Stats {
  docs: number;
  hosts: { host: string; docs: number }[];
}
export async function stats(): Promise<Stats> {
  const pool = await getPool();
  const total = await pool.query(`SELECT COUNT(*)::int AS c FROM search_docs`);
  const byHost = await pool.query(
    `SELECT host, COUNT(*)::int AS docs FROM search_docs GROUP BY host ORDER BY docs DESC LIMIT 50`
  );
  return { docs: total.rows[0].c, hosts: byHost.rows.map((r: any) => ({ host: r.host, docs: r.docs })) };
}
