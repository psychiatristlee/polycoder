// LIVE verification against the real Ollama server (no mock, no API key).
import { OpenRouterClient } from "../src/providers/openrouter.js";
import { getLocalModels } from "../src/models/local.js";
import { runAgent } from "../src/agent/loop.js";

const client = new OpenRouterClient({ localBaseUrl: "http://localhost:11434/v1" }); // keyless
const models = await getLocalModels(client);
console.log("catalog:", models.map((m) => m.id).join(", "));

const t0 = Date.now();
const res = await runAgent(
  "Create a file named hello.js that prints 'Hello from local LLM' to the console. Keep it minimal.",
  {
    client,
    models,
    policy: { objective: "cheapest" },
    sessionId: "live-ollama-1",
    cwd: process.env.SANDBOX!,
    allowWrite: true,
    allowCommands: false,
  },
  (e) => {
    if (e.type === "plan") console.log(`[plan] via ${e.planModel}: ${e.plan.steps.map((s) => s.type).join(" → ")}`);
    if (e.type === "step-start") console.log(`[step ${e.step.id}] ${e.step.type} → ${e.model.id}`);
    if (e.type === "tool-call") console.log(`  🔧 ${e.name}(${e.args.slice(0, 80).replace(/\n/g, " ")})`);
    if (e.type === "tool-result") console.log(`  ↳ ${e.result.slice(0, 80).replace(/\n/g, " ")}`);
    if (e.type === "step-end") console.log(`  ✓ ${e.summary.slice(0, 100).replace(/\n/g, " ")}`);
    if (e.type === "error") console.log(`  ⚠ ${e.message}`);
  }
);
console.log(
  `\nLIVE DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${res.calls} calls, ${res.totalTokens} tokens, cost $${res.totalCostUsd} (local = $0)`
);
