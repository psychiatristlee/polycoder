// E2E for v0.3.0 features:
//  A) local LLM routing — the mock server plays Ollama (OpenAI-compatible);
//     models join as local/<name> at $0 and the agent runs on them.
//  B) insight distillation — seed step evidence, distill, verify the playbook
//     stores ONLY the notably efficient approach and boosts routing.
import { OpenRouterClient } from "../src/providers/openrouter.js";
import { parseLocalModels, getLocalModels } from "../src/models/local.js";
import { runAgent } from "../src/agent/loop.js";
import { route } from "../src/router/router.js";
import { recordStepRun } from "../src/usage/db.js";
import { distillInsights, insightBoostMap, renderPlaybook } from "../src/usage/insights.js";

const LOCAL_BASE = "http://localhost:18080/api/v1";

// ---- A) local LLM ----------------------------------------------------------
console.log("===== A) local LLM (keyless, via mock-as-Ollama) =====");
const keylessClient = new OpenRouterClient({ localBaseUrl: LOCAL_BASE }); // NO API key
const localModels = await getLocalModels(keylessClient);
console.log("local catalog:", localModels.map((m) => `${m.id} [${m.tier}] $0`).join(", "));
if (!localModels.length) throw new Error("no local models found");

// The mock requires a Bearer sk-* for completions (it plays OpenRouter too), so give
// the client a key for the run itself — locality is proven by the local/ prefix routing.
const client = new OpenRouterClient({ apiKey: "sk-or-mock", localBaseUrl: LOCAL_BASE });
const res = await runAgent(
  "create a hello.js that prints a greeting",
  {
    client,
    models: localModels, // local-only catalog
    policy: { objective: "cheapest" },
    sessionId: "sim-local-1",
    cwd: process.env.SANDBOX!,
    allowWrite: true,
    allowCommands: false,
  },
  (e) => {
    if (e.type === "plan") console.log(`[plan] via ${e.planModel}: ${e.plan.steps.map((s) => s.type).join(" → ")}`);
    if (e.type === "step-start") console.log(`[step ${e.step.id}] ${e.step.type} → ${e.model.id} (${e.model.provider})`);
    if (e.type === "step-end") console.log(`  ✓ ${e.summary}`);
    if (e.type === "error") console.log(`  ⚠ ${e.message}`);
  }
);
console.log(`local run DONE: ${res.calls} calls, ${res.totalTokens} tokens, cost $${res.totalCostUsd} (expected $0)\n`);

// ---- B) insight distillation + learned routing -------------------------------
console.log("===== B) insights: distill → playbook → routing boost =====");
// Seed evidence: on 'edit', tiny-coder finishes with ~1.2k tokens, big-generalist ~4k.
const seed = (model: string, tokens: number, n: number) => {
  for (let i = 0; i < n; i++) {
    recordStepRun({
      sessionId: `seed-${model}-${i}`,
      stepNo: 1,
      taskType: "edit",
      skill: "coding",
      model,
      provider: model.split("/")[0],
      iterations: 2,
      toolCalls: 2,
      promptTokens: Math.round(tokens * 0.8),
      completionTokens: Math.round(tokens * 0.2),
      costUsd: tokens / 1_000_000,
      finishedBy: "finish-tool",
      success: true,
      durationMs: 1000,
    });
  }
};
seed("mock/cheap-coder", 1200, 4);
seed("mock/frontier-opus", 4000, 4);

const insights = distillInsights();
console.log(renderPlaybook(insights));

const boost = insightBoostMap(insights);
console.log("\nboost map:", JSON.stringify(boost));

// Routing WITHOUT the playbook vs WITH it (catalog: both mock models, OpenRouter side).
const { getModels } = await import("../src/models/registry.js");
const orModels = await getModels(client, { refresh: true });
const before = route("edit", orModels, { objective: "value" });
const after = route("edit", orModels, { objective: "value", empirical: boost });
console.log(`route(edit) without playbook: ${before?.model.id} — ${before?.reason}`);
console.log(`route(edit) WITH playbook:    ${after?.model.id} — ${after?.reason}`);
