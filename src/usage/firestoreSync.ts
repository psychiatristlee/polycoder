import type { PolymathConfig } from "../config/store.js";
import { unsyncedRows, markSynced, unsyncedInsights, markTableSynced } from "./db.js";
import { distillInsights } from "./insights.js";

export interface SyncResult {
  synced: number;
  message: string;
}

/**
 * Push to Firestore (optional). Default: ONLY distilled efficiency insights
 * (collection `polymath_insights`); pass {raw: true} to also push raw usage rows.
 * Credentials, in order:
 *   1. FIREBASE_SERVICE_ACCOUNT_KEY  (full service-account JSON in the env var)
 *   2. GOOGLE_APPLICATION_CREDENTIALS / ADC
 * firebase-admin is an optional dependency; we import it lazily.
 */
export async function syncUsage(config: PolymathConfig, opts: { raw?: boolean } = {}): Promise<SyncResult> {
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

  // Default mode: distill, then push only the notably-efficient insights.
  distillInsights();
  const insights = unsyncedInsights();
  if (insights.length) {
    const batch = fdb.batch();
    const col = fdb.collection("polymath_insights");
    for (const i of insights) {
      batch.set(col.doc(i.id), {
        computedAt: i.computedAt,
        taskType: i.taskType,
        model: i.model,
        provider: i.provider,
        samples: i.samples,
        successRate: i.successRate,
        avgTokens: i.avgTokens,
        baselineTokens: i.baselineTokens,
        savingsPct: i.savingsPct,
        avgCostUsd: i.avgCostUsd,
      });
    }
    await batch.commit();
    markTableSynced("insights", insights.map((i) => i.id));
  }

  if (!opts.raw) {
    return {
      synced: insights.length,
      message: insights.length
        ? `Synced ${insights.length} efficiency insight(s) to polymath_insights. Raw logs stayed local (use --raw to push).`
        : "No new insights to sync — raw logs stay local by default (use --raw to push them).",
    };
  }

  const rows = unsyncedRows();
  if (!rows.length && !insights.length) return { synced: 0, message: "Nothing to sync — all rows already pushed." };

  if (rows.length) {
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
        command: r.command ?? "run",
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        totalTokens: r.totalTokens,
        costUsd: r.costUsd,
        sessionId: r.sessionId ?? null,
      });
    }
    await batch.commit();
    markSynced(rows.map((r) => r.id));
  }
  return {
    synced: insights.length + rows.length,
    message: `Synced ${insights.length} insights + ${rows.length} raw rows to Firestore.`,
  };
}
