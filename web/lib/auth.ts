// Auth for the search engine. A request is authorized if it presents EITHER:
//   - the env master token for the scope (ADMIN_TOKEN / SEARCH_TOKEN), OR
//   - a valid, non-revoked DB-issued API key with that scope (multi-consumer).
// Free but key-gated. Constant-time env comparison; DB keys looked up by SHA-256 hash.
import { timingSafeEqual } from "node:crypto";
import { keyValid } from "./db";

function bearer(req: Request, header: string): string {
  return req.headers.get(header) || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
}

function envMatch(provided: string, expected: string): boolean {
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

async function authorize(req: Request, header: string, envToken: string, scope: string): Promise<boolean> {
  const provided = bearer(req, header);
  if (!provided) return false;
  if (envMatch(provided, envToken)) return true;
  try {
    return await keyValid(provided, scope);
  } catch {
    return false;
  }
}

export function checkAdmin(req: Request): Promise<boolean> {
  return authorize(req, "x-admin-token", process.env.ADMIN_TOKEN || "", "admin");
}

export function checkSearch(req: Request): Promise<boolean> {
  return authorize(req, "x-search-token", process.env.SEARCH_TOKEN || "", "search");
}
