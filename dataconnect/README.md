# Polymath analytics on Firebase Data Connect (Cloud SQL)

The CLI records everything locally first (SQLite, offline-first). `poly sync` then
pushes the ledger to **Firebase Data Connect** — Firebase's PostgreSQL product — so
you can run real SQL over your usage:

| Table | Grain | Answers |
|---|---|---|
| `sessions` | one `poly run` | goal, approach (objective), **achievement** (auto 0–1 + your 0–9 rating), tokens, cost |
| `step_runs` | one plan step | **which model finished each task type with the fewest tokens**, iterations, success |
| `model_calls` | one LLM call | per-call tokens/cost by date + model + command |
| `command_runs` | one CLI command | tokens/cost per command (`run`, `recommend`, …) |

Schema: [schema/schema.gql](schema/schema.gql) · Ready-made analysis SQL: [ANALYSIS.sql](ANALYSIS.sql)

## One-time setup

> ⚠️ Data Connect runs on Cloud SQL, which **requires the Blaze (pay-as-you-go) plan**
> and bills for the Postgres instance (~$10+/mo for the smallest one). If you don't
> want that, skip this — the local ledger and `poly analyze` work fully offline,
> and `poly config firestore on` is a free-tier alternative sink.

```bash
# from the repo root (project: mathology-b8e3d)
firebase init dataconnect      # pick service id "polymath", location us-east4,
                               # let it create Cloud SQL instance "polymath-fdc"
firebase deploy --only dataconnect
```

## Connect the CLI

```bash
poly config dataconnect on     # optionally: --location us-east4 --service polymath
poly sync                      # pushes unsynced sessions/steps/calls/commands
```

Credentials (either):
- `GOOGLE_APPLICATION_CREDENTIALS` / gcloud ADC (`gcloud auth application-default login`)
- `FIREBASE_SERVICE_ACCOUNT_KEY` env var holding the full service-account JSON

## Analyze

- Cloud SQL Studio (Firebase console → Data Connect) → paste queries from
  [ANALYSIS.sql](ANALYSIS.sql)
- Or locally, no Firebase needed: `poly analyze`
