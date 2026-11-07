-- 0013_stage6_execution_governance.sql — Stage 6 execution hardening.
--
-- Additive hardening for the durable agent execution engine:
--   * lease generation fencing for every execution-owned write;
--   * written result payloads so a crashed worker can reconcile instead of
--     re-running uncertain side effects;
--   * single-use approvals bound to one execution, step and operation;
--   * durable agent/tool disablement preserved by publish/rollback.
--
-- Existing approval rows are retained as audit history. Active duplicates for
-- the same execution and operation are superseded (cancelled) before the new
-- unique index is created, so the migration cannot fail on legacy data.

-- --- Execution lease fencing --------------------------------------------
ALTER TABLE ai.executions
  ADD COLUMN IF NOT EXISTS lease_generation bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS executions_agent_lease_idx
  ON ai.executions (status, lease_expires_at)
  WHERE operation = 'agent';

-- --- Tool invocation reconciliation -------------------------------------
ALTER TABLE ai.agent_tool_invocations
  ADD COLUMN IF NOT EXISTS result jsonb;

-- --- Approval consumption -----------------------------------------------
ALTER TABLE ai.agent_approvals
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS consumed_by text;

-- Supersede legacy duplicate active approvals, keeping the earliest request.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, execution_id, operation_hash
           ORDER BY created_at, id
         ) AS rn
  FROM ai.agent_approvals
  WHERE consumed_at IS NULL
    AND status IN ('pending', 'approved')
)
UPDATE ai.agent_approvals a
SET status = 'cancelled',
    decision_reason = COALESCE(
      a.decision_reason,
      'superseded by 0013 active approval uniqueness migration'
    ),
    decided_at = COALESCE(a.decided_at, now())
FROM ranked r
WHERE a.id = r.id AND r.rn > 1;

ALTER TABLE ai.agent_approvals
  DROP CONSTRAINT IF EXISTS agent_approvals_hash_uniq;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'ai' AND indexname = 'agent_approvals_active_uniq'
  ) THEN
    CREATE UNIQUE INDEX agent_approvals_active_uniq
      ON ai.agent_approvals (tenant_id, execution_id, operation_hash)
      WHERE consumed_at IS NULL
        AND status IN ('pending', 'approved');
  END IF;
END $$;
