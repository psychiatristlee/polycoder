import type { CompletionResult } from "../providers/types.js";
import { recordUsage, type UsageEntry } from "./db.js";

function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? "unknown";
}

/** Persist one model call's real usage/cost, keyed by date + model (+ command). */
export function logCompletion(
  result: CompletionResult,
  taskType: string,
  sessionId: string,
  command = "run"
): UsageEntry {
  const now = new Date();
  const entry: UsageEntry = {
    ts: now.getTime(),
    date: localDate(now),
    provider: providerOf(result.model),
    model: result.model,
    taskType,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    costUsd: result.costUsd,
    sessionId,
    command,
  };
  recordUsage(entry);
  return entry;
}
