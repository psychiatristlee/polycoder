import { NextResponse } from "next/server";
import { stats } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await stats());
  } catch (e: any) {
    return NextResponse.json({ docs: 0, hosts: [], error: e?.message }, { status: 200 });
  }
}
