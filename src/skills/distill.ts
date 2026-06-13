// Turn a COMPLETED, verified run into a reusable skill, and either save it as a new
// skill or REINFORCE a near-duplicate (so repeated successes keep strengthening one
// playbook instead of spawning dozens of look-alikes). Distillation uses the cheapest
// capable model and is gated on verified success, so its cost is negligible relative
// to the tokens a reused skill saves on later runs.
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { CompletionResult, ModelInfo } from "../providers/types.js";
import type { GoalType, Plan } from "../planner/tasks.js";
import { extractJson } from "../planner/planner.js";
import { type Skill, listSkills, saveSkill, slugify } from "./store.js";
import { scoreSkill, tokenize } from "./match.js";

const DISTILL_SYSTEM = `You distill a COMPLETED, verified coding task into a reusable "skill" — a compact, GENERALIZED playbook a future agent can follow for SIMILAR goals (not this exact one).
Generalize: drop run-specific details (exact filenames/values) unless they are conventions worth reusing. Keep it short and actionable.
Return ONLY minified JSON:
{"name":"<kebab-case, 2-5 words>","description":"<one line ≤120 chars: when this skill applies>","whenToUse":"<1-2 sentences>","steps":["<imperative step>","..."]}
Use 3-7 steps.`;

export interface Distilled {
  name: string;
  description: string;
  body: string;
}

function buildBody(whenToUse: string, steps: string[]): string {
  const stepLines = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `## When to use\n${whenToUse}\n\n## Approach\n${stepLines}\n`;
}

/** Free, deterministic fallback when no model is available or the LLM call fails. */
export function heuristicSkill(goal: string, plan: Plan, summaries: string[]): Distilled {
  const steps = plan.steps.map((s) => `[${s.type}] ${s.description}`);
  const name =
    slugify(`${plan.goalType} ${goal}`).split("-").slice(0, 5).join("-") || slugify(plan.goalType);
  return {
    name,
    description: goal.replace(/\n/g, " ").slice(0, 120),
    body: buildBody(`Goals similar to: ${goal.slice(0, 160)}`, steps.length ? steps : summaries),
  };
}

export async function distill(
  goal: string,
  plan: Plan,
  summaries: string[],
  deps: { client: OpenRouterClient; model: ModelInfo; onUsage?: (r: CompletionResult) => void }
): Promise<Distilled> {
  const context = [
    `Goal: ${goal}`,
    `Goal type: ${plan.goalType}`,
    `Acceptance criteria (all met):\n${plan.criteria.map((c) => `- ${c}`).join("\n")}`,
    `What the steps did:\n${summaries.map((s) => `- ${s}`).join("\n")}`,
  ].join("\n\n");
  try {
    const r = await deps.client.complete(
      {
        model: deps.model.id,
        messages: [
          { role: "system", content: DISTILL_SYSTEM },
          { role: "user", content: context },
        ],
        temperature: 0,
        maxTokens: 600,
      },
      deps.model.pricing
    );
    deps.onUsage?.(r);
    const json = extractJson(r.content);
    if (json) {
      const obj = JSON.parse(json) as any;
      const name = slugify(String(obj.name ?? plan.goalType));
      const description = String(obj.description ?? goal).replace(/\n/g, " ").slice(0, 120);
      const steps: string[] = Array.isArray(obj.steps)
        ? obj.steps.map((s: any) => String(s).replace(/\n/g, " ").slice(0, 200)).filter(Boolean).slice(0, 8)
        : [];
      const whenToUse = String(obj.whenToUse ?? description).slice(0, 400);
      if (name && steps.length) return { name, description, body: buildBody(whenToUse, steps) };
    }
  } catch {
    /* fall through to heuristic */
  }
  return heuristicSkill(goal, plan, summaries);
}

export interface SaveResult {
  skill: Skill;
  isNew: boolean;
}

// A new distillation this similar to an existing skill reinforces it instead of
// creating a near-duplicate file.
const DEDUP_THRESHOLD = 0.5;

export function saveOrReinforce(
  d: Distilled,
  meta: { goalType: GoalType; tools: boolean; costUsd: number; now: string }
): SaveResult {
  const existing = listSkills();
  const dTokens = tokenize(`${d.name} ${d.description}`);
  let dupe: Skill | null = null;
  let dupeScore = 0;
  for (const s of existing) {
    const score = scoreSkill(dTokens, meta.goalType, s);
    if (score > dupeScore) {
      dupeScore = score;
      dupe = s;
    }
  }

  if (dupe && dupeScore >= DEDUP_THRESHOLD) {
    const sources = dupe.sources + 1;
    const reinforced: Skill = {
      ...dupe,
      sources,
      avgCostUsd: (dupe.avgCostUsd * dupe.sources + meta.costUsd) / sources,
      tools: dupe.tools || meta.tools,
      updatedAt: meta.now,
    };
    saveSkill(reinforced);
    return { skill: reinforced, isNew: false };
  }

  // Not a semantic dupe: if the slug collides with an unrelated skill, suffix it.
  let name = d.name;
  const used = new Set(existing.map((s) => s.name));
  if (used.has(name)) {
    let i = 2;
    while (used.has(`${name}-${i}`)) i++;
    name = `${name}-${i}`;
  }
  const skill: Skill = {
    name,
    description: d.description,
    goalType: meta.goalType,
    tools: meta.tools,
    createdAt: meta.now,
    updatedAt: meta.now,
    uses: 0,
    sources: 1,
    avgCostUsd: meta.costUsd,
    body: d.body,
  };
  saveSkill(skill);
  return { skill, isNew: true };
}
