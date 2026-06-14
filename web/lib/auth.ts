// Shared-secret auth. Two keys:
//   ADMIN_TOKEN  — required to crawl/index (write). Owner only.
//   SEARCH_TOKEN — required to search/stats (read). The "API key" consumers (e.g. the
//                  poly agent's polysearch provider) present — free but key-gated.
// Constant-time comparison; fails closed if the relevant token isn't configured.
import { timingSafeEqual } from "node:crypto";

function bearer(req: Request, header: string): string {
  return req.headers.get(header) || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

function matches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function checkAdmin(req: Request): boolean {
  return matches(bearer(req, "x-admin-token"), process.env.ADMIN_TOKEN || "");
}

export function checkSearch(req: Request): boolean {
  return matches(bearer(req, "x-search-token"), process.env.SEARCH_TOKEN || "");
}
