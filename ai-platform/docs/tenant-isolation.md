# Tenant isolation and PostgreSQL row-level security

SEC-19 adds a database-level backstop to the repository tenant predicates. The
API still authorizes every request and every query still carries an explicit
`tenant_id` predicate; RLS now also rejects tenant-owned rows when that
predicate is accidentally omitted.

## Architecture assessment

| Question | Finding |
|---|---|
| Tables requiring isolation | 36 tables carry `tenant_id bigint NOT NULL`. Seven child tables inherit ownership from an authoritative parent. `ai.schema_migrations` and `ai.backup_runs` are global operational metadata. |
| Existing repository boundaries | Knowledge, conversations, executions, agents, approvals, events and search repositories consistently receive a tenant from the service layer. SEC-01, SEC-02, SEC-15 and SEC-17 closed the known application-level gaps. |
| Missing/indirect predicates | Global queue discovery (`list_jobs_by_status`, `list_tenant_ids`, `claim_agent_execution`), event backlog/delivery discovery, index reconciliation and backup were intentionally cross-tenant. Child tables (`model_versions`, `prompt_versions`, `agent_versions`, `evaluation_results`, `event_deliveries`, `event_dead_letters`, `ml_model_versions`) have no own tenant column. |
| Reliable tenant source | `Principal.tenant_id` comes from the verified enterprise session returned by the identity provider; it is never read from a request body or query string. The `require_tenant` guard rejects a missing tenant. |
| Pooling | One asyncpg pool per process (max 5 connections). Every wrapper query runs inside a transaction and explicitly installs the context. |
| Context leakage | The settings use `set_config(..., is_local=true)`. PostgreSQL resets them at COMMIT/ROLLBACK, including on a failed transaction. The values are also held in an `asyncio` `ContextVar`, so concurrent tasks do not share state. |
| Worker context | Global discovery/claiming uses `system_scope()`; each claimed job/event/execution then enters `tenant_scope(tenant_id)`. Reconciliation enumerates tenants with system scope and processes each tenant separately. |
| Legitimate cross-tenant operations | Queue enumeration/claiming, reconciliation tenant discovery, event backlog, backup/restore and migrations. All are narrow, code-owned paths; none accept a tenant from client input. |
| Roles that can bypass | Until the split roles are provisioned, the documented development role (`helix`) is not superuser and lacks `BYPASSRLS`, but it owns the tables; `FORCE ROW LEVEL SECURITY` keeps it subject to policies. After provisioning, runtime roles do not own tables and are not superuser/`BYPASSRLS`. A PostgreSQL superuser or `BYPASSRLS` role still bypasses policies. |
| What would break without changes | Global queue/backlog queries would return no rows, worker per-job processing would have no tenant, and backup would dump only rows visible to an empty context. The code and tests in this change cover those paths. |
| Incremental rollout | Migration 0018 is a single forward transaction. The API verifies RLS at startup (`AI_RLS_VERIFY=true`) before serving traffic. |

## Policy model

Policies are created by `migrations/0018_tenant_row_level_security.sql`.

Direct-ownership tables (36):

```sql
CREATE POLICY tenant_isolation ON ai.<table> FOR ALL TO PUBLIC
USING (ai.tenant_isolation_allows(tenant_id))
WITH CHECK (ai.tenant_isolation_allows(tenant_id));
```

`ai.tenant_isolation_allows(row_tenant)` is:

```sql
ai.system_access() OR row_tenant = ai.current_tenant_id()
```

Indirect child tables (7) use the authoritative parent:

| Child | Parent key |
|---|---|
| `agent_versions` | `agents.id` |
| `evaluation_results` | `evaluations.id` |
| `event_deliveries`, `event_dead_letters` | `events.event_id` |
| `ml_model_versions` | `ml_models.id` |
| `model_versions` | `models.id` |
| `prompt_versions` | `prompt_templates.id` |

Their policy is `system_access() OR EXISTS (parent row with matching key and
parent.tenant_id = current_tenant_id())`, with the same expression in
`WITH CHECK`. The migration also fails if existing direct-tenant relationships
cross a tenant boundary; it never guesses or backfills ownership.

Missing or empty context yields `NULL`, so `tenant_id = NULL` is not true and no
rows are visible. `NULL tenant_id` inserts are rejected by the existing
`NOT NULL` constraints. Moving a row to another tenant fails `WITH CHECK`.

### Intentionally global tables

- `ai.schema_migrations`: migration bookkeeping.
- `ai.backup_runs`: backup/drill status and metrics; no tenant identifiers,
  payloads, object keys or secrets.

Neither contains customer data. They are excluded from the startup coverage
check.

## Tenant context

The DB wrapper (`infrastructure/db/database.py`) applies this at the start of
every transaction:

```sql
SELECT set_config('ai.tenant_id', $1, true),
       set_config('ai.system_access', $2, true);
```

- API requests: `get_principal` enters `tenant_scope(principal.tenant_id)` for
  the request lifetime.
- Indexer: system scope for queue discovery/reclaim/metrics; tenant scope for
  each `process_job`.
- Event consumer: system scope for `list_undelivered`/backlog; tenant scope for
  each handler and delivery update.
- Agent worker: system scope for `claim_agent_execution`; tenant scope for
  `run_claimed`.
- Reconciler: system scope for `list_tenant_ids` and aggregate metrics; tenant
  scope for each tenant's reconciliation and audit record.
- Migrations: the runner sets `PGOPTIONS=-c ai.system_access=on` (and, with a
  provisioned login, `-c role=ai_owner`) so data backfills are not silently
  filtered.
- Backup/restore: `PgConn.env()` adds the same `PGOPTIONS` option for
  `pg_dump`, `pg_restore`, `psql` and integrity checks; `pg_dump` also runs with
  `--enable-row-security` so `FORCE` RLS does not abort the dump. The option is
  never exported to the API or workers.
- Since migration 0019, setting `ai.system_access=on` is not sufficient: the
  current database role must also be a member of the NOLOGIN marker role
  `ai_system_access`. The API role is deliberately not a member.

The wrapper uses a transaction for every query, including single-query reads,
because `SET LOCAL` is only safe inside a transaction. This changes autocommit
behaviour but not query results. Multi-statement repository writes already use
explicit transactions and receive the same context once at entry.

## Database roles and administrative access

Two layers are involved:

1. **Application authorization** decides whether a request may act for a
   tenant. It remains the primary control.
2. **Database roles** limit what a compromised or buggy process can do if it
   can execute SQL. Runtime roles are non-owners and cannot bypass RLS.

The development environment historically used one table-owning login
(`helix`). That login cannot provision roles: it has `CREATEDB` but not
`SUPERUSER` or `CREATEROLE`. The least-privilege model is therefore shipped as
reviewed artifacts and is not yet provisioned here.

### Role model

`infrastructure/db/roles/provision_roles.sql` (run once by a superuser) creates:

| Role | Login | Purpose | System scope |
|---|---|---|---|
| `ai_owner` | no | Owns the `ai` schema and objects; no application connection | member |
| `ai_system_access` | no | Marker role for the trusted system boundary | n/a |
| `ai_api` | yes | API request path | **not a member** |
| `ai_worker` | yes | Queue discovery/claim and tenant-scoped processing | member |
| `ai_backup` | yes | Dump, integrity checks, backup run metadata | member |
| `ai_restore` | yes | Isolated restore/drill database; only role with `CREATEDB` | member |
| `ai_migrate` | yes | Migration login; may `SET ROLE ai_owner` | member |

None of the login roles receives `SUPERUSER`, `CREATEROLE`, `BYPASSRLS`, or
ownership of the AI tables. Runtime grants are explicit: API/worker receive
DML and sequence use; backup receives read access plus `backup_runs` writes;
restore receives DML plus `CREATE` on the schema and database; migrate has no
direct table access and must enter the owner role for DDL.

`provision_roles.sql` transfers ownership of the existing schema, tables,
sequences, views, routines and enum/domain types to `ai_owner`, revokes
`PUBLIC`, and grants each role only the paths its code uses. It is idempotent
and must be rerun after a migration that creates objects so the explicit
object grants cover them.

### System-scope boundary (migration 0019)

`migrations/0019_system_access_role_gate.sql` replaces `ai.system_access()`:

```sql
ai.system_access GUC is on
AND pg_has_role(current_user, 'ai_system_access', 'MEMBER')
```

Consequences:

- A tenant request handled by `ai_api` cannot turn a SQL injection into a
  cross-tenant read by calling `set_config('ai.system_access', 'on', true)`.
- Workers, backup, restore and migration retain the narrow global discovery
  and maintenance paths they need.
- The migration fails closed if any of the roles are missing. Do not apply it
  before provisioning.

Tenant identity is still a shared-role GUC. Even as `ai_api`, arbitrary SQL can
set a different `ai.tenant_id`; RLS would then treat that tenant as current.
This is not claimed to protect against a compromised application process or
raw SQL execution. API authorization, SQL-injection prevention, and keeping
credentials away from tenants remain required. The role split meaningfully
reduces blast radius (no owner/DDL/`BYPASSRLS`, no system scope for API), but it
does not make the tenant GUC a cryptographic identity.

### Runtime verification

- Startup (`PostgresDatabase.connect`) checks the connected role when
  `AI_DB_ROLE_PROFILE` is set. It rejects superuser, `BYPASSRLS`, table
  ownership, unexpected role names, `CREATEDB`/`CREATEROLE` on API/worker
  profiles, system membership on the API profile, and missing system
  membership on worker/backup/migration profiles.
- Staging/production require `AI_DB_ROLE_PROFILE` (`api` or `worker`) and
  `AI_DB_EXPECTED_ROLE` when `AI_REPOSITORY=postgres`; there is no silent
  fallback to the owner role.
- The backup tool applies the same checks when `AI_DB_ROLE_PROFILE` is set and
  uses `RESTORE_TARGET_*` for the isolated restore connection. The restore role
  is verified separately, including `CREATEDB` when creating a database.
- `scripts/verify-db-roles.sh` runs `tests/test_db_roles.py` against the real
  per-role DSNs.

### Provisioning order

1. Take a backup and confirm it is restorable.
2. Stop API/worker/backup/migration processes, then run `provision_roles.sql`
   as a superuser in a maintenance window. It changes object ownership in one
   transaction and does not accept passwords. Old pooled sessions must not keep
   serving after the ownership change; they may lose access.
3. Set a unique password for each login role through the secret manager.
4. Apply migrations through the `ai_migrate` login (it enters `ai_owner`), which
   includes `0019_system_access_role_gate.sql` on a database that has 0018.
5. Deploy workload manifests with the per-role credentials.
6. Run `scripts/verify-db-roles.sh`. The existing RLS fixture suite needs
   system scope plus DML to seed tenants, so run it as a privileged fixture role
   such as `ai_worker` (never `ai_api`); the new role suite is the runtime-role
   evidence.

Until steps 2-6 are completed and verified, the residual risk below stays open.
Rollback of the role split is a reviewed operation that restores the previous
ownership and credentials; it is not an application rollback switch. Do not
drop `ai_system_access` while migration 0019 is installed.

## Deployment order

1. Apply `migrations/0018_tenant_row_level_security.sql` with `make migrate`.
   The migration is atomic and fails on cross-tenant relationships rather than
   guessing.
2. Provision the split roles (see above) and configure the per-workload
   credentials. This is required before step 3.
3. Apply `migrations/0019_system_access_role_gate.sql` through the migration
   login. It fails closed if the roles or 0018 are missing.
4. Start API/workers from the matching release. Startup fails closed if a
   protected table is missing RLS/FORCE or its `tenant_isolation` policy
   (`AI_RLS_VERIFY=true`, the default), and the role verification rejects an
   owner/superuser/`BYPASSRLS` or otherwise mismatched role.
5. Confirm `/readyz`, run one worker cycle, and run
   `scripts/verify-db-roles.sh`. Backups built from this release include
   `PGOPTIONS` for system access; older backup images are not RLS-compatible.
6. Do not run old API/worker code after the migration: global queue queries
   would return empty results.

`AI_RLS_VERIFY=false` is an emergency diagnostic switch only. It does not
disable policies and must not be left set in production.

### Rollback

There is no automatic rollback. Diagnose first; if isolation must be removed in
a non-production environment, author a reviewed forward migration that drops
the `tenant_isolation` policies and disables/removes `FORCE ROW LEVEL SECURITY`
one table at a time. Do not drop the helper functions or the schema. Re-enable
and re-run the RLS tests immediately. Production rollback requires the same
security review as any change that removes an isolation control; it is not an
operator default.

## Performance

The policy predicate is a SQL function and is inlined by PostgreSQL. On the
development dataset, representative plans show the predicate as a normal
`Filter` and use existing tenant indexes when selectivity makes them useful:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT id, title, status FROM ai.documents
WHERE tenant_id = 1 ORDER BY id DESC LIMIT 20;
```

No indexes were added by this change. Existing indexes already cover the main
tenant access paths (`documents`, `document_chunks`, `embeddings`, `jobs`,
`executions`, `assistant_*`, `events`, agents, approvals). Small tables use a
sequential scan; that is the correct plan for their size. Index additions should
be justified by production query plans, not by RLS alone.

Child-table policies perform an indexed/primary-key lookup on the parent. They
are not recursive: each policy references exactly one parent whose own policy
only checks the tenant helper.

## Observability

New metrics (low cardinality, no tenant or record identifiers):

- `ai_rls_context_missing_total{operation}` — a query touched `ai` tenant data
  without a tenant/system context. The query still fails closed by returning no
  rows (reads) or by an RLS error (writes).
- `ai_rls_denied_total{operation}` — PostgreSQL rejected a write with SQLSTATE
  `42501` and a row-level-security message. Logs contain only operation and
  SQLSTATE, never SQL text, parameters, tenant IDs or content.

Suggested alerts: any sustained increase in `ai_rls_context_missing_total`, or
any `ai_rls_denied_total` outside an expected negative test.

## Security tests

`apps/ai-api/tests/test_rls_tenant_isolation.py` uses real PostgreSQL and a
fixture role with system scope plus DML (the development `helix` login, or
`ai_worker` after provisioning):

- catalog check: every protected table has RLS, `FORCE`, and a
  `tenant_isolation` policy; the runtime role is not superuser/BYPASSRLS;
- two tenants seeded across every protected table; tenant B sees zero rows in
  all of them and tenant A sees its own;
- direct cross-tenant update/delete affect zero rows; cross-tenant insert and
  tenant-moving update raise SQLSTATE `42501`;
- missing context returns zero rows; invalid context fails; a failed transaction
  does not leak context; 30 alternating tenant queries do not leak through the
  pool;
- event consumer and indexer establish system discovery then per-tenant
  processing; reconciler and agent worker wrappers use the same scopes;
- request dependency establishes and tears down the tenant scope.

`tests/test_db_roles.py` connects as each real role (never the owner) and
checks role attributes and ownership, API system-scope refusal, missing-context
fail-closed reads, own-tenant writes, cross-tenant read/update blocking, worker
system discovery, backup read plus `backup_runs` write, restore `CREATEDB`
without `BYPASSRLS`, and migration access to the owner only via `SET ROLE`.
`scripts/verify-db-roles.sh` runs that suite with `AI_TEST_ROLE_DB=1` and five
role DSNs. The suite is skipped until the roles are provisioned.

`tests/test_backup_restore.py` asserts the backup tool adds the system option
and `--enable-row-security`; its suite passes. A real backup and isolated
restore drill under RLS passed all 21 checks (tenant counts, cross-tenant
references, API readiness and four workers). That drill ran before the role
split was provisioned, so it is evidence for the RLS backstop, not yet for the
new role separation. Existing PostgreSQL integration tests run as the system
role because they are repository-level fixtures; the dedicated RLS and role
tests are the isolation evidence.

Limitations:

- The role artifacts are reviewed but not provisioned or exercised in this
  environment because the local login has no `SUPERUSER`/`CREATEROLE`. Role
  integration tests are skipped until an operator completes provisioning.
- No production-sized dataset or live cluster was available; plans are
  development-scale.
- Superuser/BYPASSRLS roles bypass RLS by design and must be controlled
  operationally.
- Database-level isolation does not replace API authorization, ACL checks,
  object-key validation, or SQL-injection prevention.

## Troubleshooting

| Symptom | Check |
|---|---|
| Reads suddenly return zero rows | Is `tenant_scope`/`system_scope` active? Is `ai_rls_context_missing_total` increasing? |
| Writes fail with `new row violates row-level security policy` | Insert/update tenant does not match the context; check the service's `require_tenant` and the row's parent tenant. |
| Startup fails with `database row-level security is not enforced` | Migration 0018 is missing, a new table was added without a policy, or `FORCE` was removed. Apply/fix the migration; do not disable verification. |
| Worker processes nothing | Queue discovery needs `system_scope`; verify the worker release matches migration 0018. |
| Backup is empty or restore fails | Confirm the backup image includes the `PGOPTIONS` change and runs as a role allowed to set `ai.system_access`; `ai_backup` must be a member of `ai_system_access`. |
| `permission denied for function ai.current_tenant_id` | Re-apply migration 0018 and check schema/function grants. |
| Startup says `database role is not permitted` | Check `AI_DB_ROLE_PROFILE`/`AI_DB_EXPECTED_ROLE`, the secret's role user, and role attributes. Run `scripts/verify-db-roles.sh`. |
| `permission denied for schema ai` | Rerun `provision_roles.sql` after the latest migration; grants are explicit and must be refreshed. |
| Migration 0019 raises `missing required database role(s)` | Provision the roles first; the migration intentionally fails closed. |

## Residual risks

- **OPEN until provisioned and verified**: the database still uses a shared
  table-owner role locally. The role SQL, migration 0019, runtime assertions,
  deployment wiring, tests and runbook are prepared; an operator must run them
  in an environment with a superuser and record the role-test result.
- API tenant identity remains a transaction-local GUC. Role separation prevents
  the API from using system scope, but arbitrary SQL under `ai_api` can still
  set another tenant id; injection prevention and API authorization remain
  required.
- Superuser/BYPASSRLS bypass is not detectable from application code.
- The migration assumes existing relationships are trustworthy; it fails on
  detected mismatches but does not attempt ownership inference for ambiguous
  legacy rows.
