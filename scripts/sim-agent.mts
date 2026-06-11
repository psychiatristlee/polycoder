// E2E simulation driver: runs the real agent loop against the mock OpenRouter.
import { OpenRouterClient } from "../src/providers/openrouter.js";
import { getModels } from "../src/models/registry.js";
import { runAgent } from "../src/agent/loop.js";

const client = new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY });
const models = await getModels(client, { refresh: true });
console.log("catalog:", models.map((m) => m.id).join(", "));

const res = await runAgent(
  "create a hello.js that prints a greeting",
  {
    client,
    models,
    policy: { objective: "value" },
    sessionId: "sim-1",
    cwd: process.env.SANDBOX!,
    allowWrite: true,
    allowCommands: true,
  },
  (e) => {
    if (e.type === "plan")
      console.log(`[plan] ${e.plan.steps.length} steps via ${e.planModel}:`, e.plan.steps.map((s) => s.type).join(" → "));
    if (e.type === "step-start") console.log(`[step ${e.step.id}] ${e.step.type} → ${e.model.id} (~$${e.estCostUsd.toFixed(4)})`);
    if (e.type === "tool-call") console.log(`  tool: ${e.name}(${e.args.slice(0, 60)})`);
    if (e.type === "tool-result") console.log(`  result: ${e.result.slice(0, 60).replace(/\n/g, " ")}`);
    if (e.type === "step-end") console.log(`  ✓ ${e.summary}`);
    if (e.type === "error") console.log(`  ⚠ ${e.message}`);
  }
);
console.log(`DONE: ${res.calls} calls, ${res.totalTokens} tokens, $${res.totalCostUsd.toFixed(6)}`);

// Simulate the post-run goal-achievement rating + verify the analytics pipeline.
const { setUserScore, recordCommandRun, sessionUsageTotals } = await import("../src/usage/db.js");
setUserScore("sim-1", 8);
const totals = sessionUsageTotals("sim-1");
recordCommandRun({
  sessionId: "sim-1",
  ts: Date.now(),
  date: new Date().toISOString().slice(0, 10),
  command: "run",
  args: "create a hello.js that prints a greeting",
  objective: "value",
  ...totals,
  durationMs: 1234,
});
const { renderAnalysis } = await import("../src/usage/analyze.js");
console.log("\n===== poly analyze output =====");
console.log(renderAnalysis());
