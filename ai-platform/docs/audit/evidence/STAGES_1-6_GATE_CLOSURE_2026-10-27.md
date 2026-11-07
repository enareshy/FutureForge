# Stages 1-6 gate-closure pass — 2026-10-27

Independent release-readiness review of the enterprise AI platform. This pass
re-verified the reported evidence, rechecked the live development database and
processes, added the missing enterprise Node CI gate, produced a cleanup
manifest, and wrote the executable live-cluster/alerting runbook
(`docs/kubernetes-rollout.md`). It did not commit, push, tag, release, start
Stage 7, delete any resource, or touch the `:3001`/`:8000` processes.

Preparation addendum 2026-10-28Z: a follow-up pass found and fixed one latent
alerting defect (Alertmanager had no ingress allow rule under `default-deny`;
see Section 7.2.1), enabled and mutation-tested the previously skipped live
backup test, and re-baselined the manifest counts to 50 documents / monitoring
11 resources. All current results in this document are as of that addendum; no
gate status changed.

## 1. Repository and environment state

| Item | Observed value |
|---|---|
| Repository root | `/workspace` (the `ai-platform/` subtree is not a separate repository) |
| Branch | `postgres` |
| HEAD | `296ea36` (`fix(ai-platform): stop SeaweedFS volume preallocation in local compose`) |
| Working tree | dirty: 192 entries, 85 untracked; no commit made by this pass |
| Assessment window | 2026-10-27T03:27Z to 2026-10-27T05:07Z |
| PostgreSQL | 15.19 on 127.0.0.1:5432, database `helix`, schema `ai` |
| Latest migration | `0018_tenant_row_level_security.sql`; `0019` absent |
| RLS | 43 of 45 `ai` tables have ENABLE + FORCE row level security |
| Cluster tooling | no `kubectl`, `actionlint`; `kustomize`, `kubeconform`, `promtool`, `amtool` fetched into `/tmp/opencode` for this pass |
| Pre-existing processes | `:3001` pid 5865, `:8000` pid 23284 — left untouched |

Documents inspected: `docs/audit/STAGES_1-6_OPERATIONAL_READINESS_2026-10-26.md`,
`docs/audit/evidence/STAGES_1-6_EVIDENCE_2026-10-26.md`,
`docs/audit/STAGES_1-6_REAUDIT_2026-10-23.md`,
`docs/audit/STAGES_1-6_AUDIT_2026-10-22.md`, `docs/testing.md`,
`docs/PHASE13_TESTING.md`, `docs/tenant-isolation.md`,
`docs/backup-recovery.md`, `docs/WORKER_DEPLOYMENT.md`,
`docs/observability.md`, the SEC-19 and SEC-20 evidence JSON, provisioning SQL,
migration 0019, role tests, backup tooling, Compose, Kubernetes base/overlay,
monitoring rules, and the CI workflow.

## 2. Status summary

| Control | Status | Basis |
|---|---|---|
| SEC-01..SEC-18 code fixes | **VERIFIED** | Current code inspected; targeted suite 253 passed / 15 skipped on 2026-10-26; 32 focused tests re-run 2026-10-27 |
| SEC-19 RLS backstop | **VERIFIED** | 43/43 protected tables FORCE RLS; cross-tenant tests pass under owner |
| SEC-19 role separation | **BLOCKED** | Roles absent; 0019 not applied; provisioning requires superuser |
| SEC-20 encrypted path | **PARTIALLY VERIFIED** | Local same-host AES256 backup + restore drill 21/21; production recoverability **OPEN** |
| SEC-20 cleanup | **PARTIALLY VERIFIED** | Dry-run only for 5 targets; nothing deleted |
| Enterprise Node suite | **VERIFIED** locally (1,932/0) | Five serial batches, 156/156 files, 2026-10-26 |
| Enterprise Node CI gate | **PARTIALLY VERIFIED** | Workflow added and validated locally on one shard; not executed in GitHub Actions |
| Kubernetes rollout | **NOT RUN** | Static validation only (48 docs / 31 files) plus successful render/schema check |
| Kubernetes alerting structure | **PARTIALLY VERIFIED (static)** | Worker Services, in-cluster Prometheus/Alertmanager manifests, scheduled drill; `promtool`/`amtool` valid |
| Alert delivery | **OPEN** | Alertmanager receiver has no integration; no live scrape/evaluation observed |
| Worker HA | **OPEN** | Single replicas; no reconciler lease or atomic event claim |
| Production recoverability | **OPEN** | No off-site copy, immutability, KMS/escrow, live-cluster restore, approved RPO/RTO |
| Stale `:8000` API | **OPEN** | Anonymous `/metrics` 200, Swagger and OpenAPI 200; binds `0.0.0.0`; predates metrics/docs auth |
| Regressions | none observed | Lint, manifests, Compose, frontend, focused Python pass |

## 3. SEC-19 — role provisioning remains BLOCKED

### 3.1 Rechecked live state (2026-10-27)

```sql
select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
from pg_roles where rolname like 'ai_%' or rolname = 'helix';
```

Result: only `helix|f|t|f|f|t`. Zero of `ai_owner`, `ai_system_access`, `ai_api`,
`ai_worker`, `ai_backup`, `ai_restore`, `ai_migrate` exist.

- `ai.schema_migrations` maximum version is `0018`.
- `helix` owns 45 `ai` tables; 43 have ENABLE + FORCE RLS.
- Pre-0019 behavior confirmed: `set_config('ai.system_access','on',true)` then
  `select ai.system_access()` returns `t` as `helix`. This is the GUC-only
  trust boundary that 0019 closes.
- Workload manifests are wired correctly (`ai_api`/`api`, `ai_worker`/`worker`,
  `ai_backup`/`backup`, `ai_migrate`/`migrate`; migration Job uses
  `SET ROLE ai_owner`); the runtime rejects an owner role with
  `owns_ai_tables,createdb` and readiness 503. Wiring is not a substitute for
  provisioning.

### 3.2 Fail-closed gates re-executed

| Check | Command | Result |
|---|---|---|
| Provisioning refused for non-superuser | `psql -U helix -f infrastructure/db/roles/provision_roles.sql` | Exit 3: `role provisioning requires a superuser` |
| 0019 refuses without roles | `psql -U helix -f migrations/0019_system_access_role_gate.sql` | Exit 3: missing all seven roles |
| Role verification refuses to run | `./scripts/verify-db-roles.sh` | Exit 2: missing five `AI_ROLE_*_DSN` values |
| Role suite | `pytest tests/test_db_roles.py` | 14 skipped (gated `AI_TEST_ROLE_DB=1`) |

Conclusion: SEC-19 role separation is **BLOCKED** in this environment. No
privileged workaround was attempted. Do not mark it fixed from SQL files,
manifest wiring, or owner-account tests.

### 3.3 DBA execution checklist

Preconditions and approvals:

1. Written change approval and a maintenance window; API, four workers, backup
   CronJob and migration Job stopped; no pooled owner sessions.
2. PostgreSQL superuser (or equivalent CREATEROLE + ownership-transfer rights).
3. Current verified backup and a tested rollback point.
4. Five unique passwords available from the secret manager; never on a command
   line or in shell history.
5. Named owners: DBA (provisioning), platform SRE (workload restart), security
   (evidence review).

Commands and expected outcomes:

```bash
# 0. Confirm prerequisite state (expect 0018 only)
psql -h "$POSTGRES_HOST" -U "$PGSUPERUSER" -d "$POSTGRES_DB" -Atc \
  "select version from ai.schema_migrations order by version desc limit 1;"

# 1. Provision roles and transfer ai ownership (one transaction)
psql --single-transaction -v ON_ERROR_STOP=1 \
  -h "$POSTGRES_HOST" -U "$PGSUPERUSER" -d "$POSTGRES_DB" \
  -f infrastructure/db/roles/provision_roles.sql

# 2. Set unique passwords out-of-band per login role (secret manager or \password)

# 3. Apply 0019 as ai_migrate with SET ROLE ai_owner
AI_DB_ROLE_PROFILE=migrate AI_MIGRATION_DB_USER=ai_migrate \
AI_MIGRATION_DB_PASSWORD='<from secret manager>' AI_MIGRATION_ROLE=ai_owner \
  bash scripts/migrate.sh

# 4. Verify roles, isolation and system-access boundary as real roles
AI_TEST_ROLE_DB=1 \
AI_ROLE_API_DSN='postgresql://ai_api:<secret>@<host>/<db>' \
AI_ROLE_WORKER_DSN='postgresql://ai_worker:<secret>@<host>/<db>' \
AI_ROLE_BACKUP_DSN='postgresql://ai_backup:<secret>@<host>/<db>' \
AI_ROLE_RESTORE_DSN='postgresql://ai_restore:<secret>@<host>/<db>' \
AI_ROLE_MIGRATE_DSN='postgresql://ai_migrate:<secret>@<host>/<db>' \
  bash scripts/verify-db-roles.sh
```

Expected: provisioning succeeds without printing passwords; `0019` applied and
19 migration rows; 14/14 role tests pass; `ai.system_access()` is false for
`ai_api` with the GUC on, true for worker/backup/restore; cross-tenant reads and
writes are denied for `ai_api`; readiness 200 with the intended role and 503 with
an intentional mismatch.

Role and membership checks that must be captured (sanitized):

- `rolsuper=f`, `rolbypassrls=f`, `rolcreaterole=f` for every role; only
  `ai_restore` has `rolcreatedb=t`.
- No runtime role owns any `ai` table.
- `ai_api` is not a member of `ai_system_access`; worker/backup/restore/migrate
  are; `ai_migrate` can `SET ROLE ai_owner`; no other runtime role can.
- 43 protected tables have ENABLE + FORCE RLS and `tenant_isolation`.
- `/healthz` 200 and `/readyz` 200 for API and all four workers with the intended
  role; `/readyz` 503 for a deliberate mismatch.

Rollback considerations:

- Stop workloads using the new roles first.
- Do not re-grant `ai_owner` to runtime roles or reassign tables to a runtime
  role to restore service.
- Keep roles/ownership while diagnosing; if the gate must be reverted, use a
  security-reviewed forward migration, never the GUC-only function.
- Rotate credentials and drop logins only after the application is stopped and
  the rollback is approved.

Evidence to retain: migration history, sanitized role attribute query, policy
counts, 14/14 role test output, both readiness responses, and the operator's
signed change record. Do not capture DSNs or passwords.

## 4. SEC-20 — encrypted path and cleanup manifest

### 4.1 Re-verification of the encrypted drill

| Check | Result |
|---|---|
| `backup_restore.py verify --artifact 20261026T103104Z-3e8513` | Exit 0; manifest, checksums, `pg_restore_list`, object archive |
| GPG packets | `symkey enc packet: cipher 9` (AES256) + encrypted data packet |
| Artifact | 75,688 bytes; `postgres.dump.gpg` 74,490 B; `objects.tar.gz.gpg` 1,198 B |
| Manifest/drill linkage | Drill `20261026T103451Z-6ae044` records the same checksum `c3e675…6623` and `encrypted=true` |
| Drill result | success, 51.707s, 21/21 checks, 0 failed |
| Restore target | `ai_restore_drill_20261026_103451` (43 FORCE RLS tables) and `ai-knowledge-restore-drill-20261026103451` (8 objects) |
| Restore elapsed | 16.211s (sub-check) |

This proves an encrypted backup-to-restore path, not merely that a backup file
was encrypted: the drill decrypted, restored PostgreSQL and objects into isolated
targets, ran integrity/tenant checks, and started the API and all four workers.

Limitations in the evidence:

- No check is explicitly named `rls`; RLS is evidenced by the artifact's 43
  `FORCE ROW LEVEL SECURITY` statements, `schema_present`, `migration_history`
  and API readiness (`_verify_rls`), not by a dedicated drill check. Adding an
  explicit forced-RLS count check would make this unambiguous.
- Restore used the development owner login, not `ai_restore` (blocked by SEC-19).
- Same PostgreSQL server, no separate physical target or live cluster.
- Development-scale data; 51.707s is not a production RTO.
- No off-site copy, object lock/immutability, KMS/escrow, live CronJob run, or
  alert delivery.
- The drill report's `data_loss.expected_window` contains `RPO target <= 24h`,
  which is a tool/config statement, not a business-approved RPO. Treat RPO and
  RTO as unapproved.

### 4.2 Cleanup manifest (nothing deleted)

Approval status: **not approved; no `--execute` run**. Dry-run log:
`/tmp/gate-sec20-cleanup-dryrun.log` (5 targets, all `executed: false`, 0 errors).

| # | Resource | Type | Size / content | Referenced by evidence | Sensitive data | Needed for recovery/investigation | Deletion impact | Prerequisite / approval |
|---|---|---|---|---|---|---|---|---|
| 1 | `ai_restore_drill_20261025_072800` | PostgreSQL DB | 12 MB; 2 docs, 115 events, 316 audit, 43 forced RLS | Readiness + evidence docs | Restored tenant data (dev) | Investigation only (superseded by `-103451`) | Drops isolated restored DB | Written cleanup approval; no active connections; DBA executes |
| 2 | `ai-knowledge-restore-drill-20261025072800` | S3 bucket | 8 objects, 1,251 B | Same | Restored objects (dev) | Investigation only | Deletes all objects then bucket | Same approval; confirm bucket name |
| 3 | `ai_restore_drill_20261025_080325` | PostgreSQL DB | 12 MB; 2 docs, 115 events, 316 audit, 43 forced RLS | 2026-10-25 drill JSON | Restored tenant data (dev) | **Preserve until the 2026-10-25 report is retired** | Drops isolated restored DB | Same approval; keep report, delete target |
| 4 | `ai-knowledge-restore-drill-20261025080325` | S3 bucket | 8 objects, 1,251 B | 2026-10-25 drill JSON | Restored objects (dev) | Same as #3 | Deletes all objects then bucket | Same |
| 5 | `ai_restore_drill_20261026_043531` | PostgreSQL DB | 12 MB; 2 docs, 115 events, 316 audit, 43 forced RLS | Readiness + evidence (unencrypted drill) | Restored tenant data (dev) | Investigation of the unencrypted path | Drops isolated restored DB | Same |
| 6 | `ai-knowledge-restore-drill-20261026043531` | S3 bucket | 8 objects, 1,251 B | Same | Restored objects (dev) | Same as #5 | Deletes all objects then bucket | Same |
| 7 | `ai_restore_drill_20261026_102324` | PostgreSQL DB | 12 MB; failed pre-RLS drill target | Readiness + evidence | Restored tenant data (dev) | Investigation of failed drill | Drops isolated DB | Same |
| 8 | `ai-knowledge-restore-drill-20261026102324` | S3 bucket | 8 objects, 1,251 B | Same | Restored objects (dev) | Same as #7 | Deletes all objects then bucket | Same |
| 9 | `ai_restore_drill_20261026_103451` | PostgreSQL DB | 12 MB; 3 docs, 124 events, 330 audit, 43 forced RLS | Current SEC-20 evidence JSON | Restored tenant data (dev) | **Preserve while it is the current drill evidence** | Drops the current drill target | Same; recreate is possible from the artifact |
| 10 | `ai-knowledge-restore-drill-20261026103451` | S3 bucket | 8 objects, 1,251 B | Current SEC-20 evidence JSON | Restored objects (dev) | Same as #9 | Deletes all objects then bucket | Same |
| 11 | `20261026T113945Z-3dd431` | Backup artifact | 236,561 B; `postgres.dump`, `objects.tar.gz`, **cipher none** | Readiness + evidence docs | Full unencrypted dev dump + objects | Investigation of the fail-closed defect | Irreversible loss of that dump; source data unaffected | Written approval; preserve manifest/checksum record first |
| 12 | `20261026T043506Z-b17e1e` | Backup artifact | 228,682 B; unencrypted | Re-audit Section Q | Full unencrypted dev dump | Investigation of unencrypted path | Irreversible loss of that dump | Written approval |
| 13 | `20261026T043531Z-7e38f8` | Backup artifact | 228,780 B; unencrypted | Not referenced by name in audit docs | Full unencrypted dev dump | Low; paired drill target is #5 | Irreversible loss of that dump | Written approval |
| 14 | `20261025T072401Z-a2072e`, `20261025T072631Z-e385a9`, `20261025T080235Z-b5abbe` | Backup artifacts | AES256, 63,456 / 63,576 / 64,132 B | `b5abbe` is the 2026-10-25 drill artifact; it predates 0018 | Encrypted dev dump | Historical evidence; `b5abbe` verifies but restores without RLS | Loses historical artifacts | Written approval; keep `b5abbe` while the 2026-10-25 report is retained |
| 15 | `20261026T103104Z-3e8513` | Backup artifact | AES256, 75,688 B | Current SEC-20 evidence | Encrypted dev dump | **Preserve** as the current verified recovery point | Loses current recovery point | Do not delete |
| 16 | Drill reports `drill-20261025T072800Z-f9099b.json`, `drill-20261025T080325Z-82f76b.json`, `drill-20261026T102324Z-5baad9.json`, `drill-20261026T103451Z-6ae044.json` | JSON reports | 4-6 KB each | Audit evidence / investigation | Metadata only; no secrets | Yes, audit trail | Loses drill audit trail | Do not delete |

Preservation rule: the current encrypted artifact `3e8513`, its drill `6ae044`,
and the copied evidence JSON under `docs/audit/evidence/` are the active
recovery/audit set. Any cleanup must keep them and must not overwrite evidence.

Safe execution (only after written approval; not run in this pass):

```bash
python3 scripts/backup_restore.py cleanup \
  --target-db <drill_db> --confirm-target <drill_db> \
  --target-bucket <drill_bucket> --confirm-bucket <drill_bucket> \
  --execute
```

The command refuses non-`ai_restore_drill_`/`ai-knowledge-restore-drill-` names,
requires matching confirmations, and needs `RESTORE_TARGET_PASSWORD` (or the
owner credential) to drop the database. Artifacts are not covered by this
command and must be removed by an approved, audited procedure that preserves the
manifest/checksum record.

## 5. Stale `:8000` process investigation (untouched)

| Attribute | Observed |
|---|---|
| PID / owner | 23284, root |
| Executable | `/usr/bin/python3.11` |
| Command | `python3 -m uvicorn ai_api.main:app --host 0.0.0.0 --port 8000` |
| Parent | 23283 `sh -c cd /workspace/ai-platform/apps/ai-api && PYTHONPATH=src python3 -m uvicorn ...` |
| Working directory | `/workspace/ai-platform/apps/ai-api` |
| Start time | Sat Oct 24 09:53:39 2026 (2 days 17h before this pass) |
| Namespace / cgroup | same mount namespace as the agent shell; `0::/` cgroup — host process, not a container |
| Listening socket | `0.0.0.0:8000` (all interfaces, not loopback), established connection to `127.0.0.1:5432` |
| Environment | no `AI_*` or `POSTGRES_*` names set in the process environment |
| Logs | `/tmp/terminal_term_1792515903880_106.log` |
| `/healthz`, `/readyz` | 200, 200 |
| `/metrics` anonymous | **200** |
| `/api/v1/ai/docs` anonymous | **200** (Swagger UI) |
| `/api/v1/ai/openapi.json` anonymous | **200** (full schema) |
| Data endpoints anonymous | `/api/v1/ai/events` 401, `POST /api/v1/ai/chat` 401 — auth is still enforced there |

Classification: this is the platform API, started manually from the working tree
before the metrics-authentication and role-gate changes. Because no
`AI_DB_ROLE_PROFILE`/`AI_DB_EXPECTED_ROLE` or `POSTGRES_USER` is set, it is
running with default/owner credentials and has no role assertion. It is not a
verification process and not unrelated, but it does not represent the current
build. Its log also shows development identity writes rejected by RLS
(`new row violates row-level security policy`), consistent with a pre-fix
process.

### 5.1 Reconciliation with the earlier metrics-authentication finding

The earlier finding said the current build returns 401 for anonymous `/metrics`
and 200 with a bearer token, and 404 for docs in production. Both statements are
still true of the code; they are not reconciled by the stale process. Proven in
this pass with an isolated app instance (`AI_ENV=production`,
`AI_METRICS_AUTH_TOKEN` set, no server started, `TestClient`):

| Request | Current code | Stale `:8000` |
|---|---|---|
| `GET /metrics` anonymous | 401 | 200 |
| `GET /metrics` with bearer | 200 | 200 |
| `GET /metrics` wrong bearer | 401 | 401 (not applicable; no token configured) |
| `GET /api/v1/ai/docs` (production) | 404 | 200 |
| `GET /api/v1/ai/openapi.json` (production) | 404 | 200 |

Conclusion: the 401/404 behaviour is real for the current build, and the 200s on
`:8000` are the older build's behaviour, not a regression. The process predates
the metrics-auth and docs-gating changes (started 2026-10-24 09:53:40; the
metrics-auth module and main.py were last modified 2026-10-24 15:30 and
2026-10-25 07:12 respectively). It is deployment drift, and the drift is wider
than metrics alone: it also re-exposes Swagger and the full OpenAPI schema, which
the production posture disables.

Exposure assessment from the anonymous payload (437 lines, 340 `ai_*` samples):

- Label names present are bounded enums only: `method`, `path` (matched route
  template), `status`, `provider`, `model`, `operation`, `outcome`, `kind`, `le`.
  No tenant id, user id, document id, prompt or content label was observed.
- `ai_rls_context_missing_total`, `ai_backup_last_run_status`,
  `ai_events_published_total` and `ai_index_jobs_total` are absent, consistent
  with a build that predates those metric families (Batches G/J/K).
- So the impact is configuration/schema disclosure plus operational telemetry,
  not tenant-data disclosure. The data endpoints still return 401.

Disposition recommendation: treat it as deployment drift requiring an owner
decision. Options, in order of preference:

1. Remove external reachability now without restarting it: restrict the bind or
   firewall to loopback/observability only, if the platform allows that change.
2. If the process must keep serving for preview, accept it explicitly in writing
   with an expiry date, and record that anonymous metrics, Swagger and OpenAPI
   are public until then.
3. Under an approved maintenance action, stop it and restart the current build
   with `AI_ENV`, `AI_METRICS_AUTH_TOKEN` and the `api` role profile, or replace
   it with the Compose/Kubernetes workload.

Until one of those is approved, do not use it for preview, shared testing, or
metrics evidence. No action was taken in this pass; the process was not
restarted, signalled or reconfigured.

Related: `:3001` pid 5865 is the Helix IAM development server (`npm run dev` →
`node scripts/dev.js` → `node server/index.js`, plus Vite on 5173). It is a
different platform component, not this AI API; it was left untouched.

## 6. Enterprise Node CI enforcement

Before this pass the workflow at `.github/workflows/ai-platform-ci.yml` had jobs
for the Python API, web console, web-ai, manifests, images, monitoring configs
and dependency scans, but no job ran the 156-file enterprise Node suite, and the
push/pull-request path filters did not include `server/**`. `package.json`
already defines `test` as
`node --test --test-concurrency=1 --test-reporter=spec server/tests/*.test.js`.

Change implemented (workflow only, 76 added lines):

- Path filters now include `server/**` for push and `package-lock.json` for PRs.
- New `enterprise-node-coverage` job asserts the 12 shards × 13 files plan equals
  the actual `server/tests/*.test.js` count (156); a mismatch fails the build.
- New `enterprise-node` matrix job (shards 0-11) runs a PostgreSQL 16 service,
  `npm ci`, and exactly 13 sorted files per shard with
  `--test-concurrency=1`, fails if a shard selects anything other than 13 files,
  uploads each shard log, disables `fail-fast` so one shard does not hide others,
  and caps each shard at 75 minutes.
- Shards are disjoint slices of the sorted file list, so aggregate counts cannot
  double-count files.

Local validation:

| Check | Result |
|---|---|
| YAML parse | 9 jobs; matrix shards 0-11; service `postgres` |
| Shard math | 12 × 13 = 156 = actual file count; 156 unique files after concatenation |
| Coverage guard script syntax | `bash -n` OK |
| Coverage guard negative test | Extracted the real guard script from the workflow and ran it against temp trees of 155, 156 and 157 files: exit 1 / 0 / 1 |
| File-count reconciliation | Sum of `test(`/`it(` declarations across the 156 files = 1,932, matching the executed total; no file has zero tests |
| Syntax check | `node --check` on all 156 test files: no failures |
| Local shard 0 execution (13 files) | 151 tests, 151 passed, 0 failed, 0 skipped, 1,181.2s, exit 0 |
| `git diff --check` | clean |

Shard balance is uneven, because shards are contiguous sorted slices rather than
weighted by test count:

| Shard | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Declared tests | 151 | 155 | 322 | 148 | 169 | 199 | 152 | 133 | 80 | 131 | 137 | 155 |

Shard 2 (`data-catalog-*` through `data-lifecycle-async`) carries 322 tests,
about twice the average. Shard 0 took 1,181.2s (19.7 min) for 151 tests. Scaling
linearly on declared test count, shard 2 projects to roughly 42 minutes (322 / 151
× 19.7). That is inside the 75-minute cap with about 44% headroom, but the
projection ignores per-file setup cost, so it is an estimate, not a measurement.
The first CI run must confirm shard 2's real duration; if it exceeds about 60
minutes, split that range rather than raising the timeout. Shard 8 (80 tests) is
the opposite extreme and wastes most of its runner time.

CI status: **implemented, PARTIALLY VERIFIED**. It has not run in GitHub Actions
(no runner in this environment), so the enforcement is not yet proven end to end.
The CI uses `postgres:16` while local validation used 15.19; the Node schema only
needs `citext` and `pg_trgm`, both standard, but the first CI run must confirm
this. No tests were skipped or weakened.

## 7. Kubernetes and alert delivery

Separated status:

| Layer | Status | Evidence |
|---|---|---|
| Static manifest validation | **VERIFIED** | `validate-k8s.py`: 50 documents in 31 files |
| Render/schema validation | **VERIFIED (static)** | `kustomize v5.5.0` + `kubeconform v0.6.7`: base 34/34, production 34/34, monitoring 11/11 valid, 0 invalid, exit 0 |
| Monitoring config validation | **VERIFIED (static)** | `scripts/check-prometheus-configs.sh`: 5 rules, both scrape configs valid, `amtool` valid; `validate-monitoring.py` exit 0 |
| Local Compose | **VERIFIED** | `docker compose config -q` exit 0 |
| Development runtime | **VERIFIED** (2026-10-26) | API + four workers, probes, authenticated metrics, event/index/agent cycle |
| Live Kubernetes rollout | **NOT RUN** | No cluster or kubectl |
| Live scrape / alert evaluation | **NOT RUN** | No Prometheus process reached a live target |
| Alert delivery to a human | **OPEN** | Shipped Alertmanager receiver has no integration |

Manifest review: API has liveness `/healthz`, readiness `/readyz` and a startup
probe; workers use `/healthz` and `/readyz` on port 9100; NetworkPolicies default
deny with least-privilege ingress/egress; the backup CronJob is `15 2 * * *` with
`concurrencyPolicy: Forbid`, `backoffLimit: 2`, a 2-hour active deadline and a
20 Gi ReadWriteOnce PVC; secrets are per-role; production overlay sets a real
provider and OTel.

Changes made in this pass (all static, none applied to a cluster):

1. `base/worker-services.yaml`: ClusterIP Services on `:9100` for the four
   workers, so the scrape targets are addressable by name.
2. `base/ai-api-deployment.yaml`: `prometheus.io/scrape/port/path` annotations on
   the API pod template (port 8000, authenticated `/metrics`).
3. `base/restore-drill-cronjob.yaml`: monthly `ai-restore-drill` Job
   (`0 6 1 * *`), the missing producer for `AIRestoreDrillStale`.
4. `base/restore-secret.example.yaml`: separate `ai_restore` credential, kept out
   of `ai-api-secrets` so serving pods never receive a database-creating role.
5. `kubernetes/monitoring/` (opt-in kustomization): Prometheus + Alertmanager
   Deployments, Services, PVC and NetworkPolicies in the `observability`
   namespace.
6. `monitoring/prometheus/prometheus-kubernetes.yml`: in-cluster scrape config
   with `alerting.alertmanagers`, the five-rule `rule_files`, and bearer-token
   jobs for `ai-api` and `ai-workers`.
7. `monitoring/prometheus/alertmanager.yml`: valid route/receiver config with an
   inert `unconfigured` receiver.
8. `scripts/k8s-monitoring-config.sh`: builds the three ConfigMaps from the
   canonical files and copies `AI_METRICS_AUTH_TOKEN` into an `ai-metrics-token`
   Secret.
9. `scripts/validate-monitoring.py` + CI wiring: fails if a rule lacks
   `expr`/`for`/severity/annotations, if the `alerting` block is missing, or if a
   worker scrape target has no matching Service. Proven by mutation (removing
   the `alerting` block or changing the API port both make it exit 1).
10. `scripts/check-prometheus-configs.sh`: fixes the pre-existing CI job, which
    ran `promtool check config` on a file whose `/etc/prometheus/...` paths do
    not exist on a checkout (confirmed failing). The script stages rewritten
    paths and validates the Compose config, the Kubernetes config and the
    Alertmanager config.

Remaining live-cluster steps are written as an executable procedure in
`docs/kubernetes-rollout.md` (pre-flight, role provisioning, secret creation,
migration Job, rollout, role verification, first backup, scheduled drill, alert
wiring, work cycle, abort criteria, rollback, evidence). Summary:

1. Approve a cluster and window; provision the seven roles and confirm 0019.
2. Create the real `ai-api-secrets` and the separate `ai-restore-secret`; create
   the migration ConfigMap.
3. Apply the production overlay; wait for the migration Job to complete.
4. Roll out API, web and four workers; confirm readiness 200 (not just liveness),
   authenticated metrics, and an observed event/reconcile/index/agent cycle.
5. Confirm tenant isolation under the actual `ai_api`/`ai_worker` identities.
6. Trigger the backup CronJob once; inspect the encrypted artifact,
   `ai.backup_runs` row and metrics; trigger one drill.
7. Apply `kubernetes/monitoring/`, add a real receiver, and capture a delivered
   test notification.
8. Exercise rollback and recovery per `docs/backup-recovery.md`.

### 7.1 Alerting: structure closed, delivery still open

The five backup rules exist in
`infrastructure/monitoring/prometheus/backup-alerts.yml`
(`AIBackupFailed`, `AIBackupStale`, `AIBackupIntegrityFailed`,
`AIBackupUnencrypted`, `AIRestoreDrillStale`) and are now referenced by an
in-cluster scrape config. The previous structural gaps are closed in source:

| Component | Repo state now | Residual gap |
|---|---|---|
| Alertmanager | `kubernetes/monitoring/alertmanager-deployment.yaml` + Service | Not deployed; no live instance |
| Receiver | `alertmanager.yml` ships one `unconfigured` receiver with no integration | **No human notification**; must be replaced and receipt captured |
| `alerting:` / `alertmanagers:` | Present in `prometheus-kubernetes.yml` | Untested against a live Alertmanager |
| Prometheus in cluster | `kubernetes/monitoring/prometheus-deployment.yaml` loads `ai-prometheus-rules` | Opt-in, not applied by the production overlay |
| Scrape targets | In-cluster DNS names; `ai-api:8000`, four worker Services on `:9100` | Not scraped live |
| Namespace network path | `allow-alertmanager-ingress` **and** `allow-alertmanager-egress` added (both were missing; `default-deny` dropped alerts and notifications) | Not enforced/tested live |
| Worker `Service` objects | Present in `base/worker-services.yaml` | Not created live |
| Drill producer | `base/restore-drill-cronjob.yaml` records `restore_drill` monthly | Never executed in a cluster |

So the status moved from "the cluster has no Prometheus and no scrape
endpoints" to "the manifests exist and statically validate, but nothing has been
deployed and the receiver cannot notify anyone." `promtool`/`amtool` prove the
configs parse; they prove nothing about scraping or delivery. Status:
**PARTIALLY VERIFIED (static) / OPEN for delivery**.

#### 7.2.1 Defect found in this pass: Alertmanager ingress was denied

NetworkPolicy allows apply **per direction**. The shipped policy set had
Prometheus **egress** to `alertmanager:9093` but no **ingress** rule on the
Alertmanager pods, while `default-deny` selects every pod in the namespace with
`policyTypes: [Ingress, Egress]`. The packet is therefore dropped at the
destination, so even after an operator adds a real receiver no alert could
arrive. `promtool`/`amtool`/`kubeconform` cannot see this: each file is valid.

- Proven statically: `monitoring/networkpolicy.yaml` contained 3 policies, only
  one of which declared `Ingress` (the catch-all deny), and no policy had a
  non-empty `ingress:` list.
- Fixed: added `allow-alertmanager-ingress` (from `app.kubernetes.io/name:
  prometheus` to `alertmanager` on TCP 9093).
- Regression guard: `scripts/validate-monitoring.py` now asserts that a
  namespace `default-deny` exists, that Prometheus egress to `alertmanager:9093`
  exists, and that Alertmanager ingress from Prometheus exists. Mutation-tested:
  deleting the new policy makes the validator exit 1 with
  "default-deny would drop Prometheus->Alertmanager alerts"; restoring it exits 0.

This is a static correction. Whether the cluster's CNI actually enforces it, and
whether an alert reaches a human, remain **NOT RUN**.

#### 7.2.2 Second defect in the same class: notification egress was also denied

The same per-direction mistake existed on the return path. `default-deny`
selects every pod for **Egress** as well, and no policy granted Alertmanager any
egress beyond cluster DNS. Adding a real receiver would therefore still deliver
nothing: the webhook/PagerDuty call is dropped at the Alertmanager pod.

- Proven statically: Alertmanager was covered by no `Egress` policy other than
  the namespace-wide DNS allow.
- Fixed: added `allow-alertmanager-egress` (TCP 443/80 to public addresses,
  excluding `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8`) so a
  misconfigured receiver cannot be used to reach cluster services or cloud
  metadata.
- Regression guard: the validator now also requires an Alertmanager egress rule
  with an `ipBlock` and port 443. Mutation-tested: deleting the policy makes the
  validator exit 1 with "default-deny would drop every receiver notification".

Together Sections 7.2.1 and 7.2.2 mean alerting had **two independent silent
failures**, both invisible to `promtool`, `amtool` and `kubeconform`, and both
on the path a future operator would have assumed was already working. When the
approved receiver lives on a private address or an internal SMTP relay, the
egress rule must be narrowed to that exact CIDR/port rather than left as-is.

#### 7.2.3 SEC-19 gate could be mistaken for a pass when tests skipped

`tests/test_db_roles.py` skips all 14 tests when the per-role DSNs are absent,
and pytest exits **0** on an all-skipped file. A green CI run could therefore be
read as role-separation evidence when nothing ran.

- Proven: `pytest tests/test_db_roles.py` -> `14 skipped`, exit 0.
- Fixed: added `AI_REQUIRE_ROLE_DB=1`, set by `scripts/verify-db-roles.sh`, which
  converts a missing DSN into `pytest.fail`. In that mode the same command exits
  **1** with "AI_REQUIRE_ROLE_DB=1 but role tests cannot run".
- The default hermetic suite is unchanged (still skips, still exit 0).


## 8. Production recoverability gap matrix

| Capability | Implemented | Configured | Operationally tested | Status |
|---|---|---|---|---|
| Encrypted backup creation | Yes (`backup_restore.py`, AES256) | CronJob sets `BACKUP_REQUIRE_ENCRYPTION=true` | Local encrypted backup + verify, 2026-10-26 | **PARTIALLY VERIFIED** |
| Restore and drill | Yes (isolated DB/bucket, app + workers) | Drill CLI only; the CronJob `args` is `["backup"]`, so no drill is scheduled | Local same-host drill 21/21 | **PARTIALLY VERIFIED** |
| Scheduled drill execution | `drill` subcommand exists | No CronJob or Job invokes it; documented cadence is 90 days | No | **OPEN** |
| Off-site replication | No | No | No | **OPEN** |
| Immutable / deletion-protected backups | No | No object lock | No | **OPEN** |
| KMS / approved key management | No | Passphrase via secret only | Local 0600 passphrase file | **OPEN** |
| Key rotation and recovery | No | No documented rotation/escrow drill | No | **OPEN** |
| Restore credential separation | Code supports `ai_restore` profile; separate `ai-restore-secret` manifest for the drill | `ai_restore` role still absent (SEC-19); never tested with real identities | Owner credential used; roles absent | **BLOCKED (SEC-19)** |
| Live-cluster restore | N/A | CronJob/PVC + monthly drill CronJob present | No | **NOT RUN** |
| RPO | No approved target | Drill text says `<= 24h` (tool statement) | No | **OPEN — requires business approval** |
| RTO | No approved target | None | 51.707s dev drill, 16.211s restore only | **OPEN — requires business approval** |
| Monitoring and alert delivery | Rules + metrics | Prometheus/Alertmanager manifests + worker Services present; receiver inert | No live deployment, scrape or notification | **OPEN (delivery) / static structure verified** |
| Retention and disposal | Retention logic exists | 14 days / min 3 in base, 365/100 in drill | Deletion not executed; retention deletion not tested | **PARTIALLY VERIFIED** |

The 2026-10-26 drill is credible development-scale evidence. It is not
production recoverability. Do not publish an RPO/RTO until business and
operations approve targets and a production-sized drill measures them.

## 9. Findings review against the original audit

| Finding | Previous claim | Current status | Note |
|---|---|---|---|
| SEC-01..SEC-04 | Fixed | **VERIFIED** | Code and targeted tests current; no regression observed |
| SEC-05..SEC-08 | Fixed | **VERIFIED** | Fencing/approval/tool-governance tests pass |
| SEC-09..SEC-12 | Fixed | **VERIFIED** | Legacy authz, production config, body limits, prompt-injection, citations tests pass |
| SEC-13..SEC-18 | Fixed | **VERIFIED** | Session hashing, object keys, ACL fail-closed, conversation ownership, metrics/docs gating |
| SEC-19 | Fixed (Batch K) | **PARTIALLY VERIFIED / BLOCKED operationally** | RLS verified; role separation not provisioned; 0019 absent |
| SEC-20 | Fixed (Batch J) | **PARTIALLY VERIFIED** | Encrypted local drill current; production recoverability open |
| Node CI | Open | **PARTIALLY VERIFIED** | Workflow added; not run in GitHub Actions |
| Live cluster | Open | **NOT RUN** | No cluster |
| Alerting | Open | **OPEN (delivery)** | Manifests and worker Services added; Alertmanager receiver still has no integration; nothing deployed |
| Worker HA | Open | **OPEN** | Single replicas |
| Stale `:8000` | Open | **OPEN** | Anonymous metrics, Swagger and OpenAPI 200; binds all interfaces |
| Cleanup | Open | **PARTIALLY VERIFIED** | Dry-run only; nothing deleted |

Regressions: none observed. The working tree remains dirty with the existing
remediation work; this pass added the CI workflow, `docs/kubernetes-rollout.md`,
and audit documents.

## 10. Test and check results actually executed in this pass

| Check | Command | Result |
|---|---|---|
| Frontend | `npm run test:web -- --run` | 30 passed, 6 files, 17.36s, exit 0 |
| Focused Python | `pytest -q tests/test_production_config.py tests/test_observability.py tests/test_request_body_limits.py` | 32 passed, 5.59s, exit 0 |
| Node shard 0 (CI shape) | 13 sorted files, `node --test --test-concurrency=1` | 151 passed, 0 failed, 0 skipped, 1,181.2s, exit 0 |
| SEC-20 verify | `backup_restore.py verify --artifact 20261026T103104Z-3e8513` | exit 0, encrypted, checksums OK |
| SEC-19 provisioning gate | `psql -U helix -f provision_roles.sql` | exit 3, refused |
| SEC-19 migration gate | `psql -U helix -f 0019...sql` | exit 3, roles missing |
| SEC-19 skip-is-not-a-pass guard | `AI_REQUIRE_ROLE_DB=1 pytest tests/test_db_roles.py` | exit 1, 14 errors (default mode still 14 skipped, exit 0) |
| Role verification gate | `./scripts/verify-db-roles.sh` | exit 2, five DSNs missing |
| Cleanup dry-run | 5 guarded `cleanup` calls | 5 × `executed:false`, 0 errors |
| Ruff | `ruff check apps/ai-api/src apps/ai-api/tests scripts` | All checks passed |
| Manifests | `validate-k8s.py` | 50 documents / 31 files, OK |
| Monitoring config | `validate-monitoring.py` | OK; 1 expected warning (inert receiver) |
| Kustomize render | `kustomize build` base, overlays/production, monitoring | exit 0 ×3 |
| Kubeconform schema | `kubeconform -strict -ignore-missing-schemas -summary` | 34/34, 34/34, 11/11 valid; 0 invalid |
| Prometheus rules | `promtool check rules backup-alerts.yml` | SUCCESS: 5 rules |
| Prometheus configs | `scripts/check-prometheus-configs.sh` (staged paths) | both configs valid, exit 0 |
| Alertmanager config | `amtool check-config alertmanager.yml` | SUCCESS, 1 receiver, 0 inhibit rules |
| Backup/restore tests | `pytest -o addopts="" -q tests/test_backup_restore.py` | 24 passed, 1 skipped |
| Live backup+verify+encrypt test (previously the skip) | `AI_TEST_BACKUP=1 pytest ...::test_live_backup_and_verification` against local `helix` | **1 passed in 9.17s** |
| Drill role-probe regression | new `test_restore_role_verifier_probes_maintenance_database` + ownership rejection test | 5 selected passed |
| Compose | `docker compose config -q` | exit 0 |
| Whitespace | `git diff --check` | clean |
| Workflow YAML | `yaml.safe_load` + shard math | 9 jobs, 12×13 = 156 |
| Node test syntax | `node --check` on all 156 files | 0 failures |
| Node test-count reconciliation | sum of `test(`/`it(` per file | 1,932 across 156 files; 0 files with zero tests |
| Metrics/docs reconciliation (isolated app, no server) | `TestClient` with `AI_ENV=production` and a token set | anonymous `/metrics` 401, bearer 200, wrong bearer 401, production docs 404, OpenAPI 404 |
| Stale `:8000` exposure recheck | anonymous `curl` on `/metrics`, `/api/v1/ai/docs`, `/api/v1/ai/openapi.json`, `/events`, `POST /chat` | metrics 200, docs 200, OpenAPI 200, events 401, chat 401 |
| Reconciliation test rerun | `pytest -o addopts="" -q tests/test_observability.py tests/test_production_config.py tests/test_request_body_limits.py` | 32 passed, 8.53s, exit 0 |

Not run in this environment: full 1,932-test Node suite (reported 2026-10-26,
logs `/tmp/node-*.log`), full Python suite (reported 2026-10-26,
`/tmp/sec-full-python.log`), actionlint, live Kubernetes, live scrape, and
Alertmanager delivery. These remain **NOT RUN** or rely on the 2026-10-26
evidence. `kustomize`, `kubeconform`, `promtool` and `amtool` were downloaded
into `/tmp/opencode` for this pass; their versions were `v5.5.0`, `v0.6.7`,
`2.53.5` and `0.27.0`.

### 10.1 Defects found and fixed while wiring the drill

Two latent defects in the encrypted path would have failed the monthly in-cluster
drill (and the daily backup) even after SEC-19 was provisioned. Both were found
by executing the tools, not by reading them:

1. **Restore-role check against a database that does not exist.** `run_drill`
   and `restore --create-database` called `_verify_role` with the target
   connection, whose `database` is the not-yet-created
   `ai_restore_drill_<timestamp>`. Proven with the real binary: it fails with
   `FATAL: database "... " does not exist` before any restore happens. Fixed by
   probing role attributes through the maintenance database
   (`_verify_restore_role`), which is where `pg_roles` lives; the probe also
   forbids the restore role owning the source schema. Regression tests:
   `test_restore_role_verifier_probes_maintenance_database`,
   `test_restore_role_verifier_rejects_source_schema_ownership`.
2. **gpg has no writable home.** `_encrypt_file`/`_decrypt_to_temp` invoked gpg
   with the inherited environment. The backup image runs uid 10001 with
   `useradd --no-create-home` and `readOnlyRootFilesystem: true`, so gpg cannot
   create `$HOME/.gnupg` and exits 2. Proven locally with `HOME=/nonexistent`
   (exit 2) versus a writable `GNUPGHOME` (exit 0). Fixed with a
   `_gpg_environment()` context manager that creates a `0700` temp dir, sets
   `HOME` and `GNUPGHOME` to it, and removes it afterwards. End-to-end proof with
   `HOME=/nonexistent`: encrypt 90 bytes, decrypt round-trip returns the
   original plaintext. Regression test: `test_gpg_environment_is_writable_and_isolated`.

Neither fix was previously exercised because every prior drill ran on a host with
a normal home directory and an existing target database. Both are **VERIFIED** by
execution; the in-cluster run of the fixed image remains **NOT RUN**.

## 11. Operator actions and approvals required

1. **SEC-19 (blocker)**: approve a maintenance window; run the DBA checklist in
   Section 3.3 as superuser; apply 0019; restart workloads with role profiles;
   capture 14/14 role tests and readiness 200/503. Named owners: DBA, platform
   SRE, security reviewer.
2. **SEC-20 cleanup**: approve or reject each line of the Section 4.2 manifest.
   Preserve `3e8513`, `6ae044`, and the current evidence JSON. Execute only with
   the guarded command and an audited artifact procedure.
3. **SEC-20 production**: approve RPO/RTO targets; run an encrypted drill with
   `ai_backup`/`ai_restore` against a separate physical target in a live cluster;
   add off-site replication, object lock/immutability, KMS/escrow, and a tested
   key-recovery procedure.
4. **Node CI**: run the new workflow in GitHub Actions on a PR; confirm all 12
   shards pass on `postgres:16` and that the coverage guard fails when a file is
   added without updating the matrix. Watch shard 2 (322 declared tests) against
   the 75-minute cap; split the range rather than raising the timeout if it does
   not fit. No further code change is required.
5. **Kubernetes**: approve a cluster and rollout window; execute
   `docs/kubernetes-rollout.md` end to end, including a real backup CronJob run
   and restore drill.
6. **Alerting**: the manifests now include worker Services, an opt-in
   Prometheus/Alertmanager stack and `alerting.alertmanagers`, but nothing is
   deployed and the receiver is inert. Apply
   `infrastructure/kubernetes/monitoring/` (after
   `scripts/k8s-monitoring-config.sh`), replace the `unconfigured` receiver with
   an approved destination, and capture a delivered test notification. Until
   then, delivery stays OPEN; see Section 7.1.
7. **Restore identity in-cluster**: resolved in manifests by the separate
   `ai-restore-secret`, mounted only by `ai-restore-drill` and never by a serving
   pod. Still unproven because the `ai_restore` role does not exist (SEC-19);
   confirm in the rollout window. The drill role check now probes the
   maintenance database, which needs `CONNECT` on `postgres`.
8. **HA**: add a reconciler advisory/lease and an atomic event/index claim
   before scaling beyond one replica.
9. **Deployment drift**: contain the stale `:8000` process. Preferred: remove
   external reachability without restarting it (loopback/observability-only bind
   or firewall), because it binds `0.0.0.0` and serves `/metrics`, Swagger and the
   full OpenAPI schema anonymously. Alternative: under an approved maintenance
   action, stop and restart the current build with `AI_ENV`,
   `AI_METRICS_AUTH_TOKEN` and the `api` role profile. Do not restart it without
   authorization, and do not modify `:3001`.
10. **Documentation**: after CI and live-cluster runs, update the readiness
    document with the new evidence; keep `docs/testing.md` and
    `docs/PHASE13_TESTING.md` counts synchronized.

### 11.1 Work package register

> **Superseded for tracking.** `docs/audit/STAGES_1-6_GATE_CLOSURE_TRACKER.md`
> is the authoritative work-package tracker. This table is retained as
> historical evidence of the 2026-10-27 register. Its IDs differ from the
> tracker for rollout, CI, cleanup, recoverability and worker HA; see the
> tracker's Section 2 for the mapping. Status values here are unchanged.

Owner is expressed as the accountable role, because a named individual and a
calendar date can only be assigned by the program owner. The target column is a
relative window measured from the date the work is authorised; replace it with a
committed date when the owner is named.

| WP | Work package | Accountable owner | Proposed target | Exit criteria (independently verifiable) |
|---|---|---|---|---|
| WP-1 | Contain stale `:8000` exposure | Platform security lead + infrastructure on-call | **24 h** — time-critical, no restart required for the preferred option | Either external reachability removed, or written time-boxed acceptance; anonymous `/metrics`, `/api/v1/ai/docs` and `/api/v1/ai/openapi.json` no longer 200 from off-host, or the acceptance is recorded with an expiry |
| WP-2 | SEC-19 role provisioning | DBA (provisioning), platform SRE (workloads), security (evidence review) | **10 business days** | 7 roles present with correct attributes; 0019 applied (19 migration rows); 14/14 role tests pass; cross-tenant reads/writes denied as `ai_api`; `/readyz` 200 intended / 503 deliberate mismatch |
| WP-3 | Live-cluster rollout | Platform SRE | **15 business days**, after WP-2 | `docs/kubernetes-rollout.md` Sections 1–7, 9, 10 executed; rollout evidence retained; rollback exercised |
| WP-4 | Monitoring architecture and alert delivery | Observability owner (to be named — currently unassigned in the repo) | **15 business days**, may run parallel to WP-3 | Worker Services, in-cluster Prometheus/Alertmanager manifests, `alerting:` block and `validate-monitoring.py` now exist. Remaining exit criteria: apply `kubernetes/monitoring/`; replace the inert receiver; test notification received with receipt; five rule names visible via `/api/v1/rules`; every target `up` |
| WP-5 | Scheduled restore drill | Backup owner (DBA + platform SRE) | **15 business days**, after WP-2 and WP-3 | Manifest added (`ai-restore-drill`, monthly). Remaining: confirm a `restore_drill` row with `status='succeeded'` from a real run; drill report filed under `docs/audit/evidence/`; operator cleanup confirmed |
| WP-6 | Restore identity wiring decision | Security architect + DBA | **10 business days** | Manifests now use a separate `ai-restore-secret` mounted only by the drill Job. Remaining: confirm in the SEC-19 window that `ai_restore` connects with only the drill credential and no serving workload's `envFrom` includes it |
| WP-7 | Node CI proof in GitHub Actions | CI owner / enterprise backend owner | **5 business days** | Workflow green on a reviewed PR; all 12 shards pass on `postgres:16`; measured shard durations recorded (shard 2 projected ≈42 min, must be measured); guard proven to fail on a file add/remove in a scratch branch |
| WP-8 | Cleanup approval | Audit evidence owner + DBA | **10 business days** | Each of the 16 manifest rows individually approved or rejected in writing; approved items executed with the guarded command; `3e8513`, `6ae044` and evidence JSON preserved |
| WP-9 | Production recoverability targets (RPO/RTO) | Business continuity owner + platform lead | **20 business days** | Approved RPO/RTO; production-scale encrypted drill measured against them; off-site copy, immutability, KMS/escrow and key-recovery drill evidenced |
| WP-10 | Worker HA coordination | Enterprise backend owner | **20 business days**, before scaling past 1 replica | Reconciler lease and atomic event/index claim implemented and tested; two-replica soak shows no duplicate processing |

Sequencing constraints: WP-2 before WP-3, WP-5 and WP-9; WP-3 before WP-4
verification of worker targets; WP-1 and WP-7 are independent and can start
immediately. WP-4 and WP-3 share the `observability` namespace and NetworkPolicy
label, so they must be coordinated even though the closing evidence is separate.

Ownership gap worth recording explicitly: **no observability owner currently
exists in this repository or in the operator action list**, which is why alerting
has stayed open across three review passes. WP-4 needs a named human owner before
it can be scheduled.

## 12. Go/no-go

**NO-GO for Stage 7 and production.**

Since the 2026-10-26 assessment, the enterprise Node suite is now enforced by a
validated CI workflow (not yet run remotely) and the encrypted restore path has
been independently re-verified. Those close two evidence gaps but do not change
the production blockers:

- SEC-19 role separation is not provisioned; migration 0019 is not applied; no
  workload runs as its intended least-privilege role.
- No live Kubernetes rollout, no live backup CronJob, no in-cluster restore.
- No off-site/immutable backup, no KMS/escrow or key-recovery drill, no approved
  RPO/RTO, no production-scale recovery measurement.
- Alert delivery is unproven. The structural gap is closed in source (worker
  Services, in-cluster Prometheus/Alertmanager, scheduled drill,
  `alerting:`/`alertmanagers:`), but none of it is deployed and the shipped
  Alertmanager receiver has no integration, so no human is notified. A valid
  config is not delivery.
- The stale `:8000` API binds `0.0.0.0` and serves anonymous metrics, Swagger and
  the full OpenAPI schema. Data endpoints still require auth, so this is
  configuration/schema disclosure plus telemetry, not tenant-data disclosure.
- Five drill target pairs and several unencrypted artifacts await an approved
  cleanup decision.

Revisit only after the SEC-19 window, a live-cluster rollout, a production-scale
encrypted recovery drill with approved targets, and alert delivery are complete
and their sanitized evidence is recorded here and in the readiness document.

## 13. Evidence paths

- `docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` (this report)
- `docs/audit/evidence/STAGES_1-6_EVIDENCE_2026-10-26.md`
- `docs/audit/evidence/SEC-20_encrypted_restore_drill_2026-10-26.json`
- `docs/audit/evidence/SEC-20_encrypted_backup_manifest_2026-10-26.json`
- `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json` (historical, pre-RLS)
- `docs/audit/STAGES_1-6_OPERATIONAL_READINESS_2026-10-26.md`
- `docs/kubernetes-rollout.md` (executable live-cluster and alerting procedure)
- `.github/workflows/ai-platform-ci.yml` (Node coverage guard + 12-shard matrix)
- `/tmp/gate-sec20-cleanup-dryrun.log`
- `/tmp/gate-node-shard0-full.log`
- `/tmp/gate-frontend.out`, `/tmp/gate-python-targeted.out`, `/tmp/gate-ruff.out`,
  `/tmp/gate-k8s.out`, `/tmp/gate-compose.out`
- `/tmp/gate-prov.out`, `/tmp/gate-0019.out`, `/tmp/gate-verify.out`,
  `/tmp/gate-sec20-verify.out`
- `/tmp/sec20-backups/artifacts/20261026T103104Z-3e8513` (encrypted artifact)
- `/tmp/sec20-backups/restore-drills/drill-20261026T103451Z-6ae044.json`
