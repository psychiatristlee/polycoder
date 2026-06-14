// The crawler that feeds poly's search engine: BFS over seed URLs, extract readable
// text + links, index each page. Bounded by maxPages/depth, same-domain by default,
// SSRF-guarded, polite. This is how the "self-owned" corpus gets built.
import { tokenize, upsertDoc, hasDoc } from "./engine.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
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
function safe(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
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
      /* skip bad href */
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
    const ctype = res.headers.get("content-type") ?? "";
    const body = await res.text();
    return { status: res.status, ctype, body };
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
  recrawl?: boolean; // re-fetch pages already indexed
  onProgress?: (info: { indexed: number; url: string }) => void;
}

export interface CrawlResult {
  indexed: number;
  visited: number;
  seeds: string[];
}

export async function crawl(seeds: string[], opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 25;
  const maxDepth = opts.depth ?? 1;
  const sameDomain = opts.sameDomain ?? true;
  const seedHosts = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    try {
      const u = new URL(s);
      seedHosts.add(u.hostname);
      u.hash = "";
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
    if (!opts.recrawl && hasDoc(url)) {
      // still expand its links if within depth
    } else {
      const page = await fetchHtml(url);
      if (page && /html/i.test(page.ctype) && page.status < 400) {
        const text = htmlToText(page.body);
        if (text.length > 80) {
          upsertDoc({ url, title: extractTitle(page.body) || url, text: text.slice(0, 40000), host, fetchedAt: Date.now(), tokens: tokenize(text).length });
          indexed++;
          opts.onProgress?.({ indexed, url });
        }
        // enqueue links
        if (depth < maxDepth) {
          for (const link of extractLinks(page.body, new URL(url))) {
            if (seen.has(link) || queue.length + indexed > maxPages * 4) continue;
            try {
              const lh = new URL(link).hostname;
              if (sameDomain && !seedHosts.has(lh)) continue;
            } catch {
              continue;
            }
            seen.add(link);
            queue.push({ url: link, depth: depth + 1 });
          }
        }
        await delay(200); // be polite
      }
    }
  }
  return { indexed, visited, seeds };
}
