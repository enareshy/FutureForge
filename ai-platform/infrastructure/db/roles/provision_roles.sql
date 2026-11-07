-- One-time least-privilege database role provisioning for the AI platform.
--
-- Run this as a PostgreSQL superuser, AFTER the ai schema exists and BEFORE
-- applying migration 0019_system_access_role_gate.sql. It is idempotent and
-- safe to rerun after schema migrations to refresh object grants.
--
--   psql --single-transaction -v ON_ERROR_STOP=1 \
--     -d "$POSTGRES_DB" -f infrastructure/db/roles/provision_roles.sql
--
-- It does not set passwords and does not print or accept credentials. Set a
-- unique password for each LOGIN role out-of-band through the deployment
-- secret manager (or psql \\password), then place the username/password in the
-- role-specific Kubernetes/Compose secret.
--
-- Role model:
--   ai_owner          NOLOGIN, owns ai schema objects, member of ai_system_access
--   ai_system_access  NOLOGIN marker role; only members may honor the
--                     ai.system_access GUC after migration 0019
--   ai_api            API runtime, non-owner, no system access
--   ai_worker         workers, non-owner, system access for discovery/claiming only
--   ai_backup         daily dump/metrics, non-owner, no DDL, system read access
--   ai_restore        isolated restore/drill, non-owner, CREATEDB, system access
--   ai_migrate        schema migrations, non-owner, SET ROLE ai_owner only
--
-- Runtime roles never own the schema or protected tables and never receive
-- SUPERUSER, CREATEROLE, or BYPASSRLS.

DO $$
DECLARE
  role_name text;
BEGIN
  IF current_setting('is_superuser') <> 'on' THEN
    RAISE EXCEPTION
      'role provisioning requires a superuser; the application/migration roles cannot run it';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['ai_owner', 'ai_system_access'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE '
      'NOBYPASSRLS NOINHERIT', role_name
    );
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['ai_api', 'ai_worker', 'ai_backup', 'ai_restore', 'ai_migrate'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEROLE NOBYPASSRLS NOINHERIT', role_name
    );
  END LOOP;
END
$$;

-- Only the isolated restore role may create databases. The daily backup role
-- must not be able to create or drop a database.
ALTER ROLE ai_restore NOSUPERUSER NOCREATEROLE NOBYPASSRLS NOINHERIT CREATEDB;
ALTER ROLE ai_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE ai_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE ai_backup NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
ALTER ROLE ai_migrate NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- Membership is deliberate. NOINHERIT means a login role must SET ROLE to use
-- the owner's object privileges, but pg_has_role(...,'MEMBER') still recognizes
-- the system marker for the migration/backup/restore/worker boundary.
GRANT ai_system_access TO ai_owner;
GRANT ai_owner TO ai_migrate;
GRANT ai_system_access TO ai_migrate, ai_worker, ai_backup, ai_restore;
REVOKE ai_system_access FROM ai_api;
REVOKE ai_owner FROM ai_api, ai_worker, ai_backup, ai_restore;

-- Move ownership away from the legacy deployment role. This is deliberately
-- limited to the ai schema; it does not REASSIGN OWNED for the whole database.
CREATE SCHEMA IF NOT EXISTS ai AUTHORIZATION ai_owner;
ALTER SCHEMA ai OWNER TO ai_owner;

DO $$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'ai'
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
      -- Serial/identity sequences are owned by their table; ALTER TABLE ...
      -- OWNER TO cascades to them. Changing the sequence directly raises
      -- "cannot change owner of sequence ... linked to table", so skip any
      -- sequence with an auto/identity dependency on a table.
      AND NOT (
        c.relkind = 'S'
        AND EXISTS (
          SELECT 1
          FROM pg_depend d
          WHERE d.objid = c.oid
            AND d.deptype IN ('a', 'i')
        )
      )
    ORDER BY c.relkind, c.relname
  LOOP
    CASE obj.relkind
      WHEN 'S' THEN
        EXECUTE format('ALTER SEQUENCE ai.%I OWNER TO ai_owner', obj.relname);
      WHEN 'v' THEN
        EXECUTE format('ALTER VIEW ai.%I OWNER TO ai_owner', obj.relname);
      WHEN 'm' THEN
        EXECUTE format('ALTER MATERIALIZED VIEW ai.%I OWNER TO ai_owner', obj.relname);
      WHEN 'f' THEN
        EXECUTE format('ALTER FOREIGN TABLE ai.%I OWNER TO ai_owner', obj.relname);
      ELSE
        EXECUTE format('ALTER TABLE ai.%I OWNER TO ai_owner', obj.relname);
    END CASE;
  END LOOP;

  FOR obj IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ai'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ai_owner', obj.signature);
  END LOOP;

  FOR obj IN
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'ai'
      AND t.typtype IN ('e', 'd')
  LOOP
    EXECUTE format('ALTER TYPE ai.%I OWNER TO ai_owner', obj.typname);
  END LOOP;
END
$$;

-- No implicit PUBLIC access. Runtime roles get only the schema, table,
-- sequence, and helper-function privileges required by their code paths.
REVOKE ALL ON SCHEMA ai FROM PUBLIC;
GRANT USAGE ON SCHEMA ai TO ai_api, ai_worker, ai_backup, ai_restore, ai_migrate;

REVOKE ALL ON ALL TABLES IN SCHEMA ai FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ai FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ai FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ai_api, ai_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ai TO ai_api, ai_worker;
-- Global bookkeeping is not runtime-readable or writable.
REVOKE ALL ON TABLE ai.schema_migrations FROM ai_api, ai_worker;
REVOKE ALL ON TABLE ai.backup_runs FROM ai_api, ai_worker;
-- The API exposes backup health gauges; it never mutates that table.
GRANT SELECT ON TABLE ai.backup_runs TO ai_api;

-- A daily backup needs read access plus its own run metadata. It cannot create
-- databases or alter the protected schema.
GRANT SELECT ON ALL TABLES IN SCHEMA ai TO ai_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA ai TO ai_backup;
GRANT SELECT, INSERT, UPDATE ON TABLE ai.backup_runs TO ai_backup;
-- backup_runs.id is a GENERATED identity column; writing a run row needs its
-- own sequence, not every sequence in the schema.
DO $$
DECLARE
  seq_name text;
BEGIN
  seq_name := pg_get_serial_sequence('ai.backup_runs', 'id');
  IF seq_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO ai_backup', seq_name);
  END IF;
END
$$;

-- Restore operates only on an explicitly created/isolated target. It can load
-- schema and data there, but is not an API/worker role and is not used in
-- normal serving.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai TO ai_restore;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ai TO ai_restore;
GRANT CREATE ON SCHEMA ai TO ai_restore;
DO $$
BEGIN
  -- ai_owner owns the ai schema and runs DDL inside it, but it is NOLOGIN and
  -- reached only via SET ROLE from ai_migrate. PostgreSQL still checks CREATE
  -- on the database for `CREATE SCHEMA [IF NOT EXISTS]`, which scripts/migrate.sh
  -- issues as ai_owner even when the schema already exists. Without this grant
  -- the documented second-phase migration fails with "permission denied for
  -- database". ai_owner remains NOSUPERUSER/NOCREATEROLE/NOBYPASSRLS.
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO ai_owner', current_database());
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO ai_restore', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ai_api, ai_worker, ai_backup, ai_migrate', current_database());
END
$$;

-- RLS policy helpers. Migration 0019 replaces ai.system_access() with the
-- ai_system_access role gate; ACLs on the existing function OID are preserved.
GRANT EXECUTE ON FUNCTION ai.current_tenant_id() TO ai_api, ai_worker, ai_backup, ai_restore, ai_migrate;
GRANT EXECUTE ON FUNCTION ai.tenant_isolation_allows(bigint) TO ai_api, ai_worker, ai_backup, ai_restore, ai_migrate;
GRANT EXECUTE ON FUNCTION ai.system_access() TO ai_api, ai_worker, ai_backup, ai_restore, ai_migrate;
-- Trigger functions run on DML. They carry no caller-supplied SQL and must be
-- executable by the roles that write the protected tables. ai_backup only
-- reads and does not need them.
GRANT EXECUTE ON FUNCTION ai.touch_updated_at() TO ai_api, ai_worker, ai_restore;
GRANT EXECUTE ON FUNCTION ai.guard_agent_version_immutable() TO ai_api, ai_worker, ai_restore;
GRANT EXECUTE ON FUNCTION ai.guard_agent_tool_version_immutable() TO ai_api, ai_worker, ai_restore;

-- Required after adding objects in a future migration: rerun this script so
-- the explicit object grants cover the new tables/sequences/functions.
