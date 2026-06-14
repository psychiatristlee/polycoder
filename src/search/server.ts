// Always-on local search service + web GUI. `poly search serve` starts an HTTP
// server that serves a search page and JSON APIs over the local BM25 index, plus an
// "index a site" form that crawls on demand. Runs on the user's machine (localhost);
// optionally auto-starts at login via a macOS LaunchAgent (--install).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { search, statsByHost, docCount, clearIndex } from "./engine.js";
import { crawl } from "./crawl.js";

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function json(res: http.ServerResponse, obj: unknown, status = 200): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(""));
  });
}

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>poly search</title>
<style>
  :root{--bg:#0f1115;--card:#1a1d24;--fg:#e7e9ee;--mut:#9aa3b2;--ac:#6ea8fe;--br:#2a2f3a}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Pretendard,"Noto Sans KR",sans-serif;background:var(--bg);color:var(--fg)}
  .wrap{max-width:760px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:30px;margin:8px 0 2px;letter-spacing:-.5px}
  h1 .p{color:var(--ac)}
  .sub{color:var(--mut);margin:0 0 22px;font-size:14px}
  .row{display:flex;gap:8px}
  input,button{font:inherit}
  input[type=text]{flex:1;padding:13px 16px;border-radius:12px;border:1px solid var(--br);background:var(--card);color:var(--fg);outline:none}
  input[type=text]:focus{border-color:var(--ac)}
  button{padding:13px 18px;border-radius:12px;border:0;background:var(--ac);color:#06122b;font-weight:700;cursor:pointer}
  button.ghost{background:transparent;border:1px solid var(--br);color:var(--mut);font-weight:500}
  .hit{padding:16px;border:1px solid var(--br);border-radius:14px;background:var(--card);margin-top:12px}
  .hit a{color:var(--ac);text-decoration:none;font-weight:600;font-size:18px}
  .hit a:hover{text-decoration:underline}
  .hit .u{color:#74c98a;font-size:12px;margin:3px 0;word-break:break-all}
  .hit .s{color:var(--mut);font-size:14px}
  .meta{color:var(--mut);font-size:13px;margin:18px 0 4px}
  details{margin-top:22px;border-top:1px solid var(--br);padding-top:16px}
  summary{cursor:pointer;color:var(--mut)}
  .idx{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;margin-top:12px}
  .idx input{padding:10px 12px}
  .badge{display:inline-block;background:var(--card);border:1px solid var(--br);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--mut);margin:2px 4px 0 0}
  .spin{color:var(--ac)}
</style></head><body><div class="wrap">
  <h1><span class="p">poly</span> search</h1>
  <p class="sub">로컬 BM25 검색엔진 · 내가 색인한 코퍼스만 · 오프라인 · $0</p>
  <form class="row" onsubmit="go(event)">
    <input id="q" type="text" placeholder="검색어를 입력하세요…" autofocus>
    <button>검색</button>
  </form>
  <div id="stats" class="meta"></div>
  <div id="results"></div>
  <details>
    <summary>사이트 색인하기 (크롤 → 인덱스)</summary>
    <div class="idx">
      <input id="url" type="text" placeholder="https://docs.example.com">
      <input id="max" type="text" value="25" title="max pages" style="width:80px">
      <input id="depth" type="text" value="1" title="depth" style="width:60px">
      <button class="ghost" onclick="index(event)">색인</button>
    </div>
    <div id="idxlog" class="meta"></div>
  </details>
<script>
async function loadStats(){
  const r=await fetch('/api/stats').then(r=>r.json());
  document.getElementById('stats').innerHTML = '색인 문서 '+r.docs+'개 ' + (r.hosts||[]).map(h=>'<span class="badge">'+h.host+' · '+h.docs+'</span>').join('');
}
async function go(e){e.preventDefault();
  const q=document.getElementById('q').value.trim(); if(!q)return;
  const el=document.getElementById('results'); el.innerHTML='<p class="meta spin">검색 중…</p>';
  const r=await fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json());
  if(!r.hits.length){el.innerHTML='<p class="meta">결과 없음. 먼저 사이트를 색인하세요.</p>';return;}
  el.innerHTML='<p class="meta">'+r.hits.length+'개 결과</p>'+r.hits.map(h=>
    '<div class="hit"><a href="'+h.url+'" target="_blank">'+esc(h.title||h.url)+'</a><div class="u">'+esc(h.url)+'</div><div class="s">'+esc(h.snippet)+'</div></div>').join('');
}
async function index(e){e.preventDefault();
  const url=document.getElementById('url').value.trim(); if(!url)return;
  const log=document.getElementById('idxlog'); log.innerHTML='<span class="spin">크롤링 중… (수십 초 걸릴 수 있음)</span>';
  const r=await fetch('/api/index',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url,maxPages:+document.getElementById('max').value,depth:+document.getElementById('depth').value})}).then(r=>r.json());
  log.textContent = r.error ? ('오류: '+r.error) : ('완료: '+r.indexed+'개 색인 (방문 '+r.visited+')');
  loadStats();
}
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
loadStats();
</script>
</div></body></html>`;

export interface ServeOptions {
  port?: number;
}

export function serveSearch(opts: ServeOptions = {}): Promise<void> {
  const port = opts.port ?? 8787;
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (req.method === "GET" && u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/search") {
        const q = u.searchParams.get("q") ?? "";
        const k = clampInt(u.searchParams.get("k"), 1, 50, 20);
        const hits = q.trim() ? search(q, k) : [];
        json(res, { q, total: hits.length, hits });
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/stats") {
        json(res, { docs: docCount(), hosts: statsByHost() });
        return;
      }
      if (req.method === "POST" && u.pathname === "/api/index") {
        const p: any = JSON.parse((await readBody(req)) || "{}");
        const seeds = String(p.url ?? "").split(/\s+/).filter(Boolean);
        if (!seeds.length) return json(res, { error: "no url" }, 400);
        const r = await crawl(seeds, {
          maxPages: clampInt(p.maxPages, 1, 200, 25),
          depth: clampInt(p.depth, 0, 3, 1),
          sameDomain: !p.allDomains,
        });
        json(res, r);
        return;
      }
      if (req.method === "POST" && u.pathname === "/api/clear") {
        const removed = clearIndex();
        json(res, { removed });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err: any) {
      json(res, { error: err?.message ?? String(err) }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`poly search serving at http://localhost:${port}  (docs indexed: ${docCount()})  — Ctrl+C to stop`);
    });
    server.on("close", () => resolve());
  });
}

/** Install a macOS LaunchAgent so the server auto-starts at login (always-on). */
export function installLaunchAgent(port: number): { ok: boolean; message: string } {
  if (process.platform !== "darwin") return { ok: false, message: "Auto-start install is macOS-only (use a systemd unit / pm2 elsewhere)." };
  let polyBin = "";
  try {
    polyBin = execSync("command -v poly", { encoding: "utf8" }).trim();
  } catch {
    return { ok: false, message: "Could not locate the `poly` binary on PATH." };
  }
  const label = "com.polymath.search";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const nodeBin = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${nodeBin}</string><string>${polyBin}</string><string>search</string><string>serve</string><string>--port</string><string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(os.tmpdir(), "polymath-search.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(os.tmpdir(), "polymath-search.err")}</string>
</dict></plist>`;
  try {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist);
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    execSync(`launchctl load "${plistPath}"`, { stdio: "ignore" });
    return { ok: true, message: `Installed LaunchAgent → ${plistPath}\nAuto-starts at login. Open http://localhost:${port}` };
  } catch (e: any) {
    return { ok: false, message: `Failed to install LaunchAgent: ${e?.message ?? e}` };
  }
}
