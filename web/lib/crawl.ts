// Server-side crawler for the hosted search engine. BFS over seed URLs, extract
// readable text + links, upsert into Cloud SQL. Bounded + SSRF-guarded + polite.
import { upsertDoc, docExists } from "./db";

const UA =
  "Mozilla/5.0 (compatible; PolySearchBot/0.1; +https://github.com/psychiatristlee/polycoder)";

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function safe(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safe(parseInt(d, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : "";
}

function extractLinks(html: string, base: URL): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        out.push(u.href);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url: string): Promise<{ status: number; ctype: string; body: string } | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow", headers: { "user-agent": UA, accept: "text/html,*/*" } });
    return { status: res.status, ctype: res.headers.get("content-type") ?? "", body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface CrawlOptions {
  maxPages?: number;
  depth?: number;
  sameDomain?: boolean;
  recrawl?: boolean;
}
export interface CrawlResult {
  indexed: number;
  visited: number;
}

export async function crawl(seeds: string[], opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = Math.min(opts.maxPages ?? 20, 100);
  const maxDepth = Math.min(opts.depth ?? 1, 3);
  const sameDomain = opts.sameDomain ?? true;
  const seedHosts = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    try {
      const u = new URL(s);
      u.hash = "";
      seedHosts.add(u.hostname);
      queue.push({ url: u.href, depth: 0 });
      seen.add(u.href);
    } catch {
      /* skip bad seed */
    }
  }

  let indexed = 0;
  let visited = 0;
  while (queue.length && indexed < maxPages) {
    const { url, depth } = queue.shift()!;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (isBlockedHost(host)) continue;
    visited++;
    if (!opts.recrawl && (await docExists(url))) {
      // already indexed; still expand links below
    }
    const page = await fetchHtml(url);
    if (!page || page.status >= 400 || !/html/i.test(page.ctype)) continue;
    const text = htmlToText(page.body);
    if (text.length > 80) {
      await upsertDoc({ url, title: extractTitle(page.body) || url, host, body: text });
      indexed++;
    }
    if (depth < maxDepth) {
      for (const link of extractLinks(page.body, new URL(url))) {
        if (seen.has(link) || seen.size > maxPages * 6) continue;
        try {
          if (sameDomain && !seedHosts.has(new URL(link).hostname)) continue;
        } catch {
          continue;
        }
        seen.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }
    }
    await delay(150);
  }
  return { indexed, visited };
}
