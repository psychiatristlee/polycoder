// Auth-proxy in front of Ollama. Ollama has NO native auth, so we NEVER expose :11434.
// This proxy requires a Bearer relay-token, allowlists only inference routes, and
// streams (SSE) through to Ollama on localhost. The token is the security boundary.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

const ALLOW = new Set(["/v1/chat/completions", "/v1/completions", "/v1/models", "/v1/embeddings"]);

function tokenOk(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface ProxyOptions {
  port?: number;
  host?: string; // 0.0.0.0 to allow LAN; tunnel connects via localhost regardless
  token: string;
  ollamaPort?: number;
}

export function startProxy(opts: ProxyOptions): Promise<http.Server> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? "0.0.0.0";
  const ollamaPort = opts.ollamaPort ?? 11434;
  // Behind a reverse tunnel every request shares the tunnel's source IP, so a per-IP
  // lockout is useless (and would unfairly lock everyone out). Use a GLOBAL failed-auth
  // limiter with exponential backoff; a single valid request resets it.
  const lockout = { fails: 0, until: 0 };

  const server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];

    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"service":"polyrun-subagent"}');
      return;
    }

    if (lockout.until > Date.now()) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":"too many failed attempts; locked out briefly"}');
      return;
    }

    const provided = (req.headers["authorization"] || "").toString().replace(/^Bearer\s+/i, "");
    if (!tokenOk(provided, opts.token)) {
      lockout.fails++;
      // 5 strikes → 30s, then doubling up to ~30 min. Reset on the next valid request.
      if (lockout.fails >= 5) lockout.until = Date.now() + Math.min(30_000 * 2 ** (lockout.fails - 5), 1_800_000);
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized — valid relay token required"}');
      return;
    }
    lockout.fails = 0;
    lockout.until = 0;

    if (!ALLOW.has(path)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"path not allowed on subagent proxy"}');
      return;
    }

    // Forward to local Ollama (OpenAI-compatible), strip our relay token.
    const headers = { ...req.headers, host: `127.0.0.1:${ollamaPort}` };
    delete (headers as any).authorization;
    const upstream = http.request(
      { host: "127.0.0.1", port: ollamaPort, path: req.url, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":"ollama upstream unreachable on 127.0.0.1:' + ollamaPort + '"}');
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
