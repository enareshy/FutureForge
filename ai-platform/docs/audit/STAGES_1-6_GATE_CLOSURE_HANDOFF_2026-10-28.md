# Stages 1-6 gate-closure operator handoff

Preparation date: 2026-10-28Z
Repository: `ai-platform` on top of `296ea36` plus uncommitted remediation work
Scope: make the remaining Stage 1-6 gates executable and auditable. This
document contains **no** claims of new live verification. Nothing here has been
deployed, provisioned, restarted, or committed.

Companion documents:
- `docs/audit/STAGES_1-6_GATE_CLOSURE_TRACKER.md` (**authoritative work-package
  tracker and status**; its WP numbering supersedes the IDs in Section 9E below)
- `docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` (evidence and status)
- `docs/audit/STAGES_1-6_OPERATIONAL_READINESS_2026-10-26.md` (readiness)
- `docs/kubernetes-rollout.md` (procedures)
- `docs/backup-recovery.md` (SEC-20)

## 1. Executive summary

The latest pass improved static coverage: worker `Service` objects now exist for
all four workers, an opt-in Prometheus/Alertmanager stack is committed, a
monthly restore-drill CronJob produces the `restore_drill` row that
`AIRestoreDrillStale` depends on, the restore credential is separated from
`ai-api-secrets`, and three execution-discovered defects in the backup path were
fixed. Local validation is green.

Two categories of defect were found in *this* preparation pass, both invisible
to the existing validators:

1. **Two monitoring path defects (fixed).** `default-deny` applies per
   direction. Prometheus was permitted egress to Alertmanager but Alertmanager
   had **no ingress** allow rule, so alerts were dropped at the destination. A
   second pass found the mirror-image gap: Alertmanager had **no egress** rule
   either, so even a real receiver's webhook would be dropped. Both are fixed,
   and the validator now checks all three legs (Prometheus egress, Alertmanager
   ingress, Alertmanager notification egress) with each one mutation-tested.
2. **A SEC-19 gate integrity defect (fixed).** `tests/test_db_roles.py` skips 14
   tests and pytest exits **0**, so a green run could be read as role-separation
   evidence when nothing executed. `verify-db-roles.sh` now sets
   `AI_REQUIRE_ROLE_DB=1`, which turns a missing DSN into a hard failure (exit 1).
3. **A test-coverage finding (resolved, not a defect).** The single skipped
   backup test is an end-to-end live backup/verify/encrypt test. It is not
   redundant with the unit tests, and it passes in this environment when
   explicitly enabled.

No blocker moved to a closed state. SEC-19 remains **BLOCKED**, port 8000
exposure remains **OPEN**, alert delivery remains **OPEN**, live rollout and
scraping remain **NOT RUN**, production recoverability remains **OPEN**, and CI
remains **PARTIALLY VERIFIED**. The final decision remains **NO-GO** for Stage 7
and production.

## 2. Blocker status (evidence-based)

| # | Gate | Status | Evidence basis | What would close it |
|---|---|---|---|---|
| G1 | SEC-19 role separation | **BLOCKED** | `provision_roles.sql` refuses as non-superuser; `pg_roles` has 0 `ai_*` roles; `schema_migrations` max is `0018`; `verify-db-roles.sh` exits 2 (no DSNs) | 7 roles created, 0019 applied (19 rows), 14 role tests executed as real roles |
| G2 | Port 8000 containment | **OPEN** | Stale pid 23284 listens `0.0.0.0:8000`; anonymous `/metrics`, `/api/v1/ai/docs`, `/api/v1/ai/openapi.json` all 200 from non-loopback interfaces; `/events` and `/agents` 401 | External reachability removed and re-probed, or signed time-boxed risk acceptance |
| G3 | Alert delivery | **OPEN** | Receiver is `unconfigured` with no integration; nothing deployed; ingress gap (found here) fixed in source only | Live stack + real receiver + test alert receipt |
| G4 | Live Kubernetes rollout / scrape | **NOT RUN** | No cluster access in this environment; all evidence is static | Rollout witnesses + `/api/v1/targets` all `up` |
| G5 | Production recoverability | **OPEN** | No off-site copy, no object lock, no KMS/escrow, no production-scale drill, no approved RPO/RTO | See Section 7 |
| G6 | Node CI gate | **PARTIALLY VERIFIED** | Workflow defined; local shard 0 previously 151 passed; never executed in GitHub Actions | One green PR run with 12/12 shards |
| G7 | Worker HA | **OPEN** | Single replica; no lease/atomic claim | Two-replica soak with duplicate-claim proof |
| G8 | Cleanup approval | **PARTIALLY VERIFIED** | Dry-run only; 5 drill DBs/buckets and artifacts still present | Operator-approved `cleanup --execute` |

## 3. Operator handoff - port 8000 containment

**Constraints for this pass: do not stop, restart, signal, or reconfigure pid
23284 or pid 5865. Do not change firewall rules.** The steps below are for an
authorized operator, not for the agent.

### 3.1 Revalidate current state (read-only, safe to run now)

```bash
ss -ltnp | grep -E ':8000|:3001'
ps -o pid,user,etime,cmd -p 23284,5865
for ip in $(hostname -I); do
  curl -s -o /dev/null -w "$ip metrics=%{http_code}\n" --max-time 4 "http://$ip:8000/metrics"
done
```

Expected (matches this pass): `0.0.0.0:8000` and `0.0.0.0:3001`; `200` on every
non-loopback address for `/metrics`; `200` for `/api/v1/ai/docs` and
`/api/v1/ai/openapi.json`; `401` for `/api/v1/ai/events` and
`/api/v1/ai/agents`.

### 3.2 Choose a reversible containment

In order of preference, all reversible:

1. **Preferred - rebind to loopback.** Restart the API with the loopback host
   passed **on the command line** (`python3 -m uvicorn ai_api.main:app --host
   127.0.0.1 --port 8000`) or through the module entrypoint
   (`AI_API_HOST=127.0.0.1 python3 -m ai_api.main`). Do **not** rely on an
   `AI_API_HOST` variable in front of the `uvicorn` CLI: the CLI is a click
   command with `auto_envvar_prefix="UVICORN"`, so it reads `UVICORN_HOST` and
   ignores `AI_API_HOST`; the old instruction would silently keep `0.0.0.0`.
   `settings.py:243` and `docs/configuration.md` default the setting to `0.0.0.0`
   (`settings.py` only applies it via `main()`), and the captured process args
   carry `--host 0.0.0.0`, so replaying the old command reproduces the exposure.
   Use the current working tree so metrics auth and docs gating apply. Rollback:
   restore the previous command line and restart.
2. **Host-level packet filter** scoped to `:8000` on non-loopback interfaces,
   with an explicit allow for the monitoring source. Rollback: delete the rule
   by reference. Record the exact rule text before applying.
3. **Time-boxed risk acceptance** (Section 3.4) if neither can be scheduled.

Do **not** treat "the process is old" as containment. The exposure is the
binding, not the age.

### 3.3 Verify containment

```bash
# External anonymous access must be denied
for ip in $(hostname -I); do
  curl -s -o /dev/null -w "$ip metrics=%{http_code}\n" --max-time 4 "http://$ip:8000/metrics"
done
curl -s -o /dev/null -w "docs=%{http_code}\n" "http://<external-ip>:8000/api/v1/ai/docs"
curl -s -o /dev/null -w "openapi=%{http_code}\n" "http://<external-ip>:8000/api/v1/ai/openapi.json"

# Legitimate authorized monitoring must still work
curl -s -o /dev/null -w "loopback metrics anon=%{http_code}\n" http://127.0.0.1:8000/metrics
curl -s -o /dev/null -w "loopback metrics bearer=%{http_code}\n" \
  -H "Authorization: Bearer $AI_METRICS_AUTH_TOKEN" http://127.0.0.1:8000/metrics
```

Expected after containment: external `metrics`/`docs`/`openapi` no longer 200
(connection refused or filtered); loopback anonymous `/metrics` is 401 for the
current build; loopback with a valid bearer is 200. If loopback anonymous
returns 200, the process is still the pre-auth build and the containment did not
address the drift - restart from the working tree.

### 3.4 Time-boxed risk-acceptance template

Risk acceptance is **not** technical remediation and must not be recorded as
"closed".

| Field | Value |
|---|---|
| Risk | Unauthenticated anonymous access to `/metrics`, Swagger UI and full OpenAPI schema on `<host>:8000` |
| Scope | Non-loopback interfaces listed in Section 3.1 only |
| Data exposed | Bounded operational telemetry labels and API schema; no tenant/document/prompt content observed |
| Accepted by | `<name, role>` |
| Justification | `<why containment cannot be scheduled>` |
| Compensating control | `<e.g. host reachable only from a trusted network segment>` |
| Expires | `<absolute UTC timestamp>` (must be time-limited) |
| Re-review trigger | Any new endpoint exposure, or expiry |

## 4. DBA execution checklist - SEC-19

Steps marked **[ELEVATED]** require superuser or equivalent DBA authority and
must be executed by the DBA, not the application roles.

1. **[ELEVATED] Pre-flight.** Confirm none of `ai_owner`, `ai_system_access`,
   `ai_api`, `ai_worker`, `ai_backup`, `ai_restore`, `ai_migrate` exist, and
   record `SELECT max(version) FROM ai.schema_migrations;` (currently `0018`).
2. **[ELEVATED] Provision roles** in a single transaction:
   `psql --single-transaction -v ON_ERROR_STOP=1 -d helix -f infrastructure/db/roles/provision_roles.sql`
   The script itself refuses to run without superuser.
3. **[ELEVATED] Verify role attributes.** Expect `NOSUPERUSER`, `NOBYPASSRLS`,
   `NOINHERIT`, `NOCREATEROLE` for all; only `ai_restore` has `CREATEDB`;
   `ai_system_access` and `ai_owner` are `NOLOGIN`.
4. **[ELEVATED] Verify membership.** `ai_owner` and `ai_migrate` are members of
   `ai_system_access`; `ai_api` is **not**; `ai_worker`, `ai_backup`, `ai_restore`
   are.
5. **[ELEVATED] Verify ownership.** All `ai` schema tables/sequences/views/
   functions/types are owned by `ai_owner`; no runtime role owns a table.
6. **[ELEVATED] Verify grants.** `ai_api`/`ai_worker` have CRUD on tables and
   sequence usage with `schema_migrations` and `backup_runs` revoked; `ai_api`
   has `SELECT` on `backup_runs` only; `ai_backup` is read-only plus
   `backup_runs` insert/update; `ai_restore` has DML plus `CREATE` on the schema.
7. **[ELEVATED] Set passwords out-of-band** for the five LOGIN roles through the
   secret manager. Never paste them into tickets, chat, or the repository.
8. **[ELEVATED] Apply migration 0019 through the normal migration runner**
   (`AI_DB_ROLE_PROFILE=migrate AI_MIGRATION_DB_USER=ai_migrate
   AI_MIGRATION_ROLE=ai_owner bash scripts/migrate.sh`), not raw `psql -f`; raw
   `psql` applies the SQL but writes no `schema_migrations` row, so the 19-row
   check in the next sentence would fail. It fails closed if any role is missing,
   if `ai_owner` is not a member, or if `ai_api` is a member. Expect 19 rows in
   `ai.schema_migrations`.
9. **Confirm FORCE RLS** on all 43 protected tables (was verified in the
   pre-SEC-19 database as owner; re-confirm under the new ownership).
10. **Write the role DSNs** and run the actual-role suite:
    ```bash
    export AI_ROLE_API_DSN=... AI_ROLE_WORKER_DSN=... AI_ROLE_BACKUP_DSN=... \
           AI_ROLE_RESTORE_DSN=... AI_ROLE_MIGRATE_DSN=...
    bash scripts/verify-db-roles.sh
    ```
    Expect the 14 DB-role tests to run and pass (currently 14 skip because the
    DSNs are absent and `verify-db-roles.sh` exits 2).
11. **Cross-tenant denial.** As `ai_api`, a cross-tenant read and write must be
    denied **and** must not be bypassed by `set_config('ai.system_access','on')`.
12. **Readiness behaviour.** `/readyz` returns 200 with the correct role and 503
    on a deliberate `AI_DB_EXPECTED_ROLE` mismatch.

Rollback: roles are additive; the migration is a `CREATE OR REPLACE FUNCTION`
plus grants. To roll back 0019, restore the pre-0019 function definition from
`0018` and re-grant. Do not drop roles while workloads reference them.

**SEC-19 stays BLOCKED until step 10 passes with real role identities.**

## 5. Monitoring deployment and end-to-end alert verification

Enabling monitoring is a **separate operator decision**. It is not part of
`overlays/production` and creates a namespace, a PVC and two Deployments.

### 5.1 Pre-flight (safe, static)

```bash
python3 scripts/validate-k8s.py
python3 scripts/validate-monitoring.py
bash scripts/check-prometheus-configs.sh
```

Expected: `50 documents in 31 files`; `OK (rules, scrape jobs, routes, network
path)` with one WARN about the inert receiver; `Prometheus/Alertmanager configs
OK`. The network-path check exists because the ingress gap described in
Section 1 would otherwise go unnoticed.

### 5.2 Deploy (operator, in a non-production cluster first)

```bash
AI_NAMESPACE=enterprise-ai ./scripts/k8s-monitoring-config.sh
kubectl apply -k infrastructure/kubernetes/monitoring
kubectl -n observability rollout status deploy/prometheus --timeout=180s
kubectl -n observability rollout status deploy/alertmanager --timeout=180s
```

The script copies `AI_METRICS_AUTH_TOKEN` server-side into `ai-metrics-token`
and refuses to run if the source key is empty.

### 5.3 Ordered verification

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Pods ready | `kubectl -n observability get pods` | prometheus and alertmanager `Running`, ready |
| 2 | Config mounted | `kubectl -n observability exec deploy/prometheus -- ls /etc/prometheus /etc/prometheus/rules /etc/prometheus/metrics` | `prometheus.yml`, `backup-alerts.yml`, `metrics-token` |
| 3 | Rules loaded | `curl -s localhost:9090/api/v1/rules` (via port-forward) | 5 rules, health `ok` |
| 4 | Targets | `curl -s localhost:9090/api/v1/targets` | `ai-api` and the 4 worker targets `up` |
| 5 | API scrape auth | scraped `up` for `ai-api` | 200 with bearer; a `401` in the Prometheus log means the Secret token does not match |
| 6 | Worker scrape auth | scraped `up` for each worker | 4/4 `up` |
| 7 | Alertmanager reachable | `curl -s localhost:9090/api/v1/alertmanagers` | one active Alertmanager |
| 8 | Network policies present | `kubectl -n observability get networkpolicy` | includes `allow-alertmanager-ingress` **and** `allow-alertmanager-egress` |
| 9 | Synthetic alert | `promtool` style rule or temporarily set `expr: vector(1)` in a scratch rule | appears in Alertmanager UI |
| 10 | Receiver | replace `unconfigured`, re-run the config script, roll Alertmanager | test alert receipt captured |
| 11 | Real rule path | force a failing backup, or query `ai_backup_last_run_status` | `AIBackupFailed` fires and is delivered |

Retain: `kubectl get pods -o yaml` (redact), the `/api/v1/targets` and
`/api/v1/rules` JSON, and the receiver receipt. Alert delivery is **OPEN** until
step 10 and 11 both produce receipts.

Worker metrics require `AI_METRICS_AUTH_TOKEN` in the worker environment; the
workers read it through `ai-api-secrets` `envFrom`, and the same value is
projected into Prometheus. A 503 from `/metrics` means the token is empty in the
workload, which is a configuration failure, not a network failure.

## 6. Scheduled restore-drill verification

The CronJob is `0 6 1 * *` UTC, `concurrencyPolicy: Forbid`,
`activeDeadlineSeconds: 7200`, `backoffLimit: 1`, SA `ai-backup`
(`automountServiceAccountToken: false`), and `args: ["drill"]`. It shares the
`ai-backup-data` PVC and the advisory lock with the daily backup at 02:15.

Four things must be evidenced **separately**; they are routinely conflated:

1. **A successful manual drill** - `backup_restore.py drill` exits 0 and the
   report says `"result": "success"`.
2. **A scheduled Job** - the CronJob actually created a Job and it completed.
3. **A database record** - `SELECT * FROM ai.backup_runs WHERE kind =
   'restore_drill' ORDER BY started_at DESC LIMIT 1;` is `succeeded`.
4. **A delivered alert** - `AIRestoreDrillStale` either fires when the row is
   missing/old, or is absent after a fresh success, and the transition is
   observed in Alertmanager.

Safe isolated execution (never against production or shared resources):

```bash
# 1. Dry-run: confirm the target names and that nothing is deleted.
python3 scripts/backup_restore.py drill --artifact <run-id>
# 2. Inspect the report under $BACKUP_DIR/restore-drills/.
# 3. Cleanup is a separate, approved action.
python3 scripts/backup_restore.py cleanup \
  --target-db ai_restore_drill_<ts> --confirm-target ai_restore_drill_<ts> \
  --target-bucket ai-knowledge-restore-drill-<ts> --confirm-bucket ai-knowledge-restore-drill-<ts>
```

Expect the cleanup dry-run to print `"executed": false`. Deletion requires
`--execute` and explicit approval (Section 9).

Known constraints to state in the evidence: the drill restores into an isolated
database on the **same** PostgreSQL server (no separate physical cluster), and
the drill does not run `--start-app`/`--run-workers` because the backup image
does not contain the application package. Both are recorded deviations in the
report.

## 7. Node CI PR checklist

- Expected shard plan: **12 shards with a derived width**, not a frozen count. The
  `enterprise-node-coverage` guard computes `per_shard = ceil(total/12)` from the
  live file count and fails if the plan does not cover every file. At 162 files
  that is 12 shards of 14 with an 8-file final shard (was `12 x 13 = 156`).
- PostgreSQL: **`postgres:16`** service container, health-gated on `pg_isready`.
- Per-shard timeout: **75 minutes**; shard 2 was measured near **42 minutes**
  locally, which is inside the cap but leaves limited headroom on slower runners.
- Artifacts: `node-shard-<n>.log` for all 12 shards, uploaded with
  `if-no-files-found: error`.
- Failure behaviour: `fail-fast: false`, so all 12 shards report; a shard that
  selects the wrong number of files fails immediately with an `::error::`.
- What must be verified in a real PR run: 12/12 shards green; the coverage guard
  green; all 12 artifacts present; per-shard durations recorded; total runtime
  under the 75-minute per-shard ceiling.
- Local safe check already done: `server/tests/*.test.js` = 162 files, the
  partition was simulated in **bash** (0 overlap, 0 uncovered), and the
  manifest/monitoring jobs were validated locally. A local run, however green,
  is not the hosted workflow.

Keep CI **PARTIALLY VERIFIED** until a real GitHub Actions run exists. Do not
create a PR from this environment.

## 8. Live rollout and rollback checklist

1. Pre-flight: `validate-k8s.py`, `validate-monitoring.py`,
   `check-prometheus-configs.sh`, `kustomize build` + `kubeconform` for base,
   production and monitoring (all currently pass locally).
2. Confirm secrets exist out-of-band: `ai-api-secrets`, `ai-restore-secret`
   (never the placeholder), and a non-empty `AI_METRICS_AUTH_TOKEN` (>= 32 chars).
3. Verify `ai_restore` is not reachable from serving pods: no deployment other
   than the drill CronJob may mount `ai-restore-secret`, and `ai-api-secrets`
   must not contain the restore password.
4. Apply in order: namespace/config/SA -> migration Job -> API/workers/web ->
   monitoring (separate decision).
5. Observe: `/readyz` 200 on all API replicas; `ai-api` and 4 workers `up` in
   Prometheus; no `system`-scope errors in logs.
6. Two-replica soak: run the API at 2+ replicas and prove no duplicate event
   claim and no duplicate worker action. Worker HA is currently **OPEN**; until
   a lease or atomic claim exists, keep a single worker replica.
7. Rollback: `kubectl rollout undo deploy/ai-api` (and each worker), retain the
   previous ReplicaSet, and re-check `/readyz` and targets. Record the revision
   numbers before and after.

## 9. Required human decisions and approvals

| ID | Decision | Role | Why it cannot be automated |
|---|---|---|---|
| D1 | Approve a SEC-19 maintenance window and DBA execution | DBA + platform owner | Requires superuser and a change window |
| D2 | Approve port 8000 containment method, or sign a time-boxed acceptance | Security lead + infra on-call | Alters a running service / host policy |
| D3 | Approve enabling the monitoring stack and choose the real receiver | SRE + security | Creates cluster resources and a notification path |
| D4 | Approve RPO and RTO targets | Business owner | Not documented in the repository; must not be invented |
| D5 | Approve off-site/object-lock/KMS design and key escrow | Security architect + DBA | Procurement and key-custody decision |
| D6 | Approve cleanup of the 5 drill databases and 5 drill buckets, plus the artifacts listed in WP-8 | Platform owner | Destructive and irreversible |
| D7 | Approve a PR run of the Node CI matrix | Repo maintainer | CI runs on push/PR only |

No owners or dates are assigned here beyond the roles already named in
`docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md`; those role labels
are the repository's existing vocabulary, not new appointments.

**Decision-ID note:** the IDs in this section are the handoff's own and do not
all match `docs/audit/STAGES_1-6_GATE_CLOSURE_TRACKER.md` Section 7. The tracker
is authoritative. Mapping for the rows that differ: handoff D4 (RPO/RTO) =
tracker D5; handoff D5 (off-site/KMS) = tracker D6; handoff D6 (cleanup) =
tracker D7; handoff D7 (CI PR) = tracker D4. D1, D2 and D3 keep their meaning.
`docs/audit/STAGES_1-6_OPERATOR_EXECUTION_PACK_2026-10-28.md` Section 0.2
carries the same table for operators.

## 9A. WP-6 - restore identity and secret delivery

| Requirement | Repo state | Operator action |
|---|---|---|
| Dedicated `ai_restore` login, `CREATEDB`, `NOSUPERUSER`, `NOBYPASSRLS` | In `provision_roles.sql` | Create in WP-2; not yet present |
| Credential isolated from serving workloads | `restore-secret.example.yaml` is a separate `ai-restore-secret`; only the drill CronJob mounts it | Create the real Secret out-of-band; never add the key to `ai-api-secrets` |
| No serving pod can create databases | Verified: the only references to `ai-restore-secret` are the CronJob, the example and the README | Re-verify after any manifest change |
| Restore role cannot read the source schema to bypass RLS | `_verify_restore_role` probes the maintenance DB and passes `allow_owns_ai_tables=False` | Confirm in WP-2 that `ai_restore` owns no `ai` table |

Verification (read-only, safe to run now):

```bash
grep -rln "ai-restore-secret" infrastructure/kubernetes/    # expect CronJob + example + README
grep -n "AI_RESTORE" infrastructure/kubernetes/base/secret.example.yaml   # expect no match
```

Expected: no serving Deployment, Job or worker references the restore Secret,
and the shared `ai-api-secrets` example carries no restore password.

## 9B. WP-8 - cleanup inventory (no deletion authorised)

Verified against the live environment in this pass. Two backup roots are in
use: `/backup` (tool default) and `/tmp/sec20-backups` (the SEC-20 evidence
set). Deleting from one root does not affect the other.

**Drill databases (5, all present, ~12 MB each):**
`ai_restore_drill_20261025_072800`, `_20261025_080325`, `_20261026_043531`,
`_20261026_102324`, `_20261026_103451`.

**Drill buckets (5, all present):**
`ai-knowledge-restore-drill-20261025072800`, `-20261025080325`, `-20261026043531`,
`-20261026102324`, `-20261026103451`.

**Artifacts under `/backup/artifacts` (3, unencrypted, investigation only):**
`20261026T043506Z-b17e1e`, `20261026T043531Z-7e38f8`, `20261026T113945Z-3dd431`.

**Artifacts under `/tmp/sec20-backups/artifacts` (4):**
`20261025T072401Z-a2072e`, `20261025T072631Z-e385a9`, `20261025T080235Z-b5abbe`,
`20261026T103104Z-3e8513`.

**DO NOT DELETE (active evidence set):**
- `20261026T103104Z-3e8513` - current verified encrypted recovery point.
- `drill-20261026T103451Z-6ae044.json` - current drill report.
- Everything under `docs/audit/evidence/`.
- `ai_restore_drill_20261026_103451` and its bucket while the current SEC-20
  report is retained (dropping them is recoverable from `3e8513`, but it would
  invalidate the "current drill" claim).
- `20261025T080235Z-b5abbe` and drill `f9099b`/`82f76b` while the 2026-10-25
  report is retained: `b5abbe` verifies but predates the RLS migration.

Recovery implications: dropping a drill database or bucket is recoverable from
the artifact it was built from, **provided** that artifact is retained. Deleting
an artifact is **irreversible**; the source database is unaffected, but the
ability to re-verify that specific point-in-time is lost permanently.

Per-item procedure (dry-run first; `--execute` only after written approval):

```bash
python3 scripts/backup_restore.py cleanup \
  --target-db ai_restore_drill_<ts> --confirm-target ai_restore_drill_<ts> \
  --target-bucket ai-knowledge-restore-drill-<ts> --confirm-bucket ai-knowledge-restore-drill-<ts>
```

The command refuses names that do not start with the drill prefixes, so it
cannot drop the source database. Dry-run prints `"executed": false`.

## 9C. WP-9 - production recoverability decisions

Each row needs a human decision; no numeric target is proposed here.

| Capability | Current state | Decision needed |
|---|---|---|
| RPO | Not approved; the tool text says `<= 24h` but that is not an approved target | Business continuity owner sets the target |
| RTO | Not approved; only dev-scale timings exist (51.7 s drill / 16.2 s restore) | Business continuity owner sets the target |
| Off-site copy | None | Approve destination, credentials, and transfer mechanism |
| Immutable retention | None; no object lock | Approve retention period and immutability mechanism |
| KMS / key custody | Passphrase in a Secret only | Approve KMS, key rotation, and escrow |
| Key recovery | Undocumented | Approve an escrow and recovery drill; losing the passphrase makes encrypted artifacts unrecoverable |
| Production-scale drill | Not run | Approve a window and a production-sized isolated target |
| Scheduled drill + notification | CronJob exists; never executed; receiver inert | Coupled to WP-4 and WP-5 |

## 9D. WP-10 - worker HA requirements

Current state (from `docs/WORKER_DEPLOYMENT.md` and the manifests): all four
workers run **one replica**; only the agent worker has `FOR UPDATE SKIP LOCKED`
claim plus lease/generation fencing.

| Worker | Claim mechanism | Safe to scale now? | Required before scaling |
|---|---|---|---|
| `ai-event-consumer` | Per-`(event, group)` delivery rows, no atomic claim | No | Atomic claim or advisory lock; duplicate-delivery test |
| `ai-reconciler` | No global lease | No | Advisory lock or lease; overlapping-run test |
| `ai-indexer` | Job lease exists; queued selection not atomic | No | Atomic job selection; duplicate-index test |
| `ai-agent-worker` | `SKIP LOCKED` + lease/generation fence | After soak | Two-replica soak with reclaim test |

Two-replica soak acceptance: scale one worker to 2 replicas, run a workload that
forces a claim race and a mid-flight pod kill, and prove no item is processed
twice, no item is stranded past its lease, and the fencing token rejects a
stale writer. Retention: keep worker logs for the soak window. Do not scale any
worker in this pass.

## 9E. Dependency-aware execution order

**Numbering note:** the WP IDs in this section are the legacy ones. Some of them
differ from `docs/audit/STAGES_1-6_GATE_CLOSURE_TRACKER.md`, which is
authoritative. Mapping: legacy WP-3 (rollout) = tracker WP-6; legacy WP-7 (CI) =
tracker WP-3; legacy WP-8 (cleanup) = tracker WP-9; legacy WP-9 (recoverability)
= tracker WP-7; legacy WP-10 (worker HA) = tracker WP-8. WP-1, WP-2, WP-4 and
WP-5 keep their numbers. Each step below names the work, so the ID cannot
mislead.

Adjust only where repository evidence shows a real dependency; none was found
that changes this order.

1. Contain the port 8000 exposure (WP-1) - time-critical, independent of all
   other work.
2. Assign the observability owner and approve the monitoring architecture
   (D3) - a decision, not a deployment.
3. Obtain a green full GitHub Actions run (WP-7) - proves the code gate before
   any change window.
4. Schedule and execute SEC-19 (WP-2) - depends on D1 and step 3.
5. Verify actual-role isolation and readiness (WP-2 evidence) - closes G1.
6. Deploy monitoring and verify real delivery (WP-4) - depends on step 2 and
   benefits from step 5 because `ai_restore`/worker roles must exist for the
   worker targets to be meaningful.
7. Execute the scheduled restore drill and verify row + alert (WP-5) - depends
   on steps 4-6.
8. Live rollout and rollback (WP-3) - depends on step 4 (roles) and step 3 (CI).
9. Approve RPO/RTO and implement recovery controls (WP-9) - depends on step 7.
10. Verify worker HA before scaling (WP-10) - depends on step 8.
11. Resolve cleanup items individually (WP-8) - after step 7 evidence is filed.
12. Independent re-audit (Section 12).


## 10. Files changed in this preparation pass

| File | Change |
|---|---|
| `infrastructure/kubernetes/monitoring/networkpolicy.yaml` | Added `allow-alertmanager-ingress` and `allow-alertmanager-egress`; corrected the header comment |
| `scripts/validate-monitoring.py` | Added `check_networkpath()` covering all three legs, each mutation-proven |
| `apps/ai-api/tests/test_db_roles.py` | Added `AI_REQUIRE_ROLE_DB` fail-closed mode |
| `scripts/verify-db-roles.sh` | Exports `AI_REQUIRE_ROLE_DB=1` so a skipped run cannot pass |
| `docs/kubernetes-rollout.md` | Corrected validation counts (49 docs, monitoring 11/11) |
| `docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` | Counts, live-test result, Section 7.2.1 defect record |
| `docs/audit/STAGES_1-6_OPERATIONAL_READINESS_2026-10-26.md` | Corrected validation counts |
| `infrastructure/kubernetes/README.md` | Corrected validation counts |
| `docs/audit/STAGES_1-6_GATE_CLOSURE_HANDOFF_2026-10-28.md` | New: this handoff |

No manifest was applied, no service restarted, nothing committed.

## 11. Test results

### Newly executed in this pass

| Check | Command | Result |
|---|---|---|
| Manifest structure | `python3 scripts/validate-k8s.py` | `50 documents in 31 files`, exit 0 |
| Monitoring structure | `python3 scripts/validate-monitoring.py` | OK + 1 expected WARN, exit 0 |
| Network-path regression (mutation) | delete ingress rule / delete egress rule / delete notification egress, re-run each | exit 1 each, distinct correct error |
| SEC-19 skip-is-not-a-pass | `AI_REQUIRE_ROLE_DB=1 pytest tests/test_db_roles.py` | exit 1, 14 errors |
| Prometheus/Alertmanager configs | `scripts/check-prometheus-configs.sh` (promtool 2.53.5, amtool 0.27.0) | 5 rules; both configs valid; 1 receiver; exit 0 |
| Render/schema | kustomize v5.5.0 + kubeconform v0.6.7 | 34/34, 34/34, 11/11 valid; 0 invalid |
| Backup/restore unit suite | `pytest -o addopts="" -q tests/test_backup_restore.py` | 24 passed, 1 skipped in 0.14s |
| Live backup/verify/encrypt | same test with `AI_TEST_BACKUP=1` | **1 passed in 9.17s** |
| Ruff | `ruff check src tests scripts` | clean |
| Whitespace | `git diff --check` | clean |
| SEC-19 role gate | `scripts/verify-db-roles.sh` | exit 2, no DSNs (fail-closed) |
| Role presence | `SELECT ... FROM pg_roles WHERE rolname LIKE 'ai\_%'` | 0 rows |

### Historical (not re-executed here)

- Node shard 0: 151 passed / 1,181.2s (2026-10-27).
- Node shard 2 duration estimate ~42 minutes.
- Full 1,932-test Node suite: reported 2026-10-26.
- Full Python suite: reported 2026-10-26.
- SEC-20 encrypted drill: 21/21 checks, 43 FORCE RLS tables (2026-10-26).

### The skipped test - assessment

`test_live_backup_and_verification` is skipped unless `AI_TEST_BACKUP=1`. It is
the **only** test that exercises real `pg_dump` -> encrypt -> `pg_restore -l` ->
manifest checksum end-to-end; the unit tests mock or isolate those boundaries.
It is therefore release-relevant, not incidental. It passes here against the
local development database, and it does not mutate the source database. It is
still not a substitute for the SEC-19 or production-scale gates. Recommendation:
keep it opt-in in the hermetic CI job, and add it to the release checklist as an
explicit operator-run step.

## 12. Independent re-audit checklist

An independent reviewer should confirm, without trusting this document:

1. `git status` shows the real change set; no unexpected deletions or resets.
2. `pg_roles` still has 0 `ai_*` roles and `schema_migrations` max is `0018`, so
   SEC-19 is still BLOCKED, not silently provisioned.
3. `ss -ltnp` still shows `0.0.0.0:8000`, and an off-host `curl` to `/metrics`
   still returns 200, so containment is still OPEN.
4. `alertmanager.yml` still has a receiver with no integration.
5. `kubectl` is still unavailable / no live cluster evidence exists, so rollout
   and scraping are NOT RUN.
6. `monitoring/networkpolicy.yaml` contains `allow-alertmanager-ingress` and `allow-alertmanager-egress`, and each
   deleting it makes `validate-monitoring.py` exit 1.
7. Re-run all six local validators and compare exit codes and counts (49 docs,
   34/34, 34/34, 11/11).
8. Confirm the `.github/workflows/ai-platform-ci.yml` shard math still covers the
   live file count via the derived width (`ceil(total/12)`, currently 162 files ->
   12 x 14 with an 8-file final shard) and that no PR has been opened from this
   work.
9. Confirm no credentials appear in any changed file or in this handoff.
10. Re-read the final decision and confirm it is still NO-GO.

## Final decision

**NO-GO for Stage 7 and production.** No gate moved to closed in this pass.
What changed is that the remaining work is now executable and auditable, and one
latent alerting defect that would have produced a false "alerts configured" claim
is fixed in source with a regression test.
