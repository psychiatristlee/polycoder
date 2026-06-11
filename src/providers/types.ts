// Central type definitions shared across providers, router, planner, usage and recommend.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  /** present on assistant messages that requested tool calls */
  tool_calls?: ToolCall[];
  /** present on tool result messages */
  tool_call_id?: string;
  /** optional name (tool name for tool messages) */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Price expressed in USD per 1,000,000 tokens. */
export interface ModelPricing {
  promptUsdPerMTok: number;
  completionUsdPerMTok: number;
}

/** Coarse capability/quality tier used for routing. "Theoretical" — derived from price + known families. */
export type Tier = "cheap" | "standard" | "frontier";

export interface ModelInfo {
  id: string; // OpenRouter id, e.g. "anthropic/claude-3.5-haiku"
  name: string;
  provider: string; // derived from the id prefix, e.g. "anthropic"
  contextLength: number;
  pricing: ModelPricing;
  tier: Tier;
  capabilities: {
    tools: boolean;
    vision: boolean;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  model: string;
  costUsd: number;
  finishReason: string | null;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}
