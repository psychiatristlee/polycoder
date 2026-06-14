import { NextRequest, NextResponse } from "next/server";
import { crawl } from "@/lib/crawl";
import { checkAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function clamp(v: any, min: number, max: number, d: number): number {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
}

export async function POST(req: NextRequest) {
  if (!(await checkAdmin(req))) {
    return NextResponse.json({ error: "unauthorized — admin token required" }, { status: 401 });
  }
  try {
    const b = await req.json();
    const seeds = String(b.url ?? "").split(/\s+/).filter(Boolean);
    if (!seeds.length) return NextResponse.json({ error: "no url" }, { status: 400 });
    const r = await crawl(seeds, {
      maxPages: clamp(b.maxPages, 1, 100, 20),
      depth: clamp(b.depth, 0, 3, 1),
      sameDomain: !b.allDomains,
    });
    return NextResponse.json(r);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "index failed" }, { status: 500 });
  }
}
