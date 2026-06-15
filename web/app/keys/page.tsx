"use client";
// Separate screen for API access: issue / list / revoke consumer API keys (admin-gated by
// the admin token) and show how to call the keyed REST API. The public search page (/) needs
// no key; only programmatic API use does. Crawling is done by the developer from the backend.
import { useEffect, useState, FormEvent } from "react";

interface KeyInfo {
  label: string;
  scope: string;
  revoked: boolean;
}

export default function Keys() {
  const [token, setToken] = useState("");
  const [authed, setAuthed] = useState(false);
  const [keys, setKeys] = useState<KeyInfo[] | null>(null);
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState("");
  const [msg, setMsg] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    const t = localStorage.getItem("polysearch_admin_token") || "";
    if (t) {
      setToken(t);
      loadKeys(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadKeys(t = token) {
    if (!t.trim()) return;
    setMsg("");
    try {
      const res = await fetch("/api/keys", { headers: { "x-admin-token": t.trim() } });
      if (res.status === 401) {
        setAuthed(false);
        setMsg("관리자 토큰이 올바르지 않습니다 (401).");
        return;
      }
      const r = await res.json();
      setKeys(r.keys || []);
      setAuthed(true);
      localStorage.setItem("polysearch_admin_token", t.trim());
    } catch {
      setMsg("불러오기에 실패했습니다.");
    }
  }

  async function issueKey(e: FormEvent) {
    e.preventDefault();
    if (!token.trim() || !label.trim()) return;
    setIssued("");
    const r = await (
      await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token.trim() },
        body: JSON.stringify({ label: label.trim(), scope: "search" }),
      })
    ).json();
    if (r.key) {
      setIssued(r.key);
      setLabel("");
      loadKeys();
    } else {
      setMsg(r.error || "발급 실패");
    }
  }

  async function revokeKey(lbl: string) {
    if (!token.trim()) return;
    await fetch("/api/keys?label=" + encodeURIComponent(lbl), { method: "DELETE", headers: { "x-admin-token": token.trim() } });
    loadKeys();
  }

  return (
    <div className="wrap">
      <h1>
        <span className="p">poly</span> search · API 키
      </h1>
      <p className="sub">
        웹에서 검색하는 일반 사용자는 키가 필요 없습니다. 프로그램에서 <b>API로</b> 검색할 때만 키가 필요합니다. · <a href="/">← 검색으로</a>
      </p>

      <input
        type="password"
        placeholder="🔒 관리자 토큰 (admin token)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onBlur={() => token.trim() && loadKeys()}
        style={{ width: "100%", marginBottom: 12, padding: "11px 14px", borderRadius: 10, border: "1px solid var(--br)", background: "var(--card)", color: "var(--fg)" }}
      />
      {!authed && <button className="ghost" onClick={() => loadKeys()}>관리자 인증</button>}
      {msg && <p className="meta" style={{ color: "#e0884f" }}>{msg}</p>}

      {authed && (
        <>
          <h3 style={{ marginTop: 26 }}>새 API 키 발급</h3>
          <form className="idx" onSubmit={issueKey}>
            <input className="url" type="text" placeholder="소비자 라벨 (예: my-app, teammate-1)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="ghost">키 발급</button>
          </form>
          {issued && (
            <div className="meta" style={{ marginTop: 8 }}>
              새 API 키 (한 번만 표시 — 지금 복사하세요):
              <br />
              <code style={{ color: "var(--grn)", wordBreak: "break-all" }}>{issued}</code>
            </div>
          )}

          <h3 style={{ marginTop: 26 }}>발급된 키</h3>
          {keys && keys.length === 0 && <p className="meta">아직 발급된 키가 없습니다.</p>}
          {keys &&
            keys.map((k) => (
              <div className="meta" key={k.label}>
                {k.revoked ? "🚫" : "✅"} {k.label} <span style={{ opacity: 0.6 }}>({k.scope})</span>{" "}
                {!k.revoked && (
                  <button className="ghost" style={{ padding: "2px 10px", fontSize: 12 }} onClick={() => revokeKey(k.label)}>
                    폐기
                  </button>
                )}
              </div>
            ))}

          <h3 style={{ marginTop: 26 }}>API 사용법</h3>
          <pre className="code" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--card)", border: "1px solid var(--br)", borderRadius: 10, padding: "12px 14px" }}>
{`curl "${origin || "https://<host>"}/api/search?q=hello&k=20" \\
  -H "x-search-token: <YOUR_API_KEY>"`}
          </pre>
          <p className="meta" style={{ fontSize: 12, opacity: 0.7 }}>
            응답: {`{ q, total, hits: [{ url, title, host, snippet }] }`} · k는 결과 수(1–50).
          </p>
        </>
      )}
    </div>
  );
}
