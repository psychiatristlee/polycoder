import type { PolymathConfig } from "../config/store.js";
import { unsyncedRows, markSynced } from "./db.js";

export interface SyncResult {
  synced: number;
  message: string;
}

/**
 * Push unsynced usage rows to Firestore (optional). Credentials, in order:
 *   1. FIREBASE_SERVICE_ACCOUNT_KEY  (full service-account JSON in the env var)
 *   2. GOOGLE_APPLICATION_CREDENTIALS / ADC
 * firebase-admin is an optional dependency; we import it lazily.
 */
export async function syncUsage(config: PolymathConfig): Promise<SyncResult> {
  if (!config.firestore.enabled) {
    return { synced: 0, message: "Firestore sync is disabled (enable with `poly config firestore on`)." };
  }

  let appMod: any, fsMod: any;
  try {
    appMod = await import("firebase-admin/app");
    fsMod = await import("firebase-admin/firestore");
  } catch {
    return {
      synced: 0,
      message: "firebase-admin is not installed. Run `npm install firebase-admin` to enable sync.",
    };
  }

  const { initializeApp, getApps, cert } = appMod;
  if (getApps().length === 0) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (saJson) {
      try {
        initializeApp({ credential: cert(JSON.parse(saJson)) });
      } catch {
        initializeApp({ projectId: config.firestore.projectId });
      }
    } else {
      // Falls back to Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / gcloud auth).
      initializeApp({ projectId: config.firestore.projectId });
    }
  }

  const fdb = fsMod.getFirestore();
  const rows = unsyncedRows();
  if (!rows.length) return { synced: 0, message: "Nothing to sync — all rows already pushed." };

  const batch = fdb.batch();
  const col = fdb.collection(config.firestore.collection);
  for (const r of rows) {
    const ref = col.doc(`${r.date}__${r.id}`);
    batch.set(ref, {
      ts: r.ts,
      date: r.date,
      provider: r.provider,
      model: r.model,
      taskType: r.taskType,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd,
      sessionId: r.sessionId ?? null,
    });
  }
  await batch.commit();
  markSynced(rows.map((r) => r.id));
  return { synced: rows.length, message: `Synced ${rows.length} rows to ${config.firestore.collection}.` };
}
