# Polymath 🪄

A **cost-optimized, multi-model AI agent** for your **terminal, VS Code, and Chrome**.
Like Claude Code, it breaks a request into typed steps — but it routes **each step to
the cheapest model that's actually good at it** (via [OpenRouter](https://openrouter.ai),
300+ models), records **real token usage and cost by date + model**, and **recommends
the best-value model combo before you run**.

| Surface | What it does | Install |
|---|---|---|
| **CLI / TUI** (`poly`) | Full coding agent in your terminal | `npm i -g polymath-agent` |
| **VS Code** | Runs the agent in the integrated terminal | [`vscode-extension/`](vscode-extension/) → VSIX |
| **Chrome** | Automates work in the browser (read / click / type / extract) | [`chrome-extension/`](chrome-extension/) → load unpacked |

All three share the same skill-aware routing brain and cost ledger.

```
┌ Polymath · policy: value ──────────────── 4 calls · 12.1k tok · $0.0031 ┐
└─────────────────────────────────────────────────────────────────────────┘
📋 Plan (5 steps) · planner: google/gemini-2.0-flash-001
▶ Step 1 [plan]   → google/gemini-2.0-flash-001   ~$0.0004
▶ Step 2 [search] → mistralai/ministral-3b         ~$0.0001
▶ Step 4 [edit]   → qwen/qwen3-coder                ~$0.0021
  ✓ Added dark-mode toggle to settings panel
✓ Done · 4 calls · 12.1k tokens · $0.0031
```

## Why

Running every task on a frontier model is wasteful. Searching, summarizing, and reading
don't need a $15/Mtok model — a $0.05/Mtok one is fine, and a cheap **coder-tuned** model
beats a pricey generalist at edits. Polymath assigns the cheapest model that genuinely
*covers* each task and proves the savings with a per-call cost ledger.

## Install

> Requires **Node.js ≥ 22.5** (the CLI uses the built-in `node:sqlite`).

### 1 · CLI (`poly`)

**From npm:**

```bash
npm install -g polymath-agent
poly login        # guided OpenRouter key setup
```

**From source** (no npm publish needed):

```bash
git clone https://github.com/psychiatristlee/mathology.git
cd mathology
npm install       # auto-builds dist/cli.js
npm link          # puts `poly` on your PATH
poly login
```

### 2 · VS Code extension

```bash
cd vscode-extension
npm install && npm run build && npm run package   # -> polymath-vscode-0.1.0.vsix
```

Install the `.vsix` via **Extensions → … → Install from VSIX…**, then use the Command
Palette → **"Polymath:"**. (It drives the `poly` CLI, and offers to install it if missing.)

### 3 · Chrome extension

```bash
cd chrome-extension
npm install && npm run build
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the
`chrome-extension/` folder. Open the side panel, paste your OpenRouter key in **Settings**,
and give it a goal for the active tab. See [chrome-extension/README.md](chrome-extension/README.md).

## First run (CLI)

```bash
poly recommend "add a dark-mode toggle to the settings page"   # model/cost options first
poly run -w -x "add a dark-mode toggle"   # -w allow file writes, -x allow shell commands
poly usage                                # cost by date + model
```

## Commands

| Command | What it does |
|---|---|
| `poly login` | Connect/replace your OpenRouter API key (Claude-Code-style onboarding). |
| `poly run [goal]` | Launch the interactive agent. Shows the recommended routing, then executes. |
| `poly recommend <goal>` | Pre-run recommendation: cheapest / best-value / best-quality model combos + savings. |
| `poly models` | Browse the catalog with pricing, tier, tool support. Filters: `--tier`, `--tools`, `--search`. |
| `poly usage` | Recorded usage & cost grouped by **date + model**. `--today`, `--since`, `--sync`. |
| `poly analyze` | **Which approach reaches the goal with the fewest tokens** — efficiency playbook, best model per task type, objective × achievement, usage per command. |
| `poly sync` | Push **distilled efficiency insights** to Firebase ([Data Connect SQL](dataconnect/) / Firestore). Raw logs stay local unless `--raw`. |
| `poly config show\|set\|firestore\|dataconnect\|local` | View/change settings. |

After each `poly run`, rate the result 0–9 (one keypress) — your goal-achievement
rating joins the auto score (completed/planned steps) to power `poly analyze`.

### The efficiency playbook (learned routing)

Everything is captured locally (SQLite). `poly analyze` distills it into a **playbook**
of *notably* efficient approaches — a (task, model) pair qualifies only with ≥3
successful runs, ≥70% success, and **≥20% fewer tokens than the median** of its
competitors. The playbook then **boosts routing**: proven-efficient models get
preferred under the `value` objective (`reason: proven 54% fewer tokens on edit`).
`poly sync` uploads *only* the playbook by default — your goals and raw logs never
leave the machine unless you pass `--raw`.

### Local LLMs (Ollama / LM Studio) — $0 routing

```bash
ollama serve                                # or LM Studio's local server
poly config local on                        # default base: http://localhost:11434/v1
poly config local on --base http://localhost:1234/v1   # LM Studio
poly models -s local/                       # local models join the catalog at $0
poly run "..."                              # cheapest objective → local wins what it can
```

Local models appear as `local/<name>`, cost $0, and need **no API key** — with
`local on` and no OpenRouter key, Polymath runs fully offline on your machine.
Tokens are still tracked, so the playbook learns when your local model is the
most efficient approach.

### Routing objectives

Routing is **skill-aware**: each task type maps to a skill (coding / reasoning /
retrieval / speed), and every model family has a strength profile for those skills
(Claude → coding & agentic, DeepSeek-R1 / o-series → reasoning, Gemini Flash → cheap
retrieval, …). See [`src/models/strengths.ts`](src/models/strengths.ts).

- `cheapest` — cheapest model that still **covers** the task's skill.
- `value` — best **strength-per-dollar for that task** (default). Coding work lands
  on the cheapest genuinely-good coder; a cheap coder-tuned model beats a pricey
  generalist for `edit`.
- `quality` — strongest model at the task's skill (e.g. Claude for coding edits).

```bash
poly run --objective quality "design a rate limiter"
poly run --max-cost 0.02 "small bug fix"   # never pick a model that'd cost > $0.02/call
```

## How it works

1. **Plan** — a cheap model decomposes the request into typed steps
   (`plan`, `search`, `read`, `edit`, `command`, `review`, `reason`, …).
2. **Route** — each task maps to a skill; a model is *eligible* if it meets the tier
   floor **or** is strong enough at that skill (so cheap coder models qualify for
   edits). The router then picks by objective. See [`src/router/`](src/router/),
   [`src/models/tiers.ts`](src/models/tiers.ts), [`src/models/strengths.ts`](src/models/strengths.ts).
3. **Execute** — a bounded tool-use loop runs the step (read/write files, run
   commands). Every model call's real usage + cost is logged.
4. **Ledger** — usage is stored in local SQLite (`~/.config/polymath/usage.sqlite`)
   and optionally synced to Firestore.

## Data & secrets

- API key: `~/.config/polymath/config.json` (chmod 600). Override per-shell with
  `OPENROUTER_API_KEY`.
- Usage DB: `~/.config/polymath/usage.sqlite` (built-in `node:sqlite`, no native deps).
- Optional Firestore sync uses the project's existing `mathology-b8e3d` Firebase
  project; enable with `poly config firestore on` and provide credentials via
  `FIREBASE_SERVICE_ACCOUNT_KEY` or ADC.

## Develop

```bash
npm run dev -- recommend "..."   # run from source via tsx
npm run typecheck                # tsc --noEmit
npm run build                    # esbuild -> dist/cli.js
```

Requires Node ≥ 22.5 (for `node:sqlite`).
