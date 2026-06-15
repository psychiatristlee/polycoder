// Error telemetry sink for the polyrun desktop app. POST is open (clients have no key) but
// size-capped and lightly rate-limited; GET is admin-gated for triage. Stored in Cloud SQL
// (app_errors) so issues can later be fixed with Claude Code.
import { NextRequest, NextResponse } from "next/server";
import { insertError, listErrors } from "@/lib/db";
import { checkAdmin } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// crude global rate limit so the open endpoint can't be flooded
let windowStart = 0;
let windowCount = 0;
function rateLimited(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  return ++windowCount > 600; // 600 errors/min across all clients
}

export async function POST(req: NextRequest) {
  if (rateLimited()) return NextResponse.json({ ok: false, error: "rate limited" }, { status: 429 });
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const events = Array.isArray(b?.events) ? b.events : [b];
  let stored = 0;
  for (const e of events.slice(0, 20)) {
    if (!e || typeof e.message !== "string" || !e.message.trim()) continue;
    try {
      await insertError({
        appVersion: e.appVersion,
        platform: e.platform,
        userId: e.userId,
        userEmail: e.userEmail,
        source: e.source,
        message: e.message,
        stack: e.stack,
        context: e.context,
      });
      stored++;
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: err?.message ?? "insert failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, stored });
}

export async function GET(req: NextRequest) {
  if (!(await checkAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "100", 10) || 100;
  try {
    return NextResponse.json({ errors: await listErrors(limit) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "query failed" }, { status: 500 });
  }
}
