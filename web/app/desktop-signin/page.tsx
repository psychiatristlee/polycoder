"use client";
// Sign-in page the polyrun desktop app opens in the system browser. Does a Firebase Google
// popup sign-in (uses Firebase's managed OAuth — no separate client needed, just the Google
// provider enabled), then hands the signed-in user back to the app's loopback server.
import { useEffect, useState, useCallback } from "react";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth";

const cfg = {
  apiKey: "AIzaSyB1fH68NPbwZ0aNlTSo5nmsm30W49MDhTQ",
  authDomain: "mathology-b8e3d.firebaseapp.com",
  projectId: "mathology-b8e3d",
};

export default function DesktopSignin() {
  const [msg, setMsg] = useState("Google 계정으로 로그인합니다…");
  const [busy, setBusy] = useState(true);

  const run = useCallback(async () => {
    setBusy(true);
    setMsg("Google 로그인 창을 엽니다…");
    try {
      const port = new URLSearchParams(window.location.search).get("port");
      if (!getApps().length) initializeApp(cfg);
      const auth = getAuth();
      const res = await signInWithPopup(auth, new GoogleAuthProvider());
      const u = res.user;
      setMsg("로그인 완료 — polyrun으로 돌아갑니다…");
      if (port && /^\d+$/.test(port)) {
        const q = new URLSearchParams({ uid: u.uid, email: u.email || "", name: u.displayName || "" });
        window.location.href = `http://127.0.0.1:${port}/cb?${q.toString()}`;
      } else {
        setMsg("✓ 로그인됨. 이 창을 닫고 앱으로 돌아가세요.");
        setBusy(false);
      }
    } catch (e: any) {
      setMsg("로그인 실패: " + (e?.message || String(e)));
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  return (
    <div style={{ maxWidth: 420, margin: "16vh auto", textAlign: "center", fontFamily: "system-ui,sans-serif", color: "#2a211e" }}>
      <h2 style={{ fontFamily: "Georgia,serif", color: "#6e2436" }}>polyrun 로그인</h2>
      <p style={{ color: "#8a7d6e" }}>{msg}</p>
      {!busy && (
        <button onClick={run} style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d8cab2", background: "#6e2436", color: "#fff", cursor: "pointer", fontSize: 14 }}>
          Google로 다시 로그인
        </button>
      )}
    </div>
  );
}
