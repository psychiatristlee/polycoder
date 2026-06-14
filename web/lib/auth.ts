// Simple shared-secret admin auth for mutating endpoints (crawl). The token lives in
// the ADMIN_TOKEN env (from Secret Manager). Compared in constant time. Fails closed:
// if no token is configured, access is denied.
import { timingSafeEqual } from "node:crypto";

export function checkAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN || "";
  if (!expected) return false;
  const provided =
    req.headers.get("x-admin-token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
