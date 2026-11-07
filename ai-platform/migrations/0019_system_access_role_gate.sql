-- 0019_system_access_role_gate.sql — bind system scope to a database role.
--
-- The pre-0019 implementation honored ai.system_access solely from a custom
-- GUC. Any role able to run SQL in the application session could set that GUC
-- and bypass tenant RLS. This migration makes system scope require BOTH:
--
--   1. the explicit transaction-local ai.system_access flag, and
--   2. membership in the NOLOGIN role ai_system_access.
--
-- The API runtime role is deliberately not a member. A privileged API SQL
-- injection can therefore no longer turn a tenant request into a cross-tenant
-- read by calling set_config(). The worker/backup/restore/migration roles are
-- members because their defined workflows require discovery or maintenance;
-- see infrastructure/db/roles/README.md.
--
-- Tenant identity (ai.tenant_id) remains a shared-runtime-role limitation:
-- this migration does not protect against arbitrary SQL that can set a
-- different tenant id. API authorization and the non-owner runtime roles remain
-- required. See docs/tenant-isolation.md.
--
-- Prerequisite: one-time role provisioning has created ai_system_access and
-- the runtime roles. Do not apply this migration before provisioning.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(required, ', ' ORDER BY required)
  INTO missing
  FROM unnest(ARRAY[
    'ai_owner', 'ai_system_access', 'ai_api', 'ai_worker',
    'ai_backup', 'ai_restore', 'ai_migrate'
  ]) AS required
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = required);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'missing required database role(s): %. Run '
      'infrastructure/db/roles/provision_roles.sql as a superuser before this '
      'migration.', missing;
  END IF;

  IF NOT pg_has_role('ai_owner', 'ai_system_access', 'MEMBER') THEN
    RAISE EXCEPTION
      'ai_owner must be a member of ai_system_access; rerun '
      'infrastructure/db/roles/provision_roles.sql';
  END IF;

  IF pg_has_role('ai_api', 'ai_system_access', 'MEMBER') THEN
    RAISE EXCEPTION
      'ai_api must not be a member of ai_system_access; rerun '
      'infrastructure/db/roles/provision_roles.sql';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION ai.system_access()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT lower(COALESCE(current_setting('ai.system_access', true), 'off'))
           IN ('on', 'true', '1')
         AND COALESCE(
               pg_has_role(current_user, to_regrole('ai_system_access'), 'MEMBER'),
               false
             )
$$;

COMMENT ON FUNCTION ai.system_access() IS
  'True only when the transaction requested system scope and the current database role is a member of ai_system_access.';

-- Keep helper-function execution narrow. The provisioning script grants these
-- ACLs too; restating them here keeps a fresh bootstrap and a replacement
-- migration consistent. Owners always retain execute implicitly.
REVOKE ALL ON FUNCTION ai.system_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai.system_access()
  TO ai_api, ai_worker, ai_backup, ai_restore, ai_migrate;

