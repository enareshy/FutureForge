-- 0018_tenant_row_level_security.sql — database-level tenant isolation.
--
-- Every table that directly carries tenant_id gets a single FOR ALL policy
-- using both USING and WITH CHECK. Child tables without tenant_id use their
-- authoritative parent relationship. Two operational tables intentionally
-- remain global and are documented below.
--
-- Context is set per transaction by the application:
--   SELECT set_config('ai.tenant_id', '<validated tenant>', true);
--   SELECT set_config('ai.system_access', 'on', true);
-- Both values are transaction-local; PostgreSQL discards them at COMMIT or
-- ROLLBACK. Missing/empty context yields NULL tenant and therefore no rows.
--
-- FORCE is required because the current deployment role owns the tables and
-- would otherwise bypass RLS. A superuser or BYPASSRLS role still bypasses
-- policies; the deployment runbook requires those roles to be reserved for
-- maintenance and backup.

CREATE OR REPLACE FUNCTION ai.current_tenant_id()
RETURNS bigint
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('ai.tenant_id', true), '')::bigint
$$;

CREATE OR REPLACE FUNCTION ai.system_access()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT lower(COALESCE(current_setting('ai.system_access', true), 'off'))
         IN ('on', 'true', '1')
$$;

CREATE OR REPLACE FUNCTION ai.tenant_isolation_allows(row_tenant bigint)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT ai.system_access() OR row_tenant = ai.current_tenant_id()
$$;

COMMENT ON FUNCTION ai.current_tenant_id() IS
  'Transaction-local authenticated tenant; NULL when no tenant context is set.';
COMMENT ON FUNCTION ai.system_access() IS
  'Explicit cross-tenant maintenance/worker scope. Never derived from client input.';
COMMENT ON FUNCTION ai.tenant_isolation_allows(bigint) IS
  'RLS predicate for tables with a direct tenant_id column.';

-- Fail the migration if authoritative relationships already cross tenants.
-- This does not guess ownership; an operator must resolve any reported row.
DO $$
DECLARE
  spec record;
  mismatch bigint;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('documents', 'source_id', 'knowledge_sources', 'id'),
      ('document_chunks', 'document_id', 'documents', 'id'),
      ('embeddings', 'chunk_id', 'document_chunks', 'id'),
      ('jobs', 'source_id', 'knowledge_sources', 'id'),
      ('models', 'provider_id', 'providers', 'id'),
      ('executions', 'agent_id', 'agents', 'id'),
      ('executions', 'model_id', 'models', 'id'),
      ('executions', 'parent_execution_id', 'executions', 'id'),
      ('experiment_runs', 'experiment_id', 'experiments', 'id'),
      ('agent_execution_steps', 'execution_id', 'executions', 'id'),
      ('agent_tool_invocations', 'execution_id', 'executions', 'id'),
      ('agent_tool_invocations', 'step_id', 'agent_execution_steps', 'id'),
      ('agent_artifacts', 'execution_id', 'executions', 'id'),
      ('agent_checkpoints', 'execution_id', 'executions', 'id'),
      ('agent_approvals', 'execution_id', 'executions', 'id'),
      ('agent_approvals', 'step_id', 'agent_execution_steps', 'id'),
      ('agent_version_tools', 'tool_id', 'agent_tools', 'id'),
      ('agent_version_tools', 'tool_version_id', 'agent_tool_versions', 'id'),
      ('agent_tool_versions', 'tool_id', 'agent_tools', 'id'),
      ('assistant_messages', 'conversation_id', 'assistant_conversations', 'id'),
      ('assistant_messages', 'parent_message_id', 'assistant_messages', 'id'),
      ('assistant_messages', 'execution_id', 'executions', 'id'),
      ('assistant_message_sources', 'message_id', 'assistant_messages', 'id'),
      ('assistant_message_sources', 'document_id', 'documents', 'id'),
      ('assistant_message_sources', 'chunk_id', 'document_chunks', 'id'),
      ('assistant_context_refs', 'conversation_id', 'assistant_conversations', 'id'),
      ('assistant_context_refs', 'message_id', 'assistant_messages', 'id'),
      ('assistant_conversation_summaries', 'conversation_id', 'assistant_conversations', 'id'),
      ('assistant_conversation_summaries', 'through_message_id', 'assistant_messages', 'id'),
      ('usage_records', 'execution_id', 'executions', 'id'),
      ('feedback', 'execution_id', 'executions', 'id'),
      ('feedback', 'message_id', 'assistant_messages', 'id'),
      ('audit_events', 'execution_id', 'executions', 'id'),
      ('search_duplicate_findings', 'document_a_id', 'documents', 'id'),
      ('search_duplicate_findings', 'document_b_id', 'documents', 'id')
    ) AS v(child, child_col, parent, parent_col)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM ai.%I c JOIN ai.%I p ON p.%I = c.%I '
      'WHERE c.tenant_id <> p.tenant_id',
      spec.child, spec.parent, spec.parent_col, spec.child_col
    ) INTO mismatch;
    IF mismatch > 0 THEN
      RAISE EXCEPTION
        'cross-tenant reference detected: %.% references another tenant (% rows)',
        spec.child, spec.child_col, mismatch;
    END IF;
  END LOOP;
END
$$;

-- Direct tenant ownership: one policy covers SELECT/INSERT/UPDATE/DELETE.
-- The WITH CHECK clause prevents inserting another tenant's row and prevents
-- UPDATE from moving a row to another tenant.
DO $$
DECLARE
  tbl record;
BEGIN
  FOR tbl IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ai'
      AND c.relkind = 'r'
      AND EXISTS (
        SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname = 'tenant_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', tbl.relname);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY', tbl.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ai.%I', tbl.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON ai.%I FOR ALL TO PUBLIC '
      'USING (ai.tenant_isolation_allows(tenant_id)) '
      'WITH CHECK (ai.tenant_isolation_allows(tenant_id))',
      tbl.relname
    );
  END LOOP;
END
$$;

-- Indirect ownership: no tenant_id column, so ownership is derived from the
-- authoritative parent. The parent subquery is itself subject to RLS, but the
-- explicit p.tenant_id predicate keeps the rule obvious and independent of the
-- parent policy's implementation.
DO $$
DECLARE
  spec record;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('agent_versions', 'agent_id', 'agents', 'id'),
      ('evaluation_results', 'evaluation_id', 'evaluations', 'id'),
      ('event_dead_letters', 'event_id', 'events', 'event_id'),
      ('event_deliveries', 'event_id', 'events', 'event_id'),
      ('ml_model_versions', 'ml_model_id', 'ml_models', 'id'),
      ('model_versions', 'model_id', 'models', 'id'),
      ('prompt_versions', 'template_id', 'prompt_templates', 'id')
    ) AS v(child, child_col, parent, parent_col)
  LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', spec.child);
    EXECUTE format('ALTER TABLE ai.%I FORCE ROW LEVEL SECURITY', spec.child);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON ai.%I', spec.child);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON ai.%I FOR ALL TO PUBLIC '
      'USING (ai.system_access() OR EXISTS ('
      '  SELECT 1 FROM ai.%I p WHERE p.%I = ai.%I.%I '
      '  AND p.tenant_id = ai.current_tenant_id())) '
      'WITH CHECK (ai.system_access() OR EXISTS ('
      '  SELECT 1 FROM ai.%I p WHERE p.%I = ai.%I.%I '
      '  AND p.tenant_id = ai.current_tenant_id()))',
      spec.child,
      spec.parent, spec.parent_col, spec.child, spec.child_col,
      spec.parent, spec.parent_col, spec.child, spec.child_col
    );
  END LOOP;
END
$$;

-- Intentionally global operational tables:
--   ai.backup_runs      : backup/drill status gauges, no tenant data.
--   ai.schema_migrations: migration bookkeeping, not application data.
-- Neither table contains tenant-owned content or identifiers.

COMMENT ON TABLE ai.backup_runs IS
  'Global operational backup metadata; intentionally not tenant-scoped.';
COMMENT ON TABLE ai.schema_migrations IS
  'Global migration bookkeeping; intentionally not tenant-scoped.';
