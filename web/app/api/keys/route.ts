// Admin-only API-key management: issue / list / revoke consumer search keys.
// All gated by the admin token. Issued key is returned ONCE (only its hash is stored).
import { NextRequest, NextResponse } from "next/server";
import { checkAdmin } from "@/lib/auth";
import { issueApiKey, listApiKeys, revokeApiKey } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await checkAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ keys: await listApiKeys() });
}

export async function POST(req: NextRequest) {
  if (!(await checkAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const label = String(b.label ?? "consumer");
  const scope = b.scope === "admin" ? "admin" : "search";
  const issued = await issueApiKey(label, scope);
  return NextResponse.json(issued); // { key, label, scope } — key shown once
}

export async function DELETE(req: NextRequest) {
  if (!(await checkAdmin(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const label = req.nextUrl.searchParams.get("label") ?? "";
  if (!label) return NextResponse.json({ error: "label required" }, { status: 400 });
  return NextResponse.json({ revoked: await revokeApiKey(label) });
}
