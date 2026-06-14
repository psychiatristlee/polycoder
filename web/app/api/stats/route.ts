import { NextRequest, NextResponse } from "next/server";
import { stats } from "@/lib/db";
import { checkSearch } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!checkSearch(req)) return NextResponse.json({ error: "unauthorized — search key required" }, { status: 401 });
  try {
    return NextResponse.json(await stats());
  } catch (e: any) {
    return NextResponse.json({ docs: 0, hosts: [], error: e?.message }, { status: 200 });
  }
}
