# Polymath — Claude Code Guide

Polymath is a **cost-optimized, multi-model TUI coding agent**. It decomposes a
request into typed tasks, routes each task to the cheapest capable model via
OpenRouter, logs real usage/cost by date+model, and recommends model combos
before running.

> History note: this repo previously hosted "Mathology" (a Next.js + Firebase math
> site). It was intentionally wiped to start Polymath. The Firebase config was kept
> (`.firebaserc`, `firebase.json`, `firestore.*`, `functions/`) because the usage
> ledger can optionally sync to the existing `mathology-b8e3d` Firestore project.

## Architecture

```
src/
├── index.ts            # CLI entry (commander): login | run | recommend | models | usage | sync | config
├── providers/
│   ├── types.ts        # shared types (ModelInfo, ChatMessage, CompletionResult, …)
│   └── openrouter.ts   # OpenRouter client: listModels, validateKey, complete, stream
├── models/
│   ├── registry.ts     # fetch + cache catalog; map pricing -> per-MTok; assign tiers
│   ├── tiers.ts        # "theoretical" cheap|standard|frontier classification (heuristic)
│   └── strengths.ts    # per-family skill profiles (coding/reasoning/retrieval/speed) + TASK_SKILL
├── router/
│   ├── policy.ts       # objectives (cheapest|value|quality), value scoring, tier ranking
│   └── router.ts       # skill-aware eligibility + pick model for a task (strength-per-dollar)
├── planner/
│   ├── tasks.ts        # TaskType enum, TASK_SPECS (minTier + needsTools per task), Plan types
│   └── planner.ts      # LLM-based decomposition (+ heuristic fallback)
├── agent/
│   ├── tools.ts        # read_file/write_file/list_dir/run_command/finish + executor
│   └── loop.ts         # plan -> per-step route -> tool loop -> log usage (emits events)
├── usage/
│   ├── db.ts           # node:sqlite schema: usage_log + sessions/step_runs/command_runs + analysis queries
│   ├── logger.ts       # record one completion's usage (date+model+command)
│   ├── report.ts       # render the date+model report
│   ├── analyze.ts      # `poly analyze`: min-token model per task, objective×achievement, per-command
│   ├── dataconnect.ts  # push ledger to Firebase Data Connect (executeGraphql REST, ADC)
│   └── firestoreSync.ts# optional push to Firestore (firebase-admin, lazy import)
├── recommend/
│   └── recommend.ts    # build + render pre-run recommendations (strategies, value-by-tier)
├── auth/
│   └── onboarding.ts   # interactive OpenRouter key setup/validation (Claude-Code-style)
├── setup/
│   ├── localllm.ts     # detect/install Ollama (brew/curl/winget), start server, pull models
│   └── commands.ts     # `poly setup` (--local/--no-local) + `poly update` (--check)
├── tui/
│   └── App.tsx         # Ink UI: input -> recommendation preview -> run -> live cost
├── config/             # config dir resolution + JSON store (key stored chmod 600)
└── util/format.ts      # money/token formatting + text tables
```

## Build & run

```bash
npm run typecheck   # tsc --noEmit (source of truth for correctness)
npm run build       # esbuild -> dist/cli.js (bundles src, keeps node_modules external)
npm run dev -- <args>   # run from source via tsx, e.g. npm run dev -- models --tier cheap
node dist/cli.js <args>
```

- **Runtime:** Node ≥ 22.5 (uses built-in `node:sqlite` — no native build step).
- **Module system:** ESM. esbuild uses `packages: 'external'`, so third-party deps
  are imported at runtime from `node_modules`; only `src/` is bundled.
- **No automatic deploy.** This is a local CLI, not a hosted app.

## Conventions

- Money is USD; model pricing is normalized to **USD per million tokens** in
  `ModelInfo.pricing`. Per-call cost = tokens/1e6 × price (deterministic).
- Tier classification in `tiers.ts` is heuristic by design (the product wants a
  *theoretical* cheapest-capable mapping). Adjust the family regexes / price cutoffs
  there to change routing behavior.
- Secrets: never log the API key. It lives only in `~/.config/polymath/config.json`
  or the `OPENROUTER_API_KEY` env var.
- New task types: add to `planner/tasks.ts` `TaskType` + `TASK_SPECS`, and the
  planner system prompt in `planner/planner.ts`.

## Analytics (core feature)

- Capture grain: `sessions` (goal + objective + achievement) → `step_runs` (model,
  iterations, tokens, finished_by) → `usage_log` (per LLM call) + `command_runs`.
- Achievement: auto_score = completed/planned steps; user_score = 0-9 TUI rating
  after each run (App.tsx "rate" phase, setUserScore).
- `poly analyze` answers: min-token model per task type (success ≥50%), objective
  vs achievement, tokens per command. SQL equivalents: dataconnect/ANALYSIS.sql.

## Firebase (optional analytics sync)

- SQL sink: Firebase Data Connect — schema in `dataconnect/` (GraphQL SDL → Postgres),
  `poly config dataconnect on` + `poly sync` (usage/dataconnect.ts, executeGraphql REST).
  Requires Blaze plan + Cloud SQL instance; see dataconnect/README.md.
- Document sink: Firestore — `poly config firestore on`; collection `polymath_usage`.
- Credentials: `FIREBASE_SERVICE_ACCOUNT_KEY` (full SA JSON) or ADC. Project `mathology-b8e3d`.
