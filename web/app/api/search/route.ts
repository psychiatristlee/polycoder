import { NextRequest, NextResponse } from "next/server";
import { searchDocs } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const k = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("k") ?? "20", 10) || 20, 1), 50);
  if (!q) return NextResponse.json({ q, total: 0, hits: [] });
  try {
    const hits = await searchDocs(q, k);
    return NextResponse.json({ q, total: hits.length, hits });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "search failed" }, { status: 500 });
  }
}
