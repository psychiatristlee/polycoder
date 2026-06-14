// poly's self-owned search engine: a local corpus of crawled pages + BM25 ranking.
// NOT web-scale — it searches what WE crawl/index (docs, references), so it's fast,
// offline, rate-limit-free, and fully under our control. Stored in its own sqlite file.
import { DatabaseSync } from "node:sqlite";
import { ensureConfigDir, searchDbFilePath } from "../config/paths.js";

export interface IndexedDoc {
  url: string;
  title: string;
  text: string;
  host: string;
  fetchedAt: number;
  tokens: number;
}

export interface SearchHit {
  url: string;
  title: string;
  host: string;
  score: number;
  snippet: string;
}

let db: DatabaseSync | null = null;
function getDb(): DatabaseSync {
  if (db) return db;
  ensureConfigDir();
  db = new DatabaseSync(searchDbFilePath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_docs (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      fetched_at INTEGER NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_search_host ON search_docs(host);
  `);
  return db;
}

/** Unicode-aware word tokenizer (keeps letters/digits across scripts incl. Hangul). */
export function tokenize(s: string): string[] {
  const m = s.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return m ? m.filter((t) => t.length >= 2) : [];
}

export function upsertDoc(d: IndexedDoc): void {
  getDb()
    .prepare(
      `INSERT INTO search_docs (url, title, text, host, fetched_at, tokens)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title=excluded.title, text=excluded.text, host=excluded.host,
         fetched_at=excluded.fetched_at, tokens=excluded.tokens`
    )
    .run(d.url, d.title, d.text, d.host, d.fetchedAt, d.tokens);
}

export function hasDoc(url: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM search_docs WHERE url=?`).get(url);
}

export function docCount(): number {
  return Number((getDb().prepare(`SELECT COUNT(*) AS c FROM search_docs`).get() as any).c);
}

export interface HostStat {
  host: string;
  docs: number;
}
export function statsByHost(): HostStat[] {
  const rows = getDb().prepare(`SELECT host, COUNT(*) AS docs FROM search_docs GROUP BY host ORDER BY docs DESC`).all() as any[];
  return rows.map((r) => ({ host: String(r.host), docs: Number(r.docs) }));
}

export function clearIndex(host?: string): number {
  const before = docCount();
  if (host) getDb().prepare(`DELETE FROM search_docs WHERE host=?`).run(host);
  else getDb().exec(`DELETE FROM search_docs`);
  return before - docCount();
}

function snippet(text: string, qterms: Set<string>): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const qt of qterms) {
    const i = lower.indexOf(qt);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) at = 0;
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + 200).replace(/\s+/g, " ").trim() + "…";
}

/**
 * BM25 search over the indexed corpus. Builds an in-memory term index per call
 * (fine for a CLI / bounded corpus); returns the top-k hits.
 */
export function search(query: string, k = 8): SearchHit[] {
  const docs = getDb().prepare(`SELECT url, title, text, host FROM search_docs`).all() as any[];
  if (!docs.length) return [];
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(`${d.title} ${d.text}`));
  const dl = docTokens.map((t) => t.length);
  const avgdl = dl.reduce((a, b) => a + b, 0) / N || 1;
  const qterms = [...new Set(tokenize(query))];
  if (!qterms.length) return [];

  // Document frequency per query term + per-doc term frequency tables.
  const tfs = docTokens.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const qt of qterms) {
    let c = 0;
    for (const tf of tfs) if (tf.has(qt)) c++;
    df.set(qt, c);
  }

  const k1 = 1.5;
  const b = 0.75;
  const hits = docs.map((d, i) => {
    let score = 0;
    for (const qt of qterms) {
      const f = tfs[i].get(qt) ?? 0;
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl[i]) / avgdl)));
    }
    return {
      url: String(d.url),
      title: String(d.title),
      host: String(d.host),
      score,
      snippet: snippet(String(d.text), new Set(qterms)),
    };
  });
  return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
