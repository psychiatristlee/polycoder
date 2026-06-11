import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ChatMessage, ModelInfo } from "../providers/types.js";
import type { RoutingPolicy } from "../router/policy.js";
import { route } from "../router/router.js";
import { planRequest, heuristicPlan } from "../planner/planner.js";
import type { Plan, PlannedStep } from "../planner/tasks.js";
import { TOOL_SCHEMAS, executeTool, type ToolContext } from "./tools.js";
import { logCompletion } from "../usage/logger.js";
import type { UsageEntry } from "../usage/db.js";

export type AgentEvent =
  | { type: "plan"; plan: Plan; planModel: string }
  | { type: "step-start"; step: PlannedStep; model: ModelInfo; estCostUsd: number }
  | { type: "text"; delta: string }
  | { type: "tool-call"; name: string; args: string }
  | { type: "tool-result"; name: string; result: string }
  | { type: "usage"; entry: UsageEntry }
  | { type: "step-end"; step: PlannedStep; summary: string }
  | { type: "done"; totalCostUsd: number; totalTokens: number; calls: number }
  | { type: "error"; message: string };

export interface AgentDeps {
  client: OpenRouterClient;
  models: ModelInfo[];
  policy: RoutingPolicy;
  sessionId: string;
  cwd: string;
  allowWrite: boolean;
  allowCommands: boolean;
}

const MAX_ITERS_PER_STEP = 6;

export async function runAgent(
  goal: string,
  deps: AgentDeps,
  emit: (e: AgentEvent) => void
): Promise<{ totalCostUsd: number; totalTokens: number; calls: number }> {
  const { client, models, policy, sessionId, cwd } = deps;
  let totalCostUsd = 0;
  let totalTokens = 0;
  let calls = 0;

  // 1) Plan.
  const planRoute = route("plan", models, policy);
  let plan: Plan;
  if (planRoute) {
    try {
      plan = await planRequest(goal, client, planRoute.model);
    } catch {
      plan = heuristicPlan(goal);
    }
  } else {
    plan = heuristicPlan(goal);
  }
  emit({ type: "plan", plan, planModel: planRoute?.model.id ?? "heuristic" });

  const toolCtx: ToolContext = {
    cwd,
    allowWrite: deps.allowWrite,
    allowCommands: deps.allowCommands,
  };

  const priorSummaries: string[] = [];

  // 2) Execute each step with its routed model.
  for (const step of plan.steps) {
    const r = route(step.type, models, policy, {
      promptTokens: step.estPromptTokens,
      completionTokens: step.estCompletionTokens,
    });
    if (!r) {
      emit({ type: "error", message: `No capable model for step ${step.id} (${step.type}).` });
      continue;
    }
    const model = r.model;
    emit({ type: "step-start", step, model, estCostUsd: r.estCostUsd });

    const useTools = model.capabilities.tools;
    const messages: ChatMessage[] = [
      { role: "system", content: stepSystemPrompt(goal, step, priorSummaries, useTools) },
      { role: "user", content: step.description },
    ];

    let summary = "";
    for (let iter = 0; iter < MAX_ITERS_PER_STEP; iter++) {
      const gen = client.stream(
        {
          model: model.id,
          messages,
          tools: useTools ? TOOL_SCHEMAS : undefined,
          temperature: 0.2,
          maxTokens: 2000,
        },
        model.pricing
      );

      // Drain stream; the generator's return value is the full result.
      let next = await gen.next();
      while (!next.done) {
        emit({ type: "text", delta: next.value });
        next = await gen.next();
      }
      const result = next.value;

      const entry = logCompletion(result, step.type, sessionId);
      emit({ type: "usage", entry });
      totalCostUsd += entry.costUsd;
      totalTokens += entry.totalTokens;
      calls++;

      if (result.toolCalls.length && useTools) {
        // Record the assistant's tool-call turn, then execute each tool.
        messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        let finished = false;
        for (const tc of result.toolCalls) {
          emit({ type: "tool-call", name: tc.function.name, args: tc.function.arguments });
          const outcome = executeTool(tc.function.name, tc.function.arguments, toolCtx);
          emit({ type: "tool-result", name: tc.function.name, result: outcome.result });
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: outcome.result });
          if (outcome.finishSummary != null) {
            summary = outcome.finishSummary;
            finished = true;
          }
        }
        if (finished) break;
        continue; // let the model react to tool results
      }

      // No tool calls -> the assistant's text is the step result.
      summary = result.content || summary;
      break;
    }

    if (!summary) summary = "(no summary)";
    priorSummaries.push(`Step ${step.id} (${step.type}): ${summary}`);
    emit({ type: "step-end", step, summary });
  }

  emit({ type: "done", totalCostUsd, totalTokens, calls });
  return { totalCostUsd, totalTokens, calls };
}

function stepSystemPrompt(
  goal: string,
  step: PlannedStep,
  priorSummaries: string[],
  useTools: boolean
): string {
  const context = priorSummaries.length
    ? `\n\nWhat previous steps accomplished:\n${priorSummaries.join("\n")}`
    : "";
  const toolNote = useTools
    ? `\nYou may use the provided tools (read_file, write_file, list_dir, run_command). Call the \`finish\` tool with a one-line summary when this step's objective is met.`
    : `\nReturn a concise result for this step. Do not ask the user questions.`;
  return `You are the "${step.type}" stage of an autonomous coding agent.
Overall goal: ${goal}
Your current step: ${step.description}${context}${toolNote}
Be efficient — you were selected as the cheapest capable model for this step.`;
}
