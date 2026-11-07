# Stages 1-6 readiness evidence — 2026-10-26

Evidence window: 2026-10-26T09:36Z to 2026-10-26T12:15Z
Repository: `ai-platform` on top of commit `296ea36` plus uncommitted remediation work
Scope: Stage 1-6 operational readiness, SEC-19 database roles, SEC-20 encrypted
backup/restore, enterprise Node regression coverage, and related security controls.

No commit or push was made. Stage 7 was not started. The pre-existing processes on
`:3001` and `:8000` were not stopped or modified.

Status vocabulary used below: **VERIFIED**, **PARTIALLY VERIFIED**, **OPEN**,
**BLOCKED**, **NOT RUN**.

## 1. Baseline

| Gate or finding | Existing evidence | Remaining gap | Required action | Required evidence | Operator required |
|---|---|---|---|---|---|
| SEC-19 role separation | Provisioning SQL, migration 0019, runtime role checks, per-role tests, deployment wiring | Roles absent; 0019 not applied; tests skip; development uses owner `helix` | Provision roles, apply 0019, restart workloads, run role verification | Role attributes, 14/14 role tests, cross-tenant denial, readiness 200/503 | Yes |
| System-access role gate | 0019 requires GUC plus `ai_system_access` membership; `ai_api` is excluded in provisioning SQL | 0018 is the live function; it honors the GUC alone; 0019 is not applied | Apply 0019 after provisioning and retest | `ai.system_access()` false for `ai_api` with GUC on; true for worker/backup | Yes |
| Tenant isolation | 43 tables have forced RLS; targeted RLS/tenant tests pass; unscoped reads return 0 | Actual workload roles are not provisioned or tested | Run role suite as each real role | Cross-tenant read/write denial and fail-closed missing context | Yes |
| Backup encryption | New encrypted artifact `20261026T103104Z-3e8513`; AES256 payloads; 21/21 drill checks | Local host only; key escrow and off-site copy absent | Production drill with `ai_backup`/`ai_restore`, KMS/escrow, off-site copy | Encrypted production artifact and independent recovery evidence | Yes |
| Restore isolation and validation | New drill `20261026T103451Z-6ae044`: 51.707s, API/workers ready, 43 RLS tables restored | Same PostgreSQL server; restore used owner credentials; no production-scale data | Repeat with restore role and separate physical target | Operator-attested restore report | Yes |
| Cleanup and retention | Guarded cleanup dry-run for five drill targets; no deletion executed | No approved deletion; no retention deletion test | Approve cleanup and execute per target | Signed cleanup log; retained-artifact listing | Yes |
| Enterprise Node suite | 156 files, 1,932 passed, 0 failed, five serial batches | Suite is not in CI | Add sharded CI job with aggregate gate | CI run covering all 156 files | No for local; Yes for CI ownership |
| Local runtime | API and four workers previously exercised; current API readiness and metrics rechecked | No live Kubernetes rollout | Roll out and observe a full cycle | Cluster rollout and probe evidence | Yes |
| Kubernetes manifests | 32 documents in 20 files pass structural validation | No kustomize, kubeconform, or live cluster available | Render and schema-validate in CI; roll out | Rendered manifests and rollout status | Yes |
| Alerting | Prometheus rules exist | No Alertmanager or receiver | Wire and test notification | Test alert delivery | Yes |
| Worker HA | Single-replica topology documented | No reconciler lease; event/index selection not an atomic claim | Add coordination before scaling | Concurrency and failover tests | Engineering |
| Security controls | Targeted 253 passed, 15 skipped; full Python 470 passed, 42 skipped | Role-specific controls remain blocked | Rerun after SEC-19 | Test logs and operator attestation | Partly |

## 2. SEC-19 database role separation

### 2.1 Code inspection

- `infrastructure/db/roles/provision_roles.sql`
  - Creates `ai_owner` and `ai_system_access` as NOLOGIN roles and `ai_api`,
    `ai_worker`, `ai_backup`, `ai_restore`, `ai_migrate` as LOGIN roles.
  - Sets every role `NOSUPERUSER`, `NOCREATEROLE`, `NOBYPASSRLS`, `NOINHERIT`;
    only `ai_restore` receives `CREATEDB`.
  - Grants `ai_system_access` to `ai_owner`, `ai_migrate`, `ai_worker`,
    `ai_backup`, `ai_restore`; explicitly revokes it from `ai_api`.
  - Grants `ai_owner` only to `ai_migrate`; explicitly revokes it from the other
    runtime roles.
  - Transfers ownership of `ai` tables, sequences, views, routines and enum/domain
    types to `ai_owner`; revokes PUBLIC access and grants narrow DML/SELECT paths.
  - Requires `is_superuser=on`; it cannot be run by an application or migration
    role.
- `migrations/0019_system_access_role_gate.sql`
  - Fails if any required role is missing.
  - Requires `ai_owner` to be an `ai_system_access` member and `ai_api` not to be.
  - Replaces `ai.system_access()` so it returns true only when the transaction GUC
    is on **and** `pg_has_role(current_user, 'ai_system_access', 'MEMBER')`.
- `apps/ai-api/src/ai_api/infrastructure/db/database.py`
  - Rejects superuser, `BYPASSRLS`, table ownership, and wrong `createdb`/
    `createrole` attributes for API/worker profiles.
  - Rejects `ai_api` if it is a system member; requires system membership for
    worker/backup/migrate profiles.
  - Verifies RLS is enabled, forced, and has `tenant_isolation` on every table
    except `schema_migrations` and `backup_runs`.
- `scripts/backup_restore.py`
  - Rejects `createdb` for API/worker/backup/migrate, rejects `createrole` for all
    non-restore profiles, rejects source table ownership except for the isolated
    restore target, and requires system membership for non-API profiles.

### 2.2 Current database state

- `helix` is the development login and table owner:
  `rolsuper=f`, `rolcreatedb=t`, `rolcreaterole=f`, `rolbypassrls=f`.
- `helix` owns 45 tables in `ai`; 43 have `ENABLE` and `FORCE ROW LEVEL SECURITY`;
  `schema_migrations` and `backup_runs` are intentionally global.
- Migration history: latest applied is `0018_tenant_row_level_security.sql`,
  applied at `2026-10-26 03:49:24Z`. `0019` is absent.
- None of `ai_owner`, `ai_system_access`, `ai_api`, `ai_worker`, `ai_backup`,
  `ai_restore`, or `ai_migrate` exists.
- Because 0018 is live and 0019 is not, `ai.system_access()` still trusts the GUC
  alone. Running `select set_config('ai.system_access','on',true); select
  ai.system_access();` as `helix` returns `t`. This is exactly the boundary 0019
  is designed to close.

### 2.3 Executed checks

| Check | Command | Result |
|---|---|---|
| Provisioning blocked | `PGPASSWORD=helix psql ... -f infrastructure/db/roles/provision_roles.sql` | Exit 3: `role provisioning requires a superuser; the application/migration roles cannot run it` |
| Migration fails closed | `PGPASSWORD=helix psql ... -f migrations/0019_system_access_role_gate.sql` | Exit 3: missing `ai_api, ai_backup, ai_migrate, ai_owner, ai_restore, ai_system_access, ai_worker` |
| Verification refuses to run | `./scripts/verify-db-roles.sh` | Exit 2: missing `AI_ROLE_*_DSN` for five roles |
| Role suite skips | `PYTHONPATH=src python3 -m pytest -o addopts='' -q -rs tests/test_db_roles.py` | 14 skipped; all require `AI_TEST_ROLE_DB=1` and per-role DSNs |
| Wrong role readiness | `AI_DB_ROLE_PROFILE=api AI_DB_EXPECTED_ROLE=helix` on loopback port 18001 | `/healthz` 200; `/readyz` 503; log reason `owns_ai_tables,createdb` |
| Current development readiness | API on loopback port 18002 with unset role profile | `/readyz` 200; anonymous metrics 401; bearer metrics 200 |
| Pre-0019 gate behavior | SQL as `helix` with GUC on | `ai.system_access()` returns true |

The wrong-role test proves liveness stays up while readiness fails closed. It does
not prove the least-privilege roles work, because those roles do not exist.

### 2.4 Assessment

SEC-19 remains **BLOCKED**. The SQL and runtime controls are coherent, but the
database has not been provisioned and 0019 is not applied. No test ran as
`ai_api`, `ai_worker`, `ai_backup`, `ai_restore`, or `ai_migrate`. Allowing a
non-superuser workaround or changing the policy to make tests pass would invalidate
the control.

A residual remains even after 0019: the API runtime role can still set
`ai.tenant_id` to another tenant if an SQL injection gives it arbitrary SQL. The
migration comment and `docs/tenant-isolation.md` already document this. RLS blocks
system-wide reads, but application authorization remains the primary tenant
control.

### 2.5 DBA/operator runbook

Preconditions:

- Written change approval and a maintenance window.
- PostgreSQL superuser credentials (or an equivalent role that can create roles
  and transfer ownership).
- A current database backup and a tested rollback point.
- API, four workers, backup jobs and migration jobs stopped; no pooled connections
  holding the legacy owner session.
- Five unique passwords available from the secret manager. Do not put passwords on
  command lines or in shell history.

Procedure:

1. Confirm the database is at 0018 and record role/table state:

```bash
psql -h "$POSTGRES_HOST" -U "$PGSUPERUSER" -d "$POSTGRES_DB" -Atc \
  "select version from ai.schema_migrations order by version desc limit 1;"
```

Expected: `0018_tenant_row_level_security.sql`.

2. Run provisioning as a superuser in one transaction:

```bash
psql --single-transaction -v ON_ERROR_STOP=1 \
  -h "$POSTGRES_HOST" -U "$PGSUPERUSER" -d "$POSTGRES_DB" \
  -f infrastructure/db/roles/provision_roles.sql
```

Expected: success, no password output, roles created, `ai` ownership transferred to
`ai_owner`.

3. Set unique passwords through the secret manager or `psql \password`. Never use
   a command-line literal or commit a password file.

4. Apply 0019 through the migration role:

```bash
AI_DB_ROLE_PROFILE=migrate \
AI_MIGRATION_DB_USER=ai_migrate \
AI_MIGRATION_DB_PASSWORD='<from secret manager>' \
AI_MIGRATION_ROLE=ai_owner \
bash scripts/migrate.sh
```

Expected: `apply 0019_system_access_role_gate.sql`; `migrations applied: 1`;
`schema_migrations` has 19 rows. The script uses `SET ROLE ai_owner` and
transaction-local system scope, not a superuser connection.

5. Restart API and workers with the existing manifest settings:
   `POSTGRES_USER=ai_api` / `AI_DB_ROLE_PROFILE=api` / `AI_DB_EXPECTED_ROLE=ai_api`;
   workers use `ai_worker`/`worker`/`ai_worker`. The backup CronJob already uses
   `ai_backup`/`backup`/`ai_backup`.

6. Verify the roles:

```bash
AI_TEST_ROLE_DB=1 \
AI_ROLE_API_DSN='postgresql://ai_api:<secret>@<host>/<db>' \
AI_ROLE_WORKER_DSN='postgresql://ai_worker:<secret>@<host>/<db>' \
AI_ROLE_BACKUP_DSN='postgresql://ai_backup:<secret>@<host>/<db>' \
AI_ROLE_RESTORE_DSN='postgresql://ai_restore:<secret>@<host>/<db>' \
AI_ROLE_MIGRATE_DSN='postgresql://ai_migrate:<secret>@<host>/<db>' \
bash scripts/verify-db-roles.sh
```

Expected: 14 passed. The suite checks attributes, table ownership, API system-scope
denial, API own-tenant write, missing-context fail-closed, cross-tenant read/write
denial, worker system scope, backup read plus run metadata, restore `CREATEDB`
without `BYPASSRLS`, and migration `SET ROLE ai_owner`.

7. Verify readiness:
   - Correct API role: `/readyz` 200, `/healthz` 200.
   - Intentional mismatch (for example, expect `ai_owner` while connected as
     `ai_api`): `/healthz` 200, `/readyz` 503 with `database: unavailable`.

8. Capture sanitized evidence: role attribute query, policy counts per schema
   (expected 43 forced tables), both readiness responses, role test output, and
   migration history. Do not capture DSNs or passwords.

Rollback:

- Stop workloads that use the new roles.
- Do not grant `ai_owner` back to API/worker and do not reassign tables to a runtime
  role.
- Keep the roles and ownership while diagnosing.
- If the gate must be reverted, use a security-reviewed forward migration; do not
  restore the GUC-only function.
- Rotate credentials and remove logins only after the application is stopped.

## 3. SEC-20 encrypted backup and restore

### 3.1 What is encrypted

| Item | Encrypted? | Evidence |
|---|---|---|
| PostgreSQL payload | Yes | `postgres.dump.gpg`, 74,490 bytes, AES256 GPG symmetric packet |
| Object archive | Yes | `objects.tar.gz.gpg`, 1,198 bytes, encrypted by the same code path |
| Artifact manifest | No | `manifest.json` is plaintext and intentionally contains counts, checksums, migration versions and encryption metadata; it does not contain the dump, object keys, document content, passwords or passphrases |
| Drill report | No | `drill-*.json` is plaintext and contains check names/statuses, target database/bucket names, artifact checksum and elapsed time; it does not contain credentials or document content |
| Temporary decrypted dump/archive | Transient | `_decrypt_to_temp` creates mode 0600 files and `finally` unlinks them; no `ai-backup-*` or `ai-restore-objects-*` files remained |
| GPG passphrase | No | Held in a mode 0600 local file for this drill; production must use the secret manager |

The actual encrypted payload was confirmed with `gpg --list-packets`:
`symkey enc packet: version 4, cipher 9` (AES256), followed by an encrypted data
packet. Decrypting the new dump and inspecting pre-data DDL showed 43
`FORCE ROW LEVEL SECURITY` statements.

### 3.2 New encrypted backup and drill

| Field | Value |
|---|---|
| Backup run | `20261026T103104Z-3e8513` |
| Artifact | `/tmp/sec20-backups/artifacts/20261026T103104Z-3e8513` |
| Encryption | `enabled: true`, `cipher: AES256` |
| Manifest checksum | `c3e675367a26ce7f69e27d9ca1eadfa1ed8a4b1ddc47023ffe00cb3e77ec6623` |
| Size | 75,688 bytes |
| Drill | `20261026T103451Z-6ae044` |
| Drill result | success, 51.707s, 21/21 checks |
| Restore target | `ai_restore_drill_20261026_103451` (same PostgreSQL server, isolated database) |
| Object target | `ai-knowledge-restore-drill-20261026103451` (isolated bucket) |
| Restored RLS | 43 forced tables, 43 `tenant_isolation` policies |
| Restored data | 3 documents and 124 events with system scope; 0 rows visible unscoped |
| API | `/readyz` and `/healthz` pass in drill |
| Workers | event consumer, indexer, reconciler, agent each pass one-shot |

Commands:

```bash
BACKUP_DIR=/tmp/sec20-backups \
BACKUP_REQUIRE_ENCRYPTION=true \
BACKUP_ENCRYPTION_PASSPHRASE_FILE=/tmp/sec20-backups/passphrase \
BACKUP_RETENTION_DAYS=365 \
BACKUP_RETENTION_MIN_COUNT=100 \
PYTHONPATH=apps/ai-api/src \
python3 scripts/backup_restore.py backup
```

```bash
BACKUP_DIR=/tmp/sec20-backups \
BACKUP_REQUIRE_ENCRYPTION=true \
BACKUP_ENCRYPTION_PASSPHRASE_FILE=/tmp/sec20-backups/passphrase \
BACKUP_RETENTION_DAYS=365 \
BACKUP_RETENTION_MIN_COUNT=100 \
PYTHONPATH=apps/ai-api/src \
python3 scripts/backup_restore.py drill \
  --artifact 20261026T103104Z-3e8513 \
  --start-app \
  --run-workers
```

The backup used one exported repeatable-read snapshot for metadata and `pg_dump`.
`ai.backup_runs` records the backup and drill as `encrypted=t`, `integrity_ok=t`.

### 3.3 Stale encrypted artifact finding

`20261025T080235Z-b5abbe` is encrypted but predates RLS. Migration 0018 was applied
on `2026-10-26 03:49:24Z`; that artifact was created on 2026-10-25. Restoring it now
produces a database with zero forced-RLS tables, and the drill fails API readiness
with `database row-level security is not enforced`. The failure is correct
fail-closed behavior and is not a defect in the current dump path. The current
artifact contains 43 forced-RLS statements and passes.

Consequence: the old `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json` is
historical evidence only. It must not be used to claim current schema/RLS recovery.
The new report is `docs/audit/evidence/SEC-20_encrypted_restore_drill_2026-10-26.json`.

### 3.4 Operator error during the fail-closed check

An attempted environment check used shell variable assignments in the wrong scope,
so the Python process inherited the default `BACKUP_REQUIRE_ENCRYPTION=false` and
created an unencrypted artifact:

- Run: `20261026T113945Z-3dd431`
- Path: `/backup/artifacts/20261026T113945Z-3dd431`
- Size: 236,561 bytes
- Files: `postgres.dump`, `objects.tar.gz`
- Manifest: `encryption: {cipher: none, enabled: false}`

This artifact was not deleted. It must be removed under the approved cleanup policy.
It does not change the fact that the current encrypted path works, but it confirms
that the default is unsafe for production and the environment must set
`BACKUP_REQUIRE_ENCRYPTION=true` and a passphrase.

The corrected fail-closed check used `env -u` and exited 1 before creating an
artifact:

```bash
env -u BACKUP_ENCRYPTION_PASSPHRASE -u BACKUP_ENCRYPTION_PASSPHRASE_FILE \
  BACKUP_DIR=/tmp/sec20-require-test \
  BACKUP_REQUIRE_ENCRYPTION=true \
  python3 scripts/backup_restore.py backup
```

Result: `encryption_required`; exit 1.

### 3.5 Cleanup dry-run

The guarded cleanup command was run without `--execute` for every target. No
database, object or bucket was deleted.

| Target database | Target bucket |
|---|---|
| `ai_restore_drill_20261025_072800` | `ai-knowledge-restore-drill-20261025072800` |
| `ai_restore_drill_20261025_080325` | `ai-knowledge-restore-drill-20261025080325` |
| `ai_restore_drill_20261026_043531` | `ai-knowledge-restore-drill-20261026043531` |
| `ai_restore_drill_20261026_102324` | `ai-knowledge-restore-drill-20261026102324` |
| `ai_restore_drill_20261026_103451` | `ai-knowledge-restore-drill-20261026103451` |

Consequences if approved: `DROP DATABASE` removes the isolated restored database and
all its data; bucket cleanup deletes every object in that drill bucket and then
deletes the bucket. Source databases, source buckets and the unencrypted artifact
are separate targets.

Retention: `_apply_retention` deletes artifacts older than the configured days only
after keeping `BACKUP_RETENTION_MIN_COUNT`. It was not executed as a destructive
test. The local backup run reported `retention_deleted: []`.

### 3.6 Limitations

- No live-cluster restore; target was an isolated database on the same PostgreSQL
  server.
- Restore used the development owner login, not `ai_restore`.
- No off-site replication, object lock or immutable retention.
- No confirmed production key-management or escrow arrangement; the passphrase was
  a local 0600 file.
- No production-scale data or measured RTO; 51.707s is a small development drill.
- No live backup CronJob execution and no alert-receiver delivery.
- The `/backup` PVC is not off-site and is not immutable.

Status: local encrypted backup/restore **VERIFIED**; production recoverability
**OPEN**; cleanup **PARTIALLY VERIFIED**; retention deletion **NOT RUN**.

## 4. Enterprise Node regression coverage

Commands were run from `/workspace` with serial file ranges. The test harness uses a
fixed clone-slot pool, so batches were run one at a time; no overlapping batches
were used.

```bash
files=(server/tests/*.test.js)
node --test --test-concurrency=1 --test-reporter=spec \
  "${files[@]:START:COUNT}" > /tmp/node-batch.log 2>&1
```

| Batch | File range | Files | Passed | Failed | Skipped | Exit | Duration |
|---|---|---|---|---|---|---|---|
| 1 | 0-39 | 40 | 641 | 0 | 0 | 0 | 2,528.202s |
| 2a | 40-68 | 29 | 345 | 0 | 0 | 0 | 1,191.517s |
| 2b | 69-97 | 29 | 397 | 0 | 0 | 0 | 2,161.550s |
| 3 | 98-126 | 29 | 220 | 0 | 0 | 0 | 905.746s |
| 4 | 127-155 | 29 | 329 | 0 | 0 | 0 | 1,496.292s |
| Total | 0-155 | 156 | 1,932 | 0 | 0 | 0 each | 8,283.307s |

Coverage check: concatenating the five ranges produced 156 files and 156 unique
files; a sorted diff against `server/tests/*.test.js` was empty. The aggregate is
not inflated by overlap. Session-token hashing and legacy authorization tests were
included in batch 4 and passed.

Historical context: the earlier Batch B run reported 1,932 passed, 0 failed across
333 suites using five serial ranges A1-A2-B-C-D (A1 580, A2 406, B 382, C 176,
D 388). The exact file boundaries of that run were not preserved in the audit. The
current run re-establishes full coverage with a reproducible range scheme.

CI status: `.github/workflows/ai-platform-ci.yml` has jobs for the AI Python API,
the web console, web-ai, manifests, images, monitoring configs and dependency scans,
but no job runs the 156-file enterprise Node suite. The suite is currently manual
evidence, not a CI gate.

Status: **VERIFIED** locally; CI enforcement **OPEN**.

## 5. Related security control revalidation

Targeted Python command:

```bash
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -o addopts='' -q -rs \
  tests/test_rls_tenant_isolation.py tests/test_security_reconciliation.py \
  tests/test_db_roles.py tests/test_document_listing_security.py \
  tests/test_object_key_security.py tests/test_access_control.py \
  tests/test_permissions.py tests/test_ingestion.py tests/test_source_security.py \
  tests/test_search_lifecycle_security.py tests/test_search_duplicates.py \
  tests/test_agent_executions.py tests/test_agent_registry.py \
  tests/test_reliability.py tests/test_agents.py tests/test_governance.py \
  tests/test_prompt_injection_security.py tests/test_prompt_safety.py \
  tests/test_citation_validation.py tests/test_observability.py \
  tests/test_production_config.py tests/test_request_body_limits.py \
  tests/test_backup_restore.py
```

Result: **253 passed, 15 skipped in 107.67s**, exit 0. The 15 skips are 14
`test_db_roles.py` cases (no per-role DSNs) and one `test_backup_restore.py` real
backup case (`AI_TEST_BACKUP=1` not set); the real backup was exercised separately
in Section 3.

| Control | Evidence |
|---|---|
| RLS and tenant context | `test_rls_tenant_isolation.py` passed: forced RLS catalog, normal-role behavior, all protected tables, cross-tenant read/write denial, invalid context, transaction-local context, worker system/tenant transitions |
| System-access role gate | Code inspection plus 0019 fail-closed execution; actual-role tests skipped/blocked |
| Object authorization and downloads | `test_document_listing_security.py`, `test_object_key_security.py`, `test_access_control.py`, `test_permissions.py` passed |
| Ingestion ACL and classification | `test_ingestion.py`, `test_source_security.py` passed, including ACL/classification propagation and live ACL changes |
| Search cleanup after deletion or permission change | `test_search_lifecycle_security.py`, `test_search_duplicates.py` passed, including delete propagation, retry and orphan reconciliation |
| Agent lease fencing and approval replay | `test_agent_executions.py`, `test_agent_registry.py` passed: lease expiry/reclaim, stale worker commit denial, approval single-use, hash mismatch, restart behavior |
| Runtime tool permissions and JSON schema | `test_agents.py`, `test_agent_executions.py`, `test_governance.py` passed: disabled tools, input/output schema, capability risk, budgets |
| Prompt-injection screening | `test_prompt_injection_security.py`, `test_prompt_safety.py` passed: default block, RAG/agent poisoning abstention, audit-only development mode |
| Citation validation | `test_citation_validation.py` passed: missing/invalid citations, duplicates, status downgrade and audit exposure |
| Session-token hashing | `server/tests/session-token-hashing.test.js` passed in Node batch 4 |
| Metrics and docs gating | `test_observability.py`, `test_production_config.py` passed; live API anonymous metrics 401, bearer 200; production docs disabled tests passed |
| Request-size limits | `test_request_body_limits.py` passed: Content-Length and streamed-body limits, transport cap alignment |
| Backup/restore controls | `test_backup_restore.py` passed except the opt-in real-backup case; separate encrypted drill passed 21/21 |

Full Python suite:

```bash
cd apps/ai-api
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -o addopts='' -q --tb=short
```

Result: **470 passed, 42 skipped in 215.39s**, exit 0.

Configuration and static checks:

| Check | Result |
|---|---|
| `python3 -m ruff check apps/ai-api/src apps/ai-api/tests scripts` | All checks passed |
| `python3 scripts/validate-k8s.py` | 32 documents in 20 files, OK |
| `docker compose --env-file .env -f compose.yaml config -q` | Exit 0 |
| `bash -n scripts/verify-db-roles.sh scripts/migrate.sh` | Exit 0 |
| `npm run test:web -- --run` | 30 passed in 6 files |
| `git diff --check` | Clean |

Not available in this environment: a live Kubernetes cluster, `kustomize`,
`kubeconform`, `actionlint`, and `promtool`. Their checks are **NOT RUN** here and
remain in CI.

## 6. Operator actions still required

1. **SEC-19 maintenance window**: run the runbook in Section 2.5, apply 0019,
   restart workloads, and capture 14/14 role tests plus correctness/incorrectness
   readiness. Do not mark SEC-19 fixed before this.
2. **Kubernetes rollout**: deploy API, workers, migration Job and backup CronJob;
   observe one event, reconcile, index and agent cycle; capture probes and metrics.
3. **SEC-20 production drill**: run backup and restore with `ai_backup`/`ai_restore`,
   `BACKUP_REQUIRE_ENCRYPTION=true`, a secret-manager passphrase, and an isolated
   target. Record measured RTO and sanitized evidence.
4. **Backup off-site and key custody**: copy encrypted artifacts off-cluster, verify
   key escrow, add object lock/immutability, and document retention approval.
5. **Cleanup**: approve and execute the five drill database/bucket targets and
   remove the accidental unencrypted artifact `20261026T113945Z-3dd431` under the
   approved deletion policy.
6. **Alerting**: wire Alertmanager/receiver and send a test notification.
7. **HA**: add a reconciler lease and an atomic event/index claim before scaling
   those workers beyond one replica.
8. **CI**: add a sharded enterprise Node job that covers all 156 files and fails on
   any aggregate failure.
9. **Deployment drift**: restart the stale `:8000` process from current code with
   metrics authentication and a role profile. Do not modify it in this task.

## 7. Final readiness decision

**NO-GO for Stage 7 and production.**

Genuinely closed or verified in this evidence window:

- Enterprise Node regression coverage is complete: 156/156 files, 1,932 passed,
  0 failed.
- SEC-20 encrypted backup/restore is verified locally: AES256 payloads, current
  RLS-bearing artifact, 21/21 drill checks, API and four workers healthy, tenant
  boundary checks passing.
- Listed security controls passed their targeted suites, including RLS under the
  development owner, object authorization, ingestion ACL, search cleanup, agent
  approval/lease controls, prompt-injection screening, citation validation,
  session-token hashing, metrics, request limits and backup controls.
- Current API readiness and metrics behavior were rechecked.

Still open or blocked:

- SEC-19 is **BLOCKED**: no superuser/CREATEROLE, roles absent, 0019 not applied,
  and no actual-role tests.
- SEC-20 production recoverability is **OPEN**: local same-host restore, no off-site
  copy, no key escrow, no production RTO, no live CronJob/alert receiver.
- No live Kubernetes rollout; manifests are structurally validated only.
- No alert delivery.
- Worker HA coordination is incomplete for multiple replicas.
- The enterprise Node suite is not enforced in CI.
- The stale `:8000` process and the accidental unencrypted backup artifact remain.

SEC-19 is the primary production blocker. SEC-20 is credible at development scale
but not production-verified. Revisit the GO/NO-GO only after the operator actions
above are completed and their evidence is recorded.

## 8. Evidence paths

- `docs/audit/evidence/STAGES_1-6_EVIDENCE_2026-10-26.md` (this report)
- `docs/audit/evidence/SEC-20_encrypted_restore_drill_2026-10-26.json`
- `docs/audit/evidence/SEC-20_encrypted_backup_manifest_2026-10-26.json`
- `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json` (historical; pre-RLS)
- `docs/audit/STAGES_1-6_OPERATIONAL_READINESS_2026-10-26.md` (updated decision)
- `/tmp/sec19-*.out`, `/tmp/sec20-*.out`, `/tmp/node-*.log`,
  `/tmp/sec-targeted-python-rs.log`, `/tmp/sec-full-python.log` (session logs)
