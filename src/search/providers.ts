// Pluggable web-search providers for the poly agent. Search is DECOUPLED from poly:
// pick a provider via config (`poly config set searchprovider ...`). Options:
//   - duckduckgo : keyless HTML scrape (default, free, rate-limited)
//   - brave      : Brave Search API (needs an API key)
//   - polysearch : our own hosted engine (free but key-gated, like the others)
import { loadConfig } from "../config/store.js";

export interface SearchProviderConfig {
  provider: string; // "duckduckgo" | "brave" | "polysearch"
  braveApiKey?: string;
  polysearchUrl?: string;
  polysearchKey?: string;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}
export interface SearchOutcome {
  provider: string;
  results: WebResult[];
  error?: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function get(url: string, headers: Record<string, string> = {}, timeoutMs = 15000): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: c.signal, redirect: "follow", headers: { "user-agent": UA, ...headers } });
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/\s+/g, " ")
    .trim();
}
function safeCp(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

async function duckduckgo(query: string, n: number): Promise<SearchOutcome> {
  const res = await get("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
  const body = await res.text();
  const results: WebResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(body))) snippets.push(stripTags(s[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(body)) && results.length < n) {
    let href = m[1];
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        /* keep */
      }
    }
    if (href.startsWith("//")) href = "https:" + href;
    results.push({ title: stripTags(m[2]), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return { provider: "duckduckgo", results };
}

async function brave(query: string, n: number, cfg: SearchProviderConfig): Promise<SearchOutcome> {
  if (!cfg.braveApiKey) return { provider: "brave", results: [], error: "missing Brave key — `poly config set bravekey <key>`" };
  const res = await get(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
    { "X-Subscription-Token": cfg.braveApiKey, Accept: "application/json" }
  );
  if (res.status === 401 || res.status === 403) return { provider: "brave", results: [], error: `Brave key rejected (${res.status})` };
  if (!res.ok) return { provider: "brave", results: [], error: `Brave API error ${res.status}` };
  const j: any = await res.json();
  const results = (j.web?.results ?? []).slice(0, n).map((r: any) => ({
    title: stripTags(r.title ?? ""),
    url: r.url,
    snippet: stripTags(r.description ?? ""),
  }));
  return { provider: "brave", results };
}

async function polysearch(query: string, n: number, cfg: SearchProviderConfig): Promise<SearchOutcome> {
  if (!cfg.polysearchUrl) return { provider: "polysearch", results: [], error: "missing url — `poly config set polysearchurl <url>`" };
  if (!cfg.polysearchKey) return { provider: "polysearch", results: [], error: "missing key — `poly config set polysearchkey <key>`" };
  const base = cfg.polysearchUrl.replace(/\/$/, "");
  const res = await get(`${base}/api/search?q=${encodeURIComponent(query)}&k=${n}`, { "x-search-token": cfg.polysearchKey });
  if (res.status === 401) return { provider: "polysearch", results: [], error: "invalid polysearch key (401)" };
  if (!res.ok) return { provider: "polysearch", results: [], error: `polysearch error ${res.status}` };
  const j: any = await res.json();
  const results = (j.hits ?? []).slice(0, n).map((h: any) => ({ title: h.title, url: h.url, snippet: h.snippet ?? "" }));
  return { provider: "polysearch", results };
}

/** Resolve the configured search provider (config.search) unless overridden. */
export function resolveSearchConfig(): SearchProviderConfig {
  try {
    const s = (loadConfig() as any).search ?? {};
    return { provider: s.provider || "duckduckgo", braveApiKey: s.braveApiKey, polysearchUrl: s.polysearchUrl, polysearchKey: s.polysearchKey };
  } catch {
    return { provider: "duckduckgo" };
  }
}

/** Search the web via the configured (or given) provider. Never throws. */
export async function searchWeb(query: string, count = 5, override?: SearchProviderConfig): Promise<SearchOutcome> {
  const cfg = override ?? resolveSearchConfig();
  const provider = (cfg.provider || "duckduckgo").toLowerCase();
  const n = Math.min(Math.max(count, 1), 10);
  try {
    if (provider === "brave") return await brave(query, n, cfg);
    if (provider === "polysearch") return await polysearch(query, n, cfg);
    return await duckduckgo(query, n);
  } catch (e: any) {
    return { provider, results: [], error: e?.name === "AbortError" ? "timed out" : e?.message ?? String(e) };
  }
}
