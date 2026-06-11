-- Polymath analytics — run these in Cloud SQL Studio (or any psql) against the
-- Data Connect PostgreSQL database. The tables below are what Data Connect
-- generates from schema/schema.gql (snake_case columns).
--
-- Generated DDL (reference):
--
--   CREATE TABLE sessions (
--     id            TEXT PRIMARY KEY,
--     started_at    TIMESTAMPTZ NOT NULL,
--     date          DATE NOT NULL,
--     goal          TEXT NOT NULL,
--     command       TEXT NOT NULL,
--     objective     TEXT NOT NULL,
--     planned_steps INT NOT NULL,
--     completed_steps INT NOT NULL,
--     failed_steps  INT NOT NULL,
--     auto_score    DOUBLE PRECISION,
--     user_score    INT,
--     prompt_tokens INT NOT NULL,
--     completion_tokens INT NOT NULL,
--     cost_usd      DOUBLE PRECISION NOT NULL,
--     duration_ms   INT NOT NULL
--   );
--   CREATE TABLE step_runs (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     session_id TEXT NOT NULL REFERENCES sessions(id),
--     step_no INT NOT NULL, task_type TEXT NOT NULL, skill TEXT NOT NULL,
--     model TEXT NOT NULL, provider TEXT NOT NULL,
--     iterations INT NOT NULL, tool_calls INT NOT NULL,
--     prompt_tokens INT NOT NULL, completion_tokens INT NOT NULL,
--     cost_usd DOUBLE PRECISION NOT NULL,
--     finished_by TEXT NOT NULL, success BOOLEAN NOT NULL, duration_ms INT NOT NULL
--   );
--   CREATE TABLE model_calls (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     session_id TEXT REFERENCES sessions(id),
--     ts TIMESTAMPTZ NOT NULL, date DATE NOT NULL,
--     command TEXT NOT NULL, task_type TEXT NOT NULL,
--     model TEXT NOT NULL, provider TEXT NOT NULL,
--     prompt_tokens INT NOT NULL, completion_tokens INT NOT NULL,
--     total_tokens INT NOT NULL, cost_usd DOUBLE PRECISION NOT NULL
--   );
--   CREATE TABLE command_runs (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     session_id TEXT REFERENCES sessions(id),
--     ts TIMESTAMPTZ NOT NULL, date DATE NOT NULL,
--     command TEXT NOT NULL, args TEXT, objective TEXT,
--     prompt_tokens INT NOT NULL, completion_tokens INT NOT NULL,
--     cost_usd DOUBLE PRECISION NOT NULL, duration_ms INT NOT NULL
--   );

-- ───────────────────────────────────────────────────────────────────────────
-- 1) THE core question: per task type, which model reaches success with the
--    fewest tokens? (only models with ≥50% success and ≥3 observations)
-- ───────────────────────────────────────────────────────────────────────────
WITH eff AS (
  SELECT task_type, model,
         COUNT(*)                                            AS steps,
         AVG(success::int)                                   AS success_rate,
         AVG(prompt_tokens + completion_tokens)
             FILTER (WHERE success)                          AS avg_tokens_per_success,
         AVG(cost_usd) FILTER (WHERE success)                AS avg_cost_per_success,
         AVG(iterations)                                     AS avg_iterations
  FROM step_runs
  GROUP BY task_type, model
)
SELECT DISTINCT ON (task_type)
       task_type, model, steps,
       ROUND(success_rate * 100) || '%'         AS success,
       ROUND(avg_tokens_per_success)            AS min_avg_tokens,
       ROUND(avg_cost_per_success::numeric, 6)  AS cost_per_success
FROM eff
WHERE success_rate >= 0.5 AND steps >= 3
ORDER BY task_type, avg_tokens_per_success ASC;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) Approach efficiency: routing objective → tokens spent vs goal achievement
-- ───────────────────────────────────────────────────────────────────────────
SELECT objective,
       COUNT(*)                                  AS sessions,
       ROUND(AVG(prompt_tokens + completion_tokens)) AS avg_tokens,
       ROUND(AVG(cost_usd)::numeric, 4)          AS avg_cost_usd,
       ROUND(AVG(auto_score) * 100)              AS auto_score_pct,
       ROUND(AVG(user_score)::numeric, 1)        AS avg_user_rating   -- 0..9
FROM sessions
GROUP BY objective
ORDER BY avg_tokens ASC;

-- ───────────────────────────────────────────────────────────────────────────
-- 3) Usage per CLI command (where do the tokens go?)
-- ───────────────────────────────────────────────────────────────────────────
SELECT command,
       COUNT(*)                       AS runs,
       SUM(prompt_tokens)             AS prompt_tokens,
       SUM(completion_tokens)         AS completion_tokens,
       ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
FROM command_runs
GROUP BY command
ORDER BY cost_usd DESC;

-- ───────────────────────────────────────────────────────────────────────────
-- 4) Daily cost by model (mirrors `poly usage`)
-- ───────────────────────────────────────────────────────────────────────────
SELECT date, model,
       COUNT(*)            AS calls,
       SUM(total_tokens)   AS tokens,
       ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
FROM model_calls
GROUP BY date, model
ORDER BY date DESC, cost_usd DESC;

-- ───────────────────────────────────────────────────────────────────────────
-- 5) Token efficiency vs achievement, per model (sessions where it did edits)
--    "Does paying for a stronger model buy more goal achievement per token?"
-- ───────────────────────────────────────────────────────────────────────────
SELECT sr.model,
       COUNT(DISTINCT s.id)                            AS sessions,
       ROUND(AVG(s.user_score)::numeric, 1)            AS avg_user_rating,
       ROUND(AVG(s.auto_score) * 100)                  AS auto_score_pct,
       ROUND(AVG(s.prompt_tokens + s.completion_tokens)) AS avg_session_tokens,
       ROUND((AVG(COALESCE(s.user_score, s.auto_score * 9)) /
              NULLIF(AVG(s.prompt_tokens + s.completion_tokens), 0) * 10000)::numeric, 2)
                                                       AS achievement_per_10k_tokens
FROM sessions s
JOIN step_runs sr ON sr.session_id = s.id AND sr.task_type = 'edit'
GROUP BY sr.model
HAVING COUNT(DISTINCT s.id) >= 2
ORDER BY achievement_per_10k_tokens DESC;
