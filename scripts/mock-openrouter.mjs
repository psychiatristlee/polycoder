// Faithful OpenRouter API mock for end-to-end agent verification (no real key needed).
// Implements: GET /api/v1/models, GET /api/v1/key, POST /api/v1/chat/completions
// (both streaming SSE and non-streaming), tool_calls deltas, usage{cost} in the
// final chunk — matching the shapes the real API returns.
import http from "node:http";

const PORT = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 18080;

const MODELS = [
  {
    id: "mock/cheap-coder",
    name: "Mock Cheap Coder",
    context_length: 128000,
    pricing: { prompt: "0.00000005", completion: "0.0000002" }, // $0.05/M in, $0.2/M out
    supported_parameters: ["tools", "tool_choice"],
    architecture: { input_modalities: ["text"] },
  },
  {
    id: "mock/flash-retriever",
    name: "Mock Flash Lite",
    context_length: 1000000,
    pricing: { prompt: "0.00000003", completion: "0.0000001" },
    supported_parameters: ["tools", "tool_choice"],
    architecture: { input_modalities: ["text"] },
  },
  {
    id: "mock/frontier-opus",
    name: "Mock Opus (frontier)",
    context_length: 200000,
    pricing: { prompt: "0.000015", completion: "0.000075" }, // $15/M, $75/M
    supported_parameters: ["tools", "tool_choice"],
    architecture: { input_modalities: ["text", "image"] },
  },
];

function usageFor(promptTokens, completionTokens, modelId) {
  const m = MODELS.find((x) => x.id === modelId) ?? MODELS[0];
  const cost =
    promptTokens * parseFloat(m.pricing.prompt) + completionTokens * parseFloat(m.pricing.completion);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost };
}

let verifyCalls = 0; // stateful: first verify fails (to exercise escalation), then passes

/** Decide the assistant's reply given the request — emulates a competent model. */
function decide(body) {
  const sys = body.messages?.[0]?.content ?? "";
  const hasToolResult = body.messages?.some((m) => m.role === "tool");
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // Planner request (PLAN_SYSTEM prompt)
  if (/planning stage of a coding agent/i.test(sys)) {
    return {
      content: JSON.stringify({
        goalType: "feature",
        criteria: ["hello.js exists", "hello.js prints a greeting when run"],
        steps: [
          { type: "read", description: "Inspect the working directory layout", estPromptTokens: 1500, estCompletionTokens: 200 },
          { type: "edit", description: "Create hello.js that prints a greeting with `console.log('hi')` syntax {}", estPromptTokens: 2500, estCompletionTokens: 400 },
        ],
      }),
      tool_calls: [],
    };
  }

  // Verify stage — return a structured verdict. Fail the first time, pass after.
  if (/You are the VERIFY stage/i.test(sys)) {
    verifyCalls++;
    const pass = verifyCalls >= 2;
    return {
      content: JSON.stringify({
        results: [
          { criterion: "hello.js exists", met: true, reason: "file present" },
          { criterion: "hello.js prints a greeting when run", met: pass, reason: pass ? "prints greeting" : "greeting text missing" },
        ],
        feedback: pass ? "all good" : "Make hello.js console.log a greeting string.",
      }),
      tool_calls: [],
    };
  }

  // Fix stage — write the corrected file, then finish.
  if (/You are the FIX stage/i.test(sys)) {
    if (!hasToolResult) {
      return { content: "", tool_calls: [{ name: "write_file", arguments: JSON.stringify({ path: "hello.js", content: "console.log('Hello, world!');\n" }) }] };
    }
    return { content: "", tool_calls: [{ name: "finish", arguments: JSON.stringify({ summary: "Fixed greeting output" }) }] };
  }

  if (hasTools) {
    const stepMatch = sys.match(/You are the "(\w+)" stage/);
    const step = stepMatch ? stepMatch[1] : "edit";
    if (!hasToolResult) {
      // First turn of the step: act.
      if (step === "read") {
        return { content: "", tool_calls: [{ name: "list_dir", arguments: JSON.stringify({ path: "." }) }] };
      }
      return {
        content: "",
        tool_calls: [
          {
            name: "write_file",
            arguments: JSON.stringify({ path: "hello.js", content: "console.log('hello from polymath');\n" }),
          },
        ],
      };
    }
    // Tool result already present: finish the step.
    return {
      content: "",
      tool_calls: [
        { name: "finish", arguments: JSON.stringify({ summary: step === "read" ? "Listed directory contents" : "Created hello.js" }) },
      ],
    };
  }

  return { content: "Mock generalist reply: task acknowledged.", tool_calls: [] };
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: MODELS }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/key") {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth === "Bearer ") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No auth", code: 401 } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { label: "mock-key", usage: 0.42, limit: null } }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer sk-")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "User not found", code: 401 } }));
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const reply = decide(body);
      const promptTokens = Math.ceil(raw.length / 4);
      const completionTokens = Math.max(20, Math.ceil((reply.content.length + 40) / 4));
      const usage = usageFor(promptTokens, completionTokens, body.model);
      const toolCalls = reply.tool_calls.map((t, i) => ({
        index: i,
        id: `call_${Date.now()}_${i}`,
        type: "function",
        function: { name: t.name, arguments: t.arguments },
      }));
      const finishReason = toolCalls.length ? "tool_calls" : "stop";

      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        sseWrite(res, { id: "gen-1", model: body.model, choices: [{ index: 0, delta: { role: "assistant" } }] });
        // stream content in two chunks to exercise delta accumulation
        if (reply.content) {
          const mid = Math.ceil(reply.content.length / 2);
          sseWrite(res, { model: body.model, choices: [{ index: 0, delta: { content: reply.content.slice(0, mid) } }] });
          sseWrite(res, { model: body.model, choices: [{ index: 0, delta: { content: reply.content.slice(mid) } }] });
        }
        // stream tool calls: name first, then arguments split across chunks (like real providers)
        for (const tc of toolCalls) {
          sseWrite(res, {
            model: body.model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }],
          });
          const args = tc.function.arguments;
          const half = Math.ceil(args.length / 2);
          sseWrite(res, { model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: args.slice(0, half) } }] } }] });
          sseWrite(res, { model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: args.slice(half) } }] } }] });
        }
        sseWrite(res, { model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen-1",
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: reply.content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
                finish_reason: finishReason,
              },
            ],
            usage,
          })
        );
      }
    });
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => console.log(`mock-openrouter listening on http://localhost:${PORT}`));
