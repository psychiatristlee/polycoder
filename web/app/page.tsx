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
  const [searchKey, setSearchKey] = useState("");
  const [searchErr, setSearchErr] = useState("");
  const [keys, setKeys] = useState<{ label: string; scope: string; revoked: boolean }[] | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [issued, setIssued] = useState("");

  async function loadStats(key?: string) {
    const k = (key ?? searchKey).trim();
    if (!k) {
      setStats(null);
      return;
    }
    try {
      setStats(await (await fetch("/api/stats", { headers: { "x-search-token": k } })).json());
    } catch {
      /* ignore */
    }
  }

  async function runSearch(term: string, key?: string) {
    term = term.trim();
    const k = (key ?? searchKey).trim();
    if (!term) return;
    if (!k) {
      setSearchErr("검색 키가 필요합니다 (아래 '검색 키'에 입력).");
      setHits([]);
      return;
    }
    setSearchErr("");
    setLoading(true);
    setHits(null);
    try {
      const res = await fetch("/api/search?q=" + encodeURIComponent(term), { headers: { "x-search-token": k } });
      if (res.status === 401) {
        setSearchErr("검색 키가 올바르지 않습니다 (401).");
        setHits([]);
        setLoading(false);
        return;
      }
      const r = await res.json();
      setHits(r.hits || []);
    } catch {
      setHits([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    const sk = localStorage.getItem("polysearch_search_key") || "";
    setSearchKey(sk);
    setToken(localStorage.getItem("polysearch_admin_token") || "");
    if (sk) loadStats(sk);
    const qq = new URLSearchParams(window.location.search).get("q");
    if (qq) {
      setQ(qq);
      if (sk) runSearch(qq, sk);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function go(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    if (searchKey.trim()) localStorage.setItem("polysearch_search_key", searchKey.trim());
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

  async function loadKeys() {
    if (!token.trim()) return;
    try {
      const r = await (await fetch("/api/keys", { headers: { "x-admin-token": token.trim() } })).json();
      setKeys(r.keys || []);
    } catch {
      /* ignore */
    }
  }
  async function issueKey() {
    if (!token.trim() || !newLabel.trim()) return;
    const r = await (
      await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token.trim() },
        body: JSON.stringify({ label: newLabel.trim() }),
      })
    ).json();
    if (r.key) {
      setIssued(r.key);
      setNewLabel("");
      loadKeys();
    }
  }
  async function revokeKey(label: string) {
    if (!token.trim()) return;
    await fetch("/api/keys?label=" + encodeURIComponent(label), { method: "DELETE", headers: { "x-admin-token": token.trim() } });
    loadKeys();
  }

  return (
    <div className="wrap">
      <h1>
        <span className="p">poly</span> search
      </h1>
      <p className="sub">내가 크롤링한 코퍼스를 Postgres 풀텍스트로 검색 · Firebase App Hosting + Cloud SQL · 🔑 키 필요</p>

      <input
        type="password"
        placeholder="🔑 검색 키 (Search key)"
        value={searchKey}
        onChange={(e) => setSearchKey(e.target.value)}
        onBlur={() => {
          if (searchKey.trim()) {
            localStorage.setItem("polysearch_search_key", searchKey.trim());
            loadStats(searchKey.trim());
          }
        }}
        style={{ width: "100%", marginBottom: 10, padding: "11px 14px", borderRadius: 10, border: "1px solid var(--br)", background: "var(--card)", color: "var(--fg)" }}
      />

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
        {searchErr && <p className="meta" style={{ color: "#e0884f" }}>{searchErr}</p>}
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

      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadKeys()}>
        <summary>🔑 검색 키 발급/관리 (관리자) · 여러 소비자용</summary>
        <div className="meta" style={{ fontSize: 12 }}>위 색인 섹션의 관리자 토큰이 필요합니다.</div>
        <form className="idx" onSubmit={(e) => { e.preventDefault(); issueKey(); }}>
          <input className="url" type="text" placeholder="소비자 라벨 (예: my-app, teammate-1)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button className="ghost">키 발급</button>
        </form>
        {issued && (
          <div className="meta">
            새 검색 키 (한 번만 표시 — 지금 복사하세요):
            <br />
            <code style={{ color: "var(--grn)", wordBreak: "break-all" }}>{issued}</code>
          </div>
        )}
        {keys &&
          keys.map((k) => (
            <div className="meta" key={k.label}>
              {k.revoked ? "🚫" : "✅"} {k.label} <span style={{ opacity: 0.6 }}>({k.scope})</span>{" "}
              {!k.revoked && (
                <button className="ghost" style={{ padding: "2px 10px", fontSize: 12 }} onClick={(e) => { e.preventDefault(); revokeKey(k.label); }}>
                  폐기
                </button>
              )}
            </div>
          ))}
      </details>
    </div>
  );
}
