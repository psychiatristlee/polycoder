"use server";
// Public, keyless search for the website GUI. Server Actions are same-origin POSTs guarded
// by Next's action protocol, so the browser can search freely while the REST API
// (/api/search) stays key-gated for programmatic consumers. Crawling/indexing is NOT here —
// the developer runs it from the backend (see /api/index, admin-gated).
import { searchDocs, stats, type Hit, type Stats } from "@/lib/db";

export async function publicSearch(q: string, k = 20): Promise<{ hits: Hit[]; error?: string }> {
  const term = (q || "").trim();
  if (!term) return { hits: [] };
  try {
    return { hits: await searchDocs(term, Math.min(Math.max(k, 1), 50)) };
  } catch (e: any) {
    return { hits: [], error: e?.message ?? "search failed" };
  }
}

export async function publicStats(): Promise<Stats | null> {
  try {
    return await stats();
  } catch {
    return null;
  }
}
