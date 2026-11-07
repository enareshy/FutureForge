# Stages 1-6 operational readiness assessment

Assessment date: 2026-10-26T09:36:55Z
Revalidated: 2026-10-26T12:15Z (Node suite completion and encrypted SEC-20 drill)
Gate-closure pass: 2026-10-27T05:07Z (independent re-verification and Node CI gate)
Counts re-baselined: 2026-10-28Z (added `allow-alertmanager-ingress` and
`allow-alertmanager-egress`, so the manifest total is 50 documents and the
monitoring render is 11 resources; every
other finding and status below is unchanged from the 2026-10-27 pass)
Repository: `ai-platform` on top of commit `296ea36` plus uncommitted remediation work
Scope: Stages 1-6 runtime, SEC-19 role separation, SEC-20 backup/restore, and the
security controls delivered by Batches A-K.

Companion evidence: `docs/audit/evidence/STAGES_1-6_EVIDENCE_2026-10-26.md` and
`docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md`.

## Decision

**NO-GO for Stage 7 and for a production launch.**

The application is credible at development scale: the current API starts, all four
workers run and expose authenticated metrics, RLS blocks unscoped reads, an event
was consumed, an index job was executed by the indexer, and a queued agent
execution was claimed, approved and completed. The Python suite, the full 156-file
enterprise Node suite, lint, Compose and manifest validation pass. An encrypted
same-host restore drill also passed 21/21 checks.

The production decision is still blocked by the same operational items recorded in
`docs/audit/STAGES_1-6_REAUDIT_2026-10-23.md`:

1. SEC-19 role separation is implemented in code and manifests but is **not
   provisioned or operationally verified**. The development database still uses the
   table-owner login `helix`; migration 0019 is not applied.
2. No live Kubernetes cluster was available. Worker rollouts, the migration Job,
   the backup CronJob and the NetworkPolicies are statically validated only.
3. Backup restore is proven only on development-scale data on the same PostgreSQL
   server, using an encrypted artifact. There is no off-cluster copy, no tested key
   escrow, no production-sized RTO measurement and no notification receiver.
4. The enterprise Node suite completes locally as one documented 156-file run
   (1,932 passed, 0 failed). A 12-shard CI gate with a coverage guard was added on
   2026-10-27 and validated locally, but it has not yet run in GitHub Actions.
5. The long-running API on port 8000 is a stale process that predates the metrics
   authentication and production docs-gating changes. It binds `0.0.0.0` and
   currently serves `/metrics`, Swagger (`/api/v1/ai/docs`) and the full OpenAPI
   schema anonymously. Data endpoints still return 401. See
   `docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` Section 5.1 for the
   reconciliation with the current build's 401/404 behaviour.

Stage 7 work was not started. Nothing was committed or pushed. No destructive
cleanup was performed.

## Environment

- PostgreSQL 15.19 on 127.0.0.1:5432, database `helix`, schema `ai`.
- Development login `helix`: `rolsuper=f`, `rolcreaterole=f`, `rolcreatedb=t`,
  `rolbypassrls=f`. It owns the `ai` objects. No superuser or `CREATEROLE`
  credential is available.
- `ai.schema_migrations` contains 0001-0018. `0019_system_access_role_gate.sql` is
  not applied.
- SeaweedFS object storage is running at 127.0.0.1:8333; Redis and an OpenSearch
  integration container are running. There is no local Kubernetes cluster and
  `kubectl`, `kustomize` and `kubeconform` are not installed.
- Disk: 8.9 GiB free. The one failed index job in the database (job 10) dates from
  2026-10-14 and failed with `No space left on device`; it is historical, not a
  current failure.

## Readiness matrix

| Area | Evidence obtained now | Status |
|---|---|---|
| API startup and readiness | Current build on 127.0.0.1:18000: `/healthz` 200, `/readyz` 200, authenticated chat and search 200 | Verified locally |
| API metrics authentication | Current build: anonymous `/metrics` 401, bearer token 200 | Verified locally |
| Four workers | Event consumer, reconciler, indexer and agent each returned `/healthz` 200 and `/readyz` 200; anonymous `/metrics` 401, authenticated 200 | Verified locally |
| Event delivery | A live chat request created one event; the event consumer observed it and marked one delivery, with no dead letters | Verified locally |
| Index execution | Manual index job 228 was queued through the API and completed by the indexer | Verified locally |
| Agent execution | Queued execution 319 was claimed by the agent worker, paused for approval, approved through the API and completed with one tool call | Verified locally |
| RLS backstop | With no tenant/system context, `ai.events` returned 0 rows; tenant 1 returned 119; system scope returned all 119 | Verified locally |
| Role gate enforcement | Starting with `AI_DB_ROLE_PROFILE=api` and owner role `helix` logged `owns_ai_tables,createdb` and `/readyz` returned 503 | Verified fail-closed behavior |
| SEC-19 role separation | Roles rechecked absent on 2026-10-27; 0019 fails closed; role suite skipped; provisioning requires a superuser | **OPEN** |
| Backup artifact integrity | Encrypted 2026-10-26 artifact `20261026T103104Z-3e8513` (AES256, checksum `c3e675…6623`, 75,688 B) re-verified on 2026-10-27 (`verify` exit 0) | Verified locally |
| Restore drill | 2026-10-26 encrypted drill `20261026T103451Z-6ae044`: 21/21 checks, 51.707s, 43 forced-RLS tables and policies restored, API and all four workers healthy | Development-scale only |
| Kubernetes rollout | 50 documents in 31 files pass `validate-k8s.py`; base/production render 34/34 valid, monitoring 11/11 (`kustomize v5.5.0` + `kubeconform v0.6.7`); no live rollout | Pending live |
| Worker HA coordination | Single replicas documented; reconciler has no global lease; event/index selection is not an atomic claim | Partially mitigated |
| Alerting | Rules valid (`promtool`: 5 rules); worker Services + opt-in Prometheus/Alertmanager in `infrastructure/kubernetes/monitoring/`; **receiver has no integration**, so no human is notified and no live scrape/alert was observed | **OPEN** |
| Production search provider | Base deployment uses PostgreSQL search; decision documented | Verified by configuration |
| Python suite | 470 passed, 42 skipped in 215.39s with `AI_TEST_POSTGRES=1`; targeted security subset 253 passed, 15 skipped in 107.67s | Verified |
| Enterprise Node suite | 156/156 files in five serial batches: 1,932 passed, 0 failed, 0 skipped, 8,283.3s total; sorted-diff coverage check empty | Verified locally |
| Enterprise Node CI gate | `.github/workflows/ai-platform-ci.yml` adds a 12×13 coverage guard plus disjoint shards; local shard 0 passed 151/151; shard 2 declares 322 tests and is the timeout risk; not yet run in GitHub Actions | Partially verified |
| Frontend suite | 30 passed in 6 files | Verified |
| Lint / syntax / config | `ruff` clean, `git diff --check` clean, `docker compose config -q` clean, `bash -n` scripts previously clean | Verified |

## What was exercised locally

The current API was started on loopback port 18000 to avoid disturbing the existing
port 8000 process. The existing `helix` login and the development `.env` were used;
therefore these runs prove behavior, not least-privilege operation.

### API

- `/healthz` and `/readyz` returned 200.
- Anonymous `/metrics` returned 401; `Authorization: Bearer <AI_METRICS_AUTH_TOKEN>`
  returned 200.
- Authenticated chat and search returned 200.
- The opt-in live smoke file reported 6 passed and 1 failed. The failure is a test
  harness issue: `apps/ai-api/tests/conftest.py` unconditionally replaces
  `AI_METRICS_AUTH_TOKEN` with `test-metrics-token`, so the live test cannot use the
  deployment token. Direct `curl` and `httpx` requests with the configured token
  return 200, and anonymous requests return 401. The test should use
  `os.environ.setdefault(...)` before it can be used as live deployment evidence.

### Workers

All four workers were run with `--watch --metrics-port 9101..9104` against the
development database:

| Worker | Ready | Metrics | Result |
|---|---|---|---|
| `event_consumer` | 200 | 401 anonymous / 200 bearer | Consumed the live chat event; delivered 1; 0 dead letters |
| `reconciler` | 200 | 401 anonymous / 200 bearer | Completed a pass for tenant 1; no candidates and no deletions |
| `indexer` | 200 | 401 anonymous / 200 bearer | Processed manual index job 228 to `succeeded` |
| `agent` | 200 | 401 anonymous / 200 bearer | Claimed execution 319, waited for approval, then completed it |

One transient cycle failure occurred at 2026-10-26T08:52:06Z on three workers with
an empty error string. All workers recovered automatically, `consecutive_failures`
returned to 0, readiness remained 200, and no dead letters were produced. The cause
was not captured because the worker logs log only `str(exc)` and the exception text
was empty. This should be improved before relying on worker logs for incident
analysis.

### RLS

The development owner role is subject to `FORCE ROW LEVEL SECURITY`. Direct SQL
queries showed:

- No `ai.tenant_id` and no system scope: `ai.events` count 0.
- `ai.tenant_id=1`: `ai.events` count 119.
- `ai.system_access=on`: the same 119 rows plus the surrounding queue state.

This confirms the RLS backstop is active even for the owner. It does not prove
non-owner role behavior, which is the role-suite gap.

## SEC-19 role separation

Artifacts inspected:

- `infrastructure/db/roles/provision_roles.sql`: creates `ai_owner`,
  `ai_system_access`, `ai_api`, `ai_worker`, `ai_backup`, `ai_restore`, `ai_migrate`;
  transfers ownership; grants narrow paths; requires superuser.
- `migrations/0019_system_access_role_gate.sql`: binds system scope to both the
  transaction GUC and membership in `ai_system_access`; fails closed if any role is
  missing.
- `scripts/migrate.sh`, `scripts/backup_restore.py`, `settings.py`, `database.py`,
  Kubernetes and Compose manifests: distinct role/profile wiring.

Evidence:

- `provision_roles.sql` run as `helix` exits 3:
  `role provisioning requires a superuser; the application/migration roles cannot run it`.
- `0019_system_access_role_gate.sql` run as `helix` exits 3:
  `missing required database role(s): ai_api, ai_backup, ai_migrate, ai_owner, ai_restore, ai_system_access, ai_worker`.
- `scripts/verify-db-roles.sh` exits 2 because all five DSNs are absent.
- `tests/test_db_roles.py` reports 14 skipped; no test connected as a real runtime
  role.
- A startup profile of `api` with the owner login is rejected and readiness returns
  503, so the runtime assertion fails closed when configured.

Conclusion: SEC-19 remains **OPEN operationally**. Do not mark it fixed from static
manifests or from tests that run as the owner.

## SEC-20 backup and restore

- A fresh encrypted backup `20261026T103104Z-3e8513` was produced with
  `BACKUP_REQUIRE_ENCRYPTION=true`: AES256 for both `postgres.dump.gpg` (74,490 B)
  and `objects.tar.gz.gpg` (1,198 B), manifest checksum
  `c3e675367a26ce7f69e27d9ca1eadfa1ed8a4b1ddc47023ffe00cb3e77ec6623`, 75,688 B.
  It contains the applied 0001-0018 migration history and 43 `FORCE ROW LEVEL
  SECURITY` statements.
- The same run produced drill `20261026T103451Z-6ae044`: success, 51.707s, 21/21
  checks, against isolated target `ai_restore_drill_20261026_103451` and bucket
  `ai-knowledge-restore-drill-20261026103451`. The restored database has 43 forced
  RLS tables and 43 `tenant_isolation` policies; 3 documents and 124 events are
  visible under system scope and 0 rows unscoped. API readiness and all four worker
  one-shot runs passed. `ai.backup_runs` records `encrypted=t`, `integrity_ok=t`.
- Evidence: `docs/audit/evidence/SEC-20_encrypted_restore_drill_2026-10-26.json` and
  `docs/audit/evidence/SEC-20_encrypted_backup_manifest_2026-10-26.json`.
- The earlier encrypted artifact `20261025T080235Z-b5abbe` predates RLS (created
  before 0018 was applied on 2026-10-26 03:49:24Z). Restoring it yields zero
  forced-RLS tables and the drill fails readiness with
  `database row-level security is not enforced`; this is correct fail-closed
  behavior. The corresponding 2026-10-25 drill report is historical only.
- An accidental unencrypted artifact `20261026T113945Z-3dd431` (236,561 B,
  `cipher: none`) was created at `/backup/artifacts/` because an environment
  assignment was applied in the wrong shell scope. It was not deleted and needs
  approved cleanup. A corrected check using `env -u` and
  `BACKUP_REQUIRE_ENCRYPTION=true` exited 1 with `encryption_required`, so the
  fail-closed path itself works.
- Five scratch databases and five buckets remain from drills
  (`ai_restore_drill_20261025_072800`, `..._20261025_080325`, `..._20261026_043531`,
  `..._20261026_102324`, `..._20261026_103451`, with matching
  `ai-knowledge-restore-drill-*` buckets). A guarded cleanup dry-run was executed for
  each; no deletion was performed. Cleanup is deferred pending explicit operator
  approval.
- Development Compose defaults `BACKUP_REQUIRE_ENCRYPTION=false`. The Kubernetes
  ConfigMap sets it to `true`, but a local drill run without the flag can produce
  plaintext dumps, as `20261026T113945Z-3dd431` demonstrates.
- Not verified: production-sized restore, separate physical target, off-cluster
  replication/immutability, key escrow recovery, live CronJob execution, and
  alert delivery.

## Existing deployment drift

The API process on `0.0.0.0:8000` was started on 2026-10-23, before the current
metrics-authentication and role-gate changes. It returns 200 for anonymous
`/metrics` and does not represent the current build. It must be restarted from the
current image/code with `AI_METRICS_AUTH_TOKEN` before it is used for a preview or
any shared environment. The current build on loopback port 18000 returned 401 for
anonymous metrics.

## Reproduction commands

The verification API was run from `apps/ai-api`:

```bash
PYTHONPATH=src python3 -m uvicorn ai_api.main:app --host 127.0.0.1 --port 18000
```

The workers were run from `apps/ai-api` with the same environment:

```bash
python3 -m ai_api.workers.event_consumer --watch --metrics-port 9101
python3 -m ai_api.workers.reconciler --watch --metrics-port 9102
python3 -m ai_api.workers.indexer --watch --metrics-port 9103
python3 -m ai_api.workers.agent --watch --metrics-port 9104
```

The rejected role profile was exercised by starting the API with:

```bash
AI_DB_ROLE_PROFILE=api AI_DB_EXPECTED_ROLE=helix \
PYTHONPATH=src python3 -m uvicorn ai_api.main:app --host 127.0.0.1 --port 18000
```

Role artifacts were executed directly as the development owner:

```bash
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -v ON_ERROR_STOP=1 \
  -f infrastructure/db/roles/provision_roles.sql
./scripts/verify-db-roles.sh
PYTHONPATH=src python3 -m pytest -o addopts='' -q tests/test_db_roles.py
```

Backup verification used the new encrypted artifact:

```bash
BACKUP_DIR=/tmp/sec20-backups \
BACKUP_ENCRYPTION_PASSPHRASE_FILE=/tmp/sec20-backups/passphrase \
python3 scripts/backup_restore.py verify --artifact 20261026T103104Z-3e8513
```

## Test evidence

| Check | Command | Result |
|---|---|---|
| Python full suite | `cd apps/ai-api && AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -o addopts='' -q --tb=short` | 470 passed, 42 skipped, 215.39s, exit 0 |
| Targeted security subset | `AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -o addopts='' -q -rs <23 files>` | 253 passed, 15 skipped, 107.67s, exit 0 |
| Role suite | `PYTHONPATH=src python3 -m pytest -o addopts='' -q tests/test_db_roles.py` | 14 skipped |
| Role verification | `./scripts/verify-db-roles.sh` | exit 2, missing five role DSNs |
| Live smoke | `AI_E2E=1 ... pytest -o addopts='' -q -m live apps/ai-api/tests/test_live_smoke.py` | 6 passed, 1 failed (conftest token override) |
| Frontend | `npm run test:web -- --run` | 30 passed, 6 files |
| Node suite | `node --test --test-concurrency=1 --test-reporter=spec` over five serial file ranges | 156/156 files: 1,932 passed, 0 failed, 0 skipped, 8,283.3s |
| Lint | `python3 -m ruff check apps/ai-api/src apps/ai-api/tests scripts` | clean |
| Manifests | `python3 scripts/validate-k8s.py` | 50 documents in 31 files |
| Monitoring config | `python3 scripts/validate-monitoring.py` | OK (1 expected receiver warning) |
| Kustomize render + schema | `kustomize build` / `kubeconform -strict` on base, production, monitoring | 34/34, 34/34, 11/11 valid, exit 0 |
| Prometheus/Alertmanager config | `promtool check rules/config` (co-located paths), `amtool check-config` | 5 rules, both configs valid |
| Compose | `docker compose --env-file .env -f compose.yaml config -q` | clean |
| Whitespace | `git diff --check` | clean |

The earlier audit's 470/42 figure is the Python suite only. It does not include the
enterprise Node suite. The Node suite completed locally in five serial batches
(40/29/29/29/29 files, 641/345/397/220/329 passed) totalling 1,932 passed with no
failures or skips; the concatenated ranges covered 156 unique files and a sorted
diff against `server/tests/*.test.js` was empty. Batches were serial because the
harness uses a fixed clone-slot pool. The suite is now wired as a CI gate (12
shards plus a coverage guard) and validated locally, but has not run in GitHub
Actions, so the enforcement is not yet proven remotely.

The verification API on 18000 and the four workers on 9101-9104 were stopped after
the runs. The pre-existing Node backend on 3001 and the stale API on 8000 were left
untouched.

## Required operator actions

1. **SEC-19 provisioning window**
   - Stop API, workers, backup jobs and migration jobs.
   - Run `infrastructure/db/roles/provision_roles.sql` as a PostgreSQL superuser.
   - Set unique passwords for `ai_api`, `ai_worker`, `ai_backup`, `ai_restore` and
     `ai_migrate`; put them in the secret store.
   - Apply migration 0019 through `ai_migrate` with `SET ROLE ai_owner`.
   - Restart API and workers with `AI_DB_ROLE_PROFILE` and
     `AI_DB_EXPECTED_ROLE`.
   - Run `scripts/verify-db-roles.sh` with all five DSNs and record the passing
     result. Do not close SEC-19 before this.
2. **Kubernetes**
   - Follow `docs/kubernetes-rollout.md` for the executable procedure.
   - Roll out the API, four workers and the migration Job in a real cluster.
   - Observe one event, reconcile, index and agent cycle; confirm probes and
     metrics with the production token.
   - Run the backup CronJob and inspect the artifact, `ai.backup_runs` row and metrics.
3. **Backup/restore**
   - Local encrypted drill with `BACKUP_REQUIRE_ENCRYPTION=true` is complete; repeat
     it in production with the `ai_backup`/`ai_restore` roles and an isolated target.
   - Keep drill reports under `docs/audit/evidence/`.
   - Copy encrypted artifacts off-cluster, test key escrow and record measured RTO.
   - Clean up the five scratch databases and buckets after written approval using
     the guarded cleanup command, and remove the accidental unencrypted artifact
     `20261026T113945Z-3dd431` under the approved deletion policy.
4. **Operations**
   - Deploy the opt-in monitoring stack, add a real Alertmanager receiver, and
     send a test notification. The manifests now include worker Services, a
     Prometheus, an Alertmanager and scheduled drill wiring, but the shipped
     receiver has no integration and no live scrape/alert was observed. Capture
     the receiver receipt. See `docs/kubernetes-rollout.md` Section 8.
   - Add a reconciler lease and an atomic event/index claim before scaling those
     workers beyond one replica.
   - Contain the stale port 8000 process: remove external reachability now
     (loopback/observability-only bind or firewall) if permitted; otherwise
     restart it from the current build under an approved maintenance action so
     metrics, Swagger and OpenAPI stop being anonymous. Do not restart it
     without authorization.
   - Use readiness, not liveness, as the deployment gate; a rejected role leaves
     liveness at 200 and readiness at 503.
   - Run the newly added 12-shard enterprise Node CI gate in GitHub Actions and
     confirm the coverage guard and all shards pass, then keep the test counts in
     `docs/testing.md` and `docs/PHASE13_TESTING.md` synchronized.

## Go/no-go

**NO-GO.** Runtime behavior is healthy at development scale and both the encrypted
backup/restore drill and the full enterprise Node suite pass locally. A Node CI
gate has been added and validated locally but has not run in GitHub Actions. The
production controls that gated Stage 7 are still incomplete: role separation is not
provisioned, there is no live-cluster proof, backup recovery is not proven beyond a
single development-scale host, alert delivery does not exist, and cleanup awaits
operator approval. Revisit only after the operator actions above are completed and
their evidence is recorded.
