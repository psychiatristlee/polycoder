import type { Tier } from "../providers/types.js";

/**
 * The kinds of work a coding agent does. Each maps to a *minimum capability tier*
 * — the cheapest tier theoretically able to do it well — and whether it needs tool use.
 * This is the heart of "apply the cheapest model that can do the job" routing.
 */
export type TaskType =
  | "plan" // decompose a request into steps
  | "search" // locate files / symbols / info
  | "read" // read & understand existing code
  | "edit" // write or modify code (needs file tools)
  | "command" // run shell commands (needs tools)
  | "review" // critique code for correctness/bugs
  | "reason" // hard algorithmic / architectural reasoning
  | "verify" // measure the result against acceptance criteria (tool-driven)
  | "explain" // explain results to the user
  | "summarize" // condense long content
  | "chat"; // simple conversational reply

export interface TaskSpec {
  type: TaskType;
  /** Cheapest tier expected to do this well. */
  minTier: Tier;
  /** Whether this task requires function/tool calling. */
  needsTools: boolean;
  /** Short human label. */
  label: string;
}

export const TASK_SPECS: Record<TaskType, TaskSpec> = {
  plan: { type: "plan", minTier: "standard", needsTools: false, label: "Plan / decompose" },
  search: { type: "search", minTier: "cheap", needsTools: true, label: "Search codebase" },
  read: { type: "read", minTier: "cheap", needsTools: true, label: "Read & understand" },
  edit: { type: "edit", minTier: "standard", needsTools: true, label: "Edit code" },
  command: { type: "command", minTier: "cheap", needsTools: true, label: "Run command" },
  review: { type: "review", minTier: "frontier", needsTools: false, label: "Review / critique" },
  reason: { type: "reason", minTier: "frontier", needsTools: false, label: "Hard reasoning" },
  // The verify gate inspects files / runs tests — it MUST have tools.
  verify: { type: "verify", minTier: "frontier", needsTools: true, label: "Verify result" },
  explain: { type: "explain", minTier: "cheap", needsTools: false, label: "Explain" },
  summarize: { type: "summarize", minTier: "cheap", needsTools: false, label: "Summarize" },
  chat: { type: "chat", minTier: "cheap", needsTools: false, label: "Chat" },
};

export const ALL_TASK_TYPES = Object.keys(TASK_SPECS) as TaskType[];

export interface PlannedStep {
  id: number;
  type: TaskType;
  description: string;
  /** rough estimate the planner gives, used for cost projection */
  estPromptTokens: number;
  estCompletionTokens: number;
}

export type GoalType = "feature" | "bugfix" | "refactor" | "test" | "docs" | "chore" | "other";

export const ALL_GOAL_TYPES: GoalType[] = ["feature", "bugfix", "refactor", "test", "docs", "chore", "other"];

export interface Plan {
  goal: string;
  steps: PlannedStep[];
  /** Classified goal type — drives the statistical "optimal starting model" learning. */
  goalType: GoalType;
  /** Measurable acceptance criteria; the verify gate checks the result against these. */
  criteria: string[];
}
