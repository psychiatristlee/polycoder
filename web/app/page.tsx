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
  const [token, setToken] = useState("");

  async function loadStats() {
    try {
      setStats(await (await fetch("/api/stats")).json());
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    loadStats();
    setToken(localStorage.getItem("polysearch_admin_token") || "");
    const qq = new URLSearchParams(window.location.search).get("q");
    if (qq) {
      setQ(qq);
      runSearch(qq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(term: string) {
    term = term.trim();
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

  async function go(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    if (typeof window !== "undefined") window.history.replaceState(null, "", "/?q=" + encodeURIComponent(term));
    runSearch(term);
  }

  async function doIndex(e: FormEvent) {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    if (!token.trim()) {
      setIdxMsg("관리자 토큰을 입력하세요 (크롤은 인증 필요).");
      return;
    }
    localStorage.setItem("polysearch_admin_token", token.trim());
    setIndexing(true);
    setIdxMsg("크롤링 중… (수십 초 걸릴 수 있어요)");
    try {
      const res = await fetch("/api/index", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token.trim() },
        body: JSON.stringify({ url: u, maxPages: +maxPages, depth: +depth }),
      });
      if (res.status === 401) {
        setIdxMsg("인증 실패: 관리자 토큰이 올바르지 않습니다.");
        setIndexing(false);
        return;
      }
      const r = await res.json();
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
        <summary>사이트 색인하기 (크롤 → 인덱스) · 🔒 관리자 전용</summary>
        <input
          type="password"
          placeholder="관리자 토큰"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--br)", background: "var(--card)", color: "var(--fg)" }}
        />
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
