// Account registry for subagent discovery. Best-effort: writes node info to Firestore
// (subagents/{accountId}/nodes/{nodeId}) via the firebase-admin/ADC path already used
// by usage/firestoreSync.ts. If admin/creds are unavailable, every call no-ops and the
// caller falls back to copy-pasting the printed endpoint+token (`link --url --token`).
import { createHash } from "node:crypto";
import os from "node:os";
import { loadConfig, resolveApiKey } from "../config/store.js";

export function accountId(): string {
  const key = resolveApiKey(loadConfig()) || "anonymous";
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
export function nodeId(): string {
  return createHash("sha256").update(os.hostname() + (os.userInfo().username || "")).digest("hex").slice(0, 16);
}
export function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

async function db(): Promise<any | null> {
  try {
    const admin: any = await import("firebase-admin");
    if (!admin.apps?.length) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      admin.initializeApp(raw ? { credential: admin.credential.cert(JSON.parse(raw)) } : undefined);
    }
    return admin.firestore();
  } catch {
    return null;
  }
}

export interface NodeDoc {
  endpoint: string;
  transport: string;
  authTokenHash: string;
  model: string;
  models: string[];
  hardware: { gpu: string; vramGb: number; ramGb: number; platform: string };
  online: boolean;
  lastHeartbeat: number;
}

export async function register(doc: NodeDoc): Promise<boolean> {
  const d = await db();
  if (!d) return false;
  try {
    await d.collection("subagents").doc(accountId()).collection("nodes").doc(nodeId()).set(doc, { merge: true });
    return true;
  } catch {
    return false;
  }
}
export async function heartbeat(): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    await d.collection("subagents").doc(accountId()).collection("nodes").doc(nodeId()).set({ online: true, lastHeartbeat: Date.now() }, { merge: true });
  } catch {
    /* best-effort */
  }
}
export async function markOffline(): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    await d.collection("subagents").doc(accountId()).collection("nodes").doc(nodeId()).set({ online: false }, { merge: true });
  } catch {
    /* best-effort */
  }
}
export async function listNodes(): Promise<(NodeDoc & { id: string })[]> {
  const d = await db();
  if (!d) return [];
  try {
    const snap = await d.collection("subagents").doc(accountId()).collection("nodes").get();
    const cutoff = Date.now() - 90_000;
    return snap.docs
      .map((s: any) => ({ id: s.id, ...(s.data() as NodeDoc) }))
      .filter((n: any) => n.online && n.lastHeartbeat > cutoff);
  } catch {
    return [];
  }
}
