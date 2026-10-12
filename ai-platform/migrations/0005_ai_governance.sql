-- 0005_ai_governance.sql — configurable AI usage, retention and feature policies.
--
-- Forward-only. Applied in a single transaction by scripts/migrate.sh.
--
-- One policy document per tenant. Absence of a row means "platform defaults".
-- Secrets are never stored here; policies reference secret managers by name.

CREATE TABLE IF NOT EXISTS ai.governance_policies (
  tenant_id  bigint      PRIMARY KEY,
  policy     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_governance_policies_updated_at ON ai.governance_policies;
CREATE TRIGGER trg_governance_policies_updated_at BEFORE UPDATE ON ai.governance_policies
  FOR EACH ROW EXECUTE FUNCTION ai.touch_updated_at();
