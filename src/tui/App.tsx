import { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { OpenRouterClient } from "../providers/openrouter.js";
import type { ModelInfo } from "../providers/types.js";
import type { RoutingPolicy } from "../router/policy.js";
import { runAgent, type AgentEvent, type AgentDeps } from "../agent/loop.js";
import { heuristicPlan } from "../planner/planner.js";
import { buildRecommendation, type Recommendation } from "../recommend/recommend.js";
import { setUserScore } from "../usage/db.js";
import { usd, tokens } from "../util/format.js";

export interface AppProps {
  client: OpenRouterClient;
  models: ModelInfo[];
  policy: RoutingPolicy;
  sessionId: string;
  cwd: string;
  allowWrite: boolean;
  allowCommands: boolean;
  objectiveLabel: string;
  initialGoal?: string;
}

type Phase = "input" | "preview" | "running" | "rate" | "done";

interface LogLine {
  key: number;
  text: string;
  color?: string;
}

export default function App(props: AppProps) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>(props.initialGoal ? "preview" : "input");
  const [goal, setGoal] = useState(props.initialGoal ?? "");
  const [draft, setDraft] = useState("");
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [cost, setCost] = useState(0);
  const [tok, setTok] = useState(0);
  const [calls, setCalls] = useState(0);
  const [rated, setRated] = useState<number | null>(null);

  const push = useCallback((text: string, color?: string) => {
    setLog((l) => [...l, { key: l.length, text, color }]);
  }, []);

  // Build the pre-run recommendation whenever we enter preview with a goal.
  useEffect(() => {
    if (phase === "preview" && goal) {
      setRec(buildRecommendation(heuristicPlan(goal), props.models));
    }
  }, [phase, goal, props.models]);

  const start = useCallback(async () => {
    setPhase("running");
    const deps: AgentDeps = {
      client: props.client,
      models: props.models,
      policy: props.policy,
      sessionId: props.sessionId,
      cwd: props.cwd,
      allowWrite: props.allowWrite,
      allowCommands: props.allowCommands,
    };
    let textBuf = "";
    const flush = () => {
      if (textBuf.trim()) push(textBuf.trim(), "white");
      textBuf = "";
    };
    const emit = (e: AgentEvent) => {
      switch (e.type) {
        case "plan":
          push(`📋 Plan (${e.plan.steps.length} steps) · planner: ${e.planModel}`, "cyan");
          break;
        case "step-start":
          flush();
          push(`▶ Step ${e.step.id} [${e.step.type}] → ${e.model.id}  ~${usd(e.estCostUsd)}`, "yellow");
          break;
        case "text":
          textBuf += e.delta;
          break;
        case "tool-call":
          flush();
          push(`  🔧 ${e.name}(${truncate(e.args, 80)})`, "magenta");
          break;
        case "tool-result":
          push(`  ↳ ${truncate(e.result.replace(/\n/g, " "), 100)}`, "gray");
          break;
        case "usage":
          setCost((c) => c + e.entry.costUsd);
          setTok((t) => t + e.entry.totalTokens);
          setCalls((n) => n + 1);
          break;
        case "step-end":
          flush();
          push(`  ✓ ${truncate(e.summary.replace(/\n/g, " "), 120)}`, "green");
          break;
        case "error":
          flush();
          push(`  ⚠ ${e.message}`, "red");
          break;
        case "done":
          flush();
          break;
      }
    };
    try {
      await runAgent(goal, deps, emit);
    } catch (err: any) {
      push(`Fatal: ${err?.message ?? err}`, "red");
    }
    setPhase("rate");
  }, [goal, props, push]);

  useInput((input, key) => {
    if (phase === "preview") {
      if (input === "y" || key.return) void start();
      else if (input === "e") {
        setDraft(goal);
        setPhase("input");
      } else if (input === "q") exit();
    } else if (phase === "rate") {
      // Goal-achievement rating (0-9) feeds the per-model efficiency analytics.
      if (/^[0-9]$/.test(input)) {
        const score = parseInt(input, 10);
        try {
          setUserScore(props.sessionId, score);
        } catch {
          /* rating is best-effort */
        }
        setRated(score);
        setPhase("done");
      } else if (key.return || input === "q") {
        setPhase("done"); // skip
      }
    } else if (phase === "done") {
      if (input === "q" || key.return) exit();
    }
  });

  return (
    <Box flexDirection="column">
      <Header objectiveLabel={props.objectiveLabel} cost={cost} tok={tok} calls={calls} />

      {phase === "input" && (
        <Box>
          <Text color="cyan">What should Polymath do? </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={(v: string) => {
              if (v.trim()) {
                setGoal(v.trim());
                setPhase("preview");
              }
            }}
          />
        </Box>
      )}

      {phase === "preview" && rec && <Preview rec={rec} />}

      {(phase === "running" || phase === "rate" || phase === "done") && (
        <Box flexDirection="column" marginTop={1}>
          {log.slice(-18).map((l) => (
            <Text key={l.key} color={l.color as any}>
              {l.text}
            </Text>
          ))}
          {phase === "running" && (
            <Text color="cyan">
              <Spinner type="dots" /> working…
            </Text>
          )}
          {phase === "rate" && (
            <Text>
              <Text color="green">
                ✓ Done · {calls} calls · {tokens(tok)} tokens · {usd(cost)}
              </Text>
              {"\n"}
              <Text color="cyan">How well was your goal achieved? </Text>
              <Text color="yellow">[0-9]</Text>
              <Text color="gray"> (9 = perfect · enter = skip) — feeds `poly analyze`</Text>
            </Text>
          )}
          {phase === "done" && (
            <Text color="green">
              ✓ Done · {calls} calls · {tokens(tok)} tokens · {usd(cost)}
              {rated != null ? ` · rated ${rated}/9` : ""} — press q to quit
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function Header(props: { objectiveLabel: string; cost: number; tok: number; calls: number }) {
  return (
    <Box justifyContent="space-between" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text>
        <Text color="magentaBright" bold>
          Polymath
        </Text>
        <Text color="gray"> · policy: </Text>
        <Text color="yellow">{props.objectiveLabel}</Text>
      </Text>
      <Text color="gray">
        {props.calls} calls · {tokens(props.tok)} tok · <Text color="green">{usd(props.cost)}</Text>
      </Text>
    </Box>
  );
}

function Preview(props: { rec: Recommendation }) {
  const { rec } = props;
  const value = rec.strategies.find((s) => s.objective === "value")!;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">Goal: {rec.plan.goal}</Text>
      <Text color="gray">Recommended routing (best value) — estimate before running:</Text>
      {value.assignments.map((a) => (
        <Text key={a.step.id}>
          <Text color="yellow">
            {" "}
            {a.step.id}. [{a.step.type}]
          </Text>{" "}
          <Text color="white">{a.model ? a.model.id : "(none)"}</Text>{" "}
          <Text color="gray">~{usd(a.estCostUsd)}</Text>
        </Text>
      ))}
      <Text>
        <Text color="gray"> Est total: </Text>
        <Text color="green">{usd(value.totalCostUsd)}</Text>
        {rec.savingsPct > 0 && (
          <Text color="green"> (~{rec.savingsPct.toFixed(0)}% vs all-frontier)</Text>
        )}
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">Run this? </Text>
        <Text color="gray">[y] run · [e] edit goal · [q] quit</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
