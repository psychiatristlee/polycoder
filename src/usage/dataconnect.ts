// Push the local analytics ledger to Firebase Data Connect (Cloud SQL / PostgreSQL)
// via the admin executeGraphql endpoint. Credentials: FIREBASE_SERVICE_ACCOUNT_KEY
// (full SA JSON) or Application Default Credentials — same as the Firestore sync.
import type { PolymathConfig } from "../config/store.js";
import {
  unsyncedSessions,
  unsyncedStepRuns,
  unsyncedCommandRuns,
  unsyncedRows,
  unsyncedInsights,
  markSynced,
  markTableSynced,
} from "./db.js";
import { distillInsights } from "./insights.js";

export interface DataConnectSyncResult {
  insights: number;
  sessions: number;
  steps: number;
  commands: number;
  calls: number;
  message: string;
}

async function adminAccessToken(projectId: string): Promise<string> {
  let appMod: any;
  try {
    appMod = await import("firebase-admin/app");
  } catch {
    throw new Error("firebase-admin is not installed. Run `npm install firebase-admin`.");
  }
  const { initializeApp, getApps, cert, applicationDefault } = appMod;
  let app = getApps()[0];
  if (!app) {
    const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (saJson) {
      try {
        app = initializeApp({ credential: cert(JSON.parse(saJson)), projectId });
      } catch {
        app = initializeApp({ credential: applicationDefault(), projectId });
      }
    } else {
      app = initializeApp({ credential: applicationDefault(), projectId });
    }
  }
  const token = await app.options.credential.getAccessToken();
  return token.access_token;
}

async function executeGraphql(
  cfg: { projectId: string; location: string; serviceId: string },
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<void> {
  const url =
    `https://firebasedataconnect.googleapis.com/v1/projects/${cfg.projectId}` +
    `/locations/${cfg.location}/services/${cfg.serviceId}:executeGraphql`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Data Connect ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as any;
  if (json.errors?.length) {
    throw new Error(`Data Connect GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Default: distill locally and push ONLY the notably efficient insights (compact,
 * no goal text, no raw logs). Pass {raw: true} to also push the full ledger.
 */
export async function syncDataConnect(
  config: PolymathConfig,
  opts: { raw?: boolean } = {}
): Promise<DataConnectSyncResult> {
  const dc = config.dataconnect;
  if (!dc?.enabled) {
    return { insights: 0, sessions: 0, steps: 0, commands: 0, calls: 0, message: "Data Connect sync is disabled (enable with `poly config dataconnect on`)." };
  }
  const projectId = config.firestore.projectId;
  const token = await adminAccessToken(projectId);
  const cfg = { projectId, location: dc.location, serviceId: dc.serviceId };

  // 0) Re-distill from the latest evidence, then push insight upserts.
  distillInsights();
  const insights = unsyncedInsights();
  for (const i of insights) {
    await executeGraphql(
      cfg,
      token,
      `mutation UpsertInsight($id: String!, $computedAt: Timestamp!, $taskType: String!,
         $model: String!, $provider: String!, $samples: Int!, $successRate: Float!,
         $avgTokens: Float!, $baselineTokens: Float!, $savingsPct: Float!, $avgCostUsd: Float!) {
         insight_upsert(data: {
           id: $id, computedAt: $computedAt, taskType: $taskType, model: $model,
           provider: $provider, samples: $samples, successRate: $successRate,
           avgTokens: $avgTokens, baselineTokens: $baselineTokens,
           savingsPct: $savingsPct, avgCostUsd: $avgCostUsd
         })
       }`,
      {
        id: i.id,
        computedAt: iso(i.computedAt),
        taskType: i.taskType,
        model: i.model,
        provider: i.provider,
        samples: i.samples,
        successRate: i.successRate,
        avgTokens: i.avgTokens,
        baselineTokens: i.baselineTokens,
        savingsPct: i.savingsPct,
        avgCostUsd: i.avgCostUsd,
      }
    );
  }
  markTableSynced("insights", insights.map((i) => i.id));

  if (!opts.raw) {
    return {
      insights: insights.length,
      sessions: 0,
      steps: 0,
      commands: 0,
      calls: 0,
      message: `Synced ${insights.length} efficiency insight(s) to Data Connect (${cfg.serviceId}@${cfg.location}). Raw logs stayed local — use \`poly sync --raw\` to push everything.`,
    };
  }

  // --raw: push the full ledger too.
  // 1) Sessions first (FK parent). Upsert so later user_score updates propagate.
  const sessions = unsyncedSessions();
  for (const s of sessions) {
    await executeGraphql(
      cfg,
      token,
      `mutation UpsertSession($id: String!, $startedAt: Timestamp!, $date: Date!, $goal: String!,
         $command: String!, $objective: String!, $plannedSteps: Int!, $completedSteps: Int!,
         $failedSteps: Int!, $autoScore: Float, $userScore: Int, $promptTokens: Int!,
         $completionTokens: Int!, $costUsd: Float!, $durationMs: Int!) {
         session_upsert(data: {
           id: $id, startedAt: $startedAt, date: $date, goal: $goal, command: $command,
           objective: $objective, plannedSteps: $plannedSteps, completedSteps: $completedSteps,
           failedSteps: $failedSteps, autoScore: $autoScore, userScore: $userScore,
           promptTokens: $promptTokens, completionTokens: $completionTokens,
           costUsd: $costUsd, durationMs: $durationMs
         })
       }`,
      {
        id: s.id,
        startedAt: iso(s.ts),
        date: s.date,
        goal: s.goal,
        command: s.command,
        objective: s.objective,
        plannedSteps: s.plannedSteps,
        completedSteps: s.completedSteps,
        failedSteps: s.failedSteps,
        autoScore: s.autoScore,
        userScore: s.userScore,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        costUsd: s.costUsd,
        durationMs: s.durationMs,
      }
    );
  }
  markTableSynced("sessions", sessions.map((s) => s.id));

  // 2) Step runs.
  const steps = unsyncedStepRuns();
  for (const st of steps) {
    await executeGraphql(
      cfg,
      token,
      `mutation InsertStep($sessionId: String!, $stepNo: Int!, $taskType: String!, $skill: String!,
         $model: String!, $provider: String!, $iterations: Int!, $toolCalls: Int!,
         $promptTokens: Int!, $completionTokens: Int!, $costUsd: Float!,
         $finishedBy: String!, $success: Boolean!, $durationMs: Int!) {
         stepRun_insert(data: {
           sessionId: $sessionId, stepNo: $stepNo, taskType: $taskType, skill: $skill,
           model: $model, provider: $provider, iterations: $iterations, toolCalls: $toolCalls,
           promptTokens: $promptTokens, completionTokens: $completionTokens, costUsd: $costUsd,
           finishedBy: $finishedBy, success: $success, durationMs: $durationMs
         })
       }`,
      {
        sessionId: st.sessionId,
        stepNo: st.stepNo,
        taskType: st.taskType,
        skill: st.skill,
        model: st.model,
        provider: st.provider,
        iterations: st.iterations,
        toolCalls: st.toolCalls,
        promptTokens: st.promptTokens,
        completionTokens: st.completionTokens,
        costUsd: st.costUsd,
        finishedBy: st.finishedBy,
        success: st.success,
        durationMs: st.durationMs,
      }
    );
  }
  markTableSynced("step_runs", steps.map((s) => s.id));

  // 3) Command runs.
  const commands = unsyncedCommandRuns();
  for (const cr of commands) {
    await executeGraphql(
      cfg,
      token,
      `mutation InsertCommand($sessionId: String, $ts: Timestamp!, $date: Date!, $command: String!,
         $args: String, $objective: String, $promptTokens: Int!, $completionTokens: Int!,
         $costUsd: Float!, $durationMs: Int!) {
         commandRun_insert(data: {
           sessionId: $sessionId, ts: $ts, date: $date, command: $command, args: $args,
           objective: $objective, promptTokens: $promptTokens, completionTokens: $completionTokens,
           costUsd: $costUsd, durationMs: $durationMs
         })
       }`,
      {
        sessionId: cr.sessionId ?? null,
        ts: iso(cr.ts),
        date: cr.date,
        command: cr.command,
        args: cr.args ?? null,
        objective: cr.objective ?? null,
        promptTokens: cr.promptTokens,
        completionTokens: cr.completionTokens,
        costUsd: cr.costUsd,
        durationMs: cr.durationMs,
      }
    );
  }
  markTableSynced("command_runs", commands.map((c) => c.id));

  // 4) Per-call ledger (model_calls). Reuses usage_log's synced flag.
  const calls = unsyncedRows();
  for (const u of calls) {
    await executeGraphql(
      cfg,
      token,
      `mutation InsertCall($sessionId: String, $ts: Timestamp!, $date: Date!, $command: String!,
         $taskType: String!, $model: String!, $provider: String!, $promptTokens: Int!,
         $completionTokens: Int!, $totalTokens: Int!, $costUsd: Float!) {
         modelCall_insert(data: {
           sessionId: $sessionId, ts: $ts, date: $date, command: $command, taskType: $taskType,
           model: $model, provider: $provider, promptTokens: $promptTokens,
           completionTokens: $completionTokens, totalTokens: $totalTokens, costUsd: $costUsd
         })
       }`,
      {
        sessionId: u.sessionId ?? null,
        ts: iso(u.ts),
        date: u.date,
        command: (u as any).command ?? "run",
        taskType: u.taskType,
        model: u.model,
        provider: u.provider,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens,
        costUsd: u.costUsd,
      }
    );
  }
  markSynced(calls.map((c) => c.id));

  return {
    insights: insights.length,
    sessions: sessions.length,
    steps: steps.length,
    commands: commands.length,
    calls: calls.length,
    message: `Synced ${insights.length} insights + raw: ${sessions.length} sessions, ${steps.length} steps, ${commands.length} commands, ${calls.length} calls (${cfg.serviceId}@${cfg.location}).`,
  };
}
