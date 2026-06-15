"use client";
import { useEffect, useState, FormEvent } from "react";
import { publicSearch, publicStats } from "./actions";

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
  const [err, setErr] = useState("");

  async function runSearch(term: string) {
    term = term.trim();
    if (!term) return;
    setErr("");
    setLoading(true);
    setHits(null);
    try {
      const r = await publicSearch(term);
      if (r.error) setErr(r.error);
      setHits(r.hits || []);
    } catch {
      setHits([]);
      setErr("검색에 실패했어요. 잠시 후 다시 시도해 주세요.");
    }
    setLoading(false);
  }

  useEffect(() => {
    publicStats().then((s) => setStats(s as Stats | null));
    const qq = new URLSearchParams(window.location.search).get("q");
    if (qq) {
      setQ(qq);
      runSearch(qq);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function go(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    if (typeof window !== "undefined") window.history.replaceState(null, "", "/?q=" + encodeURIComponent(term));
    runSearch(term);
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
        {err && <p className="meta" style={{ color: "#e0884f" }}>{err}</p>}
        {loading && <p className="meta spin">검색 중…</p>}
        {hits && hits.length === 0 && !loading && !err && <p className="meta">결과 없음.</p>}
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

      <p className="meta" style={{ marginTop: 36, opacity: 0.7 }}>
        프로그램에서 API로 검색하시나요? <a href="/keys">API 키 발급 →</a>
      </p>
    </div>
  );
}
