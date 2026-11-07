-- 0015_reliability_backoff.sql — durable retry scheduling for workers.
--
-- Adds an explicit "not before" timestamp to index jobs and event deliveries so
-- bounded exponential backoff survives worker restarts. Rows without a value
-- remain immediately eligible, preserving existing deployments.

ALTER TABLE ai.jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS jobs_next_attempt_idx
  ON ai.jobs (status, next_attempt_at);

ALTER TABLE ai.event_deliveries
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS event_deliveries_next_attempt_idx
  ON ai.event_deliveries (consumer_group, status, next_attempt_at);
