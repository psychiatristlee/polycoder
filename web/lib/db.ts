// Cloud SQL (Postgres) access for the search engine. Connects via the Cloud SQL
// Node connector (secure, no public IP needed) and uses Postgres native full-text
// search (tsvector + GIN + ts_rank_cd) — the real-engine version of our BM25.
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { Pool } from "pg";

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
