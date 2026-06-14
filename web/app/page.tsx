"use client";
import { useEffect, useState, FormEvent } from "react";

interface Hit {
  url: string;
  title: string;
  host: string;
  snippet: string;
}
interface Stats {
  docs: number;
  hosts: { host: string; docs: number }[];
}

export default function Home() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState("25");
  const [depth, setDepth] = useState("1");
  const [idxMsg, setIdxMsg] = useState("");
  const [indexing, setIndexing] = useState(false);

  async function loadStats() {
    try {
      setStats(await (await fetch("/api/stats")).json());
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadStats();
  }, []);

  async function go(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setLoading(true);
    setHits(null);
    try {
      const r = await (await fetch("/api/search?q=" + encodeURIComponent(term))).json();
      setHits(r.hits || []);
    } catch {
      setHits([]);
    }
    setLoading(false);
  }

  async function doIndex(e: FormEvent) {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    setIndexing(true);
    setIdxMsg("크롤링 중… (수십 초 걸릴 수 있어요)");
    try {
      const r = await (
        await fetch("/api/index", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: u, maxPages: +maxPages, depth: +depth }),
        })
      ).json();
      setIdxMsg(r.error ? "오류: " + r.error : `완료: ${r.indexed}개 색인 (방문 ${r.visited})`);
      loadStats();
    } catch {
      setIdxMsg("오류가 발생했어요");
    }
    setIndexing(false);
  }

  return (
    <div className="wrap">
      <h1>
        <span className="p">poly</span> search
      </h1>
      <p className="sub">내가 크롤링한 코퍼스를 Postgres 풀텍스트로 검색 · Firebase App Hosting + Cloud SQL</p>

      <form className="row" onSubmit={go}>
        <input type="text" placeholder="검색어를 입력하세요…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button disabled={loading}>{loading ? "검색 중…" : "검색"}</button>
      </form>

      {stats && (
        <div className="meta">
          색인 문서 {stats.docs}개{" "}
          {stats.hosts?.map((h) => (
            <span className="badge" key={h.host}>
              {h.host} · {h.docs}
            </span>
          ))}
        </div>
      )}

      <div>
        {loading && <p className="meta spin">검색 중…</p>}
        {hits && hits.length === 0 && !loading && <p className="meta">결과 없음. 먼저 사이트를 색인하세요.</p>}
        {hits &&
          hits.map((h) => (
            <div className="hit" key={h.url}>
              <a href={h.url} target="_blank" rel="noreferrer">
                {h.title || h.url}
              </a>
              <div className="u">{h.url}</div>
              <div className="s">{h.snippet}</div>
            </div>
          ))}
      </div>

      <details>
        <summary>사이트 색인하기 (크롤 → 인덱스)</summary>
        <form className="idx" onSubmit={doIndex}>
          <input className="url" type="text" placeholder="https://docs.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="n" type="text" value={maxPages} onChange={(e) => setMaxPages(e.target.value)} title="max pages" />
          <input className="n" type="text" value={depth} onChange={(e) => setDepth(e.target.value)} title="depth" />
          <button className="ghost" disabled={indexing}>
            {indexing ? "색인 중…" : "색인"}
          </button>
        </form>
        {idxMsg && <div className="meta">{idxMsg}</div>}
      </details>
    </div>
  );
}
