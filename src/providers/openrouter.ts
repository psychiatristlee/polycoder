import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelPricing,
  ToolCall,
} from "./types.js";

// Overridable for proxies/testing; guarded so the same code runs in browsers (extensions).
const BASE =
  (globalThis as any).process?.env?.OPENROUTER_BASE_URL?.replace(/\/$/, "") ||
  "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  apiKey?: string;
  referer?: string;
  title?: string;
  /** OpenAI-compatible local server (Ollama / LM Studio). Models prefixed `local/` route here. */
  localBaseUrl?: string;
}

export const LOCAL_PREFIX = "local/";

export class OpenRouterError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

export class OpenRouterClient {
  private apiKey?: string;
  private referer: string;
  private title: string;
  private localBaseUrl?: string;

  constructor(opts: OpenRouterOptions = {}) {
    this.apiKey = opts.apiKey;
    this.referer = opts.referer ?? "https://github.com/psychiatristlee/polyagent";
    this.title = opts.title ?? "Polymath";
    this.localBaseUrl = opts.localBaseUrl?.replace(/\/$/, "");
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey ?? ""}`,
      "HTTP-Referer": this.referer,
      "X-Title": this.title,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  /** Resolve where a model's request goes: the local server for `local/*`, else OpenRouter. */
  private target(modelId: string): { base: string; model: string; isLocal: boolean } {
    if (this.localBaseUrl && modelId.startsWith(LOCAL_PREFIX)) {
      return { base: this.localBaseUrl, model: modelId.slice(LOCAL_PREFIX.length), isLocal: true };
    }
    return { base: BASE, model: modelId, isLocal: false };
  }

  private requireKeyFor(isLocal: boolean): void {
    if (!isLocal && !this.apiKey) throw new OpenRouterError("No API key set. Run `poly login`.");
  }

  /** List models from the local OpenAI-compatible server (Ollama / LM Studio). */
  async listLocalRawModels(): Promise<any[]> {
    if (!this.localBaseUrl) return [];
    const res = await fetch(`${this.localBaseUrl}/models`);
    if (!res.ok) throw new OpenRouterError(`Local server: failed to list models (${res.status})`, res.status);
    const json = (await res.json()) as { data?: any[] };
    return json.data ?? [];
  }

  /** Raw /models payload (no auth required). */
  async listRawModels(): Promise<any[]> {
    const res = await fetch(`${BASE}/models`, { headers: this.headers(false) });
    if (!res.ok) {
      throw new OpenRouterError(`Failed to list models (${res.status})`, res.status);
    }
    const json = (await res.json()) as { data?: any[] };
    return json.data ?? [];
  }

  /** Validate the configured key; returns key metadata or throws. */
  async validateKey(): Promise<{ label?: string; usage?: number; limit?: number | null }> {
    if (!this.apiKey) throw new OpenRouterError("No API key set");
    const res = await fetch(`${BASE}/key`, { headers: this.headers(false) });
    if (res.status === 401) throw new OpenRouterError("Invalid API key (401)", 401);
    if (!res.ok) throw new OpenRouterError(`Key check failed (${res.status})`, res.status);
    const json = (await res.json()) as { data?: any };
    const d = json.data ?? {};
    return { label: d.label, usage: d.usage, limit: d.limit };
  }

  private buildBody(req: CompletionRequest, stream: boolean, modelOverride: string, isLocal: boolean) {
    return {
      model: modelOverride,
      messages: req.messages.map(serializeMessage),
      ...(req.tools && req.tools.length ? { tools: req.tools, tool_choice: "auto" } : {}),
      temperature: req.temperature ?? 0.2,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      stream,
      // OpenRouter-specific accounting param; local servers may reject unknown fields.
      ...(isLocal ? {} : { usage: { include: true } }),
      // OpenAI-compat way to get token usage in the final stream chunk (Ollama/LM Studio).
      ...(isLocal && stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  /** Non-streaming completion. costUsd is computed from `pricing` (deterministic). */
  async complete(req: CompletionRequest, pricing: ModelPricing): Promise<CompletionResult> {
    const t = this.target(req.model);
    this.requireKeyFor(t.isLocal);
    const res = await fetch(`${t.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, false, t.model, t.isLocal)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OpenRouterError(`Completion failed (${res.status}): ${truncate(text)}`, res.status);
    }
    const json = (await res.json()) as any;
    // OpenRouter can return HTTP 200 with a top-level {error} object (rate limit, moderation, upstream).
    if (json?.error) {
      throw new OpenRouterError(json.error.message ?? "Provider error", json.error.code);
    }
    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const usage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
    return {
      content: typeof msg.content === "string" ? msg.content : "",
      toolCalls: parseToolCalls(msg.tool_calls),
      usage,
      // Keep the prefixed id for local models so the ledger stays consistent.
      model: t.isLocal ? req.model : json.model ?? req.model,
      // Local inference is free regardless of what the server claims to report.
      costUsd: computeCost(usage, pricing, t.isLocal ? undefined : json.usage?.cost),
      finishReason: choice.finish_reason ?? null,
    };
  }

  /**
   * Streaming completion. Yields text deltas; returns the full CompletionResult.
   * Tool-call deltas are accumulated and surfaced in the final result.
   */
  async *stream(
    req: CompletionRequest,
    pricing: ModelPricing
  ): AsyncGenerator<string, CompletionResult, void> {
    const t = this.target(req.model);
    this.requireKeyFor(t.isLocal);
    const res = await fetch(`${t.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(req, true, t.model, t.isLocal)),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new OpenRouterError(`Stream failed (${res.status}): ${truncate(text)}`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usageJson: any = null;
    let finishReason: string | null = null;
    let model = req.model;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        // Mid-stream error chunks arrive as a data: line with a top-level {error}.
        if (evt?.error) {
          throw new OpenRouterError(evt.error.message ?? "Stream provider error", evt.error.code);
        }
        if (evt.model && !t.isLocal) model = evt.model;
        if (evt.usage) usageJson = evt.usage;
        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          yield delta.content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
          }
        }
      }
    }

    const usage = {
      promptTokens: usageJson?.prompt_tokens ?? 0,
      completionTokens: usageJson?.completion_tokens ?? 0,
      totalTokens: usageJson?.total_tokens ?? 0,
    };
    const toolCalls: ToolCall[] = [...toolAcc.values()]
      .filter((t) => t.name)
      .map((t) => ({
        id: t.id || `call_${t.name}`,
        type: "function" as const,
        function: { name: t.name, arguments: t.args || "{}" },
      }));
    return {
      content,
      toolCalls,
      usage,
      model,
      costUsd: computeCost(usage, pricing, t.isLocal ? undefined : usageJson?.cost),
      finishReason,
    };
  }
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "assistant" && m.tool_calls?.length) {
    return { role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls };
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
  }
  return { role: m.role, content: m.content };
}

function parseToolCalls(raw: any): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => ({
    id: t.id ?? `call_${t.function?.name ?? "fn"}`,
    type: "function" as const,
    function: {
      name: t.function?.name ?? "",
      arguments: t.function?.arguments ?? "{}",
    },
  }));
}

function computeCost(
  usage: { promptTokens: number; completionTokens: number },
  pricing: ModelPricing,
  providerCost?: number
): number {
  // With usage:{include:true}, OpenRouter returns the authoritative charged amount —
  // it accounts for the actual route, BYOK, and prompt-cache discounts. Prefer it.
  // (typeof check, not truthiness, so a legitimate $0 fully-cached request is preserved.)
  if (typeof providerCost === "number") return providerCost;
  // Fallback: deterministic estimate from local list pricing (e.g. a chunk lacked usage.cost).
  return (
    (usage.promptTokens / 1_000_000) * pricing.promptUsdPerMTok +
    (usage.completionTokens / 1_000_000) * pricing.completionUsdPerMTok
  );
}

function truncate(s: string, n = 240): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
