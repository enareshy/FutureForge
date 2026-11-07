# Least-privilege database roles

This directory contains one-time, DBA-run provisioning for the SEC-19 residual
risk. The application migrations remain in `migrations/`; this is separate
because only a superuser can create roles and transfer ownership.

## Status

The SQL and deployment wiring are prepared in this repository. The roles have
**not** been provisioned in the development environment because the available
`helix` role is not a superuser and has no `CREATEROLE` privilege. Do not claim
the role-separation residual risk closed until the operator has run this
procedure and the role integration tests pass.

## Prerequisites

- PostgreSQL superuser (or an equivalent role allowed to create roles and
  transfer ownership).
- A short maintenance window is required. Stop API, workers, backup jobs, and
  migration jobs before running the script. Ownership transfer takes locks on
  each `ai` object, and after commit the legacy login no longer owns the schema
  and may lose access; pooled connections must not keep serving with it.
- On a fresh installation, stop after migration 0018, provision the roles, then
  run migration 0019. `scripts/migrate.sh` supports
  `AI_MIGRATION_STOP_AFTER=0018_tenant_row_level_security.sql`; the normal
  Kubernetes Job can take the same variable for that one run. After
  provisioning, rerun migrations without the stop variable, then rerun this
  script once more so grants cover any new objects.
- Deploy-time secrets must be available out-of-band. This script never sets or
  prints passwords.

## Procedure

1. Create roles and transfer ownership:

```bash
psql --single-transaction -v ON_ERROR_STOP=1 \
  -d "$POSTGRES_DB" \
  -f infrastructure/db/roles/provision_roles.sql
```

2. Set a unique password for each LOGIN role using the secret manager or
   `psql` `\password` as superuser:

```text
ai_api, ai_worker, ai_backup, ai_restore, ai_migrate
```

Never reuse the owner password and never store these values in a committed
file. The Kubernetes and Compose examples expect separate values.

3. Apply migration `0019_system_access_role_gate.sql` through the normal
   migration runner using the `ai_migrate` credential and `ai_owner` session
   role. The migration fails closed if the marker role is absent. On a fresh
   install, run migrations with
   `AI_MIGRATION_STOP_AFTER=0018_tenant_row_level_security.sql` first, then
   provision, then rerun without the stop variable.

4. Put the credentials in the environment-specific secret stores:

- API: `AI_API_POSTGRES_PASSWORD` (Kubernetes `ai-api-secrets`)
- Workers: `AI_WORKER_POSTGRES_PASSWORD`
- Backup: `AI_BACKUP_POSTGRES_PASSWORD`
- Migration: `AI_MIGRATION_POSTGRES_PASSWORD`
- Restore/drill: `RESTORE_TARGET_USER=ai_restore` and
  `RESTORE_TARGET_PASSWORD` in the operator environment

Compose uses `WORKER_POSTGRES_USER`/`WORKER_POSTGRES_PASSWORD` and
`BACKUP_POSTGRES_USER`/`BACKUP_POSTGRES_PASSWORD`; see `.env.example`.

Migration runner:

```bash
AI_DB_ROLE_PROFILE=migrate \
AI_MIGRATION_DB_USER=ai_migrate \
AI_MIGRATION_DB_PASSWORD='...' \
AI_MIGRATION_ROLE=ai_owner \
bash scripts/migrate.sh
```

5. Run the operator verification:

```bash
AI_TEST_ROLE_DB=1 \
AI_ROLE_API_DSN='postgresql://ai_api:...@host/helix' \
AI_ROLE_WORKER_DSN='postgresql://ai_worker:...@host/helix' \
AI_ROLE_BACKUP_DSN='postgresql://ai_backup:...@host/helix' \
AI_ROLE_RESTORE_DSN='postgresql://ai_restore:...@host/helix' \
AI_ROLE_MIGRATE_DSN='postgresql://ai_migrate:...@host/helix' \
bash scripts/verify-db-roles.sh
```

Use a disposable/staging database for this test because it writes and removes
temporary tenant markers (all role checks roll back writes). Never point the
test at production. The test file is `apps/ai-api/tests/test_db_roles.py`; it
skips unless `AI_TEST_ROLE_DB=1` and all five DSNs are present.

6. Run a real backup with the backup credential and a drill with the restore
   credential against isolated targets. The runbook is
   `docs/backup-recovery.md`.

## Rollback

If the change must be reverted, do not grant the owner role back to API or
worker roles. Instead:

- Stop API/worker/backup jobs that use the new roles.
- Keep the roles and ownership intact while diagnosing; do not reassign tables
  to a runtime role.
- If the `ai_system_access` gate itself must be rolled back, treat that as a
  security-reviewed forward migration (replace the function definition), not
  as an automatic migration rollback. The gate is the control that prevents an
  API-role compromise from enabling system-wide reads.
- Remove login credentials/permissions only after the application is stopped or
  the old credentials are rotated.

Dropping roles or reassigning ownership is a separate, approved destructive
operation. This repository does not automate it.
