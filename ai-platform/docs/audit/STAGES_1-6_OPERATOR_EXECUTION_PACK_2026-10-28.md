# Stages 1-6 operator execution pack — 2026-10-28

Companion to `docs/audit/STAGES_1-6_GATE_CLOSURE_TRACKER.md`, which remains the
single authoritative tracker. This file adds nothing to gate status: it is the
operator-facing procedure for each work package. **The decision is still NO-GO
for production; Stage 7-10 are code complete but operationally ungated (see
tracker Section 10).**

Prepared from repository state at branch `postgres`, HEAD `296ea36`. No cluster
was contacted, no role was provisioned, no migration was applied, no backup or
drill was run, and no resource was deleted while writing this.

## 0. How to use this pack

1. Read the work package in the tracker first; it holds status and closure
   criteria. This pack holds the steps.
2. Obtain the approval named in that package's **Approval points** before
   running anything in its **Procedure**.
3. Copy each command block only after approval. Every block is labelled
   `NOT TO EXECUTE` — that label means *not yet approved for this environment*,
   not that the command is malformed.
4. File the evidence with an absolute UTC timestamp before requesting closure.
   A package with no filed evidence stays at its current status.

### 0.1 Hard guardrails for every package

These hold for the whole pack and are not repeated per package.

| Guardrail | Meaning |
|---|---|
| No deletion | Do not drop databases, buckets, artifacts, roles, or namespaces unless the package explicitly authorises that one item in writing |
| No silent identity change | Never connect a workload as a table owner, `ai_owner`, or a superuser to "make it work" |
| Preserve evidence | `docs/audit/evidence/`, `20261026T103104Z-3e8513`, `drill-20261026T103451Z-6ae044.json`, and the `_103451` drill database/bucket are never cleanup candidates |
| No fabrication | Owner **roles** are named; no individual names, approval dates, or expiry timestamps are invented here |
| Fail closed | A skipped test, an empty token, or a missing DSN is a failure, not a pass |
| Abort is a valid outcome | Any abort step below ends the window; it does not downgrade a gate |

### 0.2 Decision-ID reconciliation

The tracker and the handoff both use `D1`-`D7` but assign different meanings to
`D4`-`D7`. **Tracker IDs win.** Use the table below when cross-referencing.

| Tracker ID | Tracker meaning | Handoff §9 ID |
|---|---|---|
| D1 | DBA change window for SEC-19 | D1 |
| D2 | Contain port 8000, or time-limited exception | D2 |
| D3 | Monitoring architecture and real receiver | D3 |
| D4 | Authorized CI PR trigger | D7 |
| D5 | Approved RPO and RTO | D4 |
| D6 | Off-site, immutable backup, KMS/escrow | D5 |
| D7 | Individual cleanup approvals | D6 |

### 0.3 Evidence naming convention

`<WP>-<YYYYMMDDTHHMMZ>-<artifact>.<ext>` in `docs/audit/evidence/`, for example
`WP-2-20261102T090000Z-pg_roles.txt`. Redact passwords and bearer tokens before
filing. Add the file path and the ledger row to the tracker when the package is
assessed.

### 0.4 Corrections to the handoff carried into this pack

Three statements in the handoff and tracker are not supported by the repository
and are corrected here. They do not change any gate status.

| Claim | Repository fact | Effect on procedure |
|---|---|---|
| Handoff §3.2: `AI_API_HOST=127.0.0.1` is "the default in `settings.py`" | The default is `0.0.0.0` (`apps/ai-api/src/ai_api/config/settings.py:238`, `docs/configuration.md:333`, `.env.example`, `infrastructure/kubernetes/base/configmap.yaml:16`) | WP-1 must set `AI_API_HOST=127.0.0.1` **explicitly**; relying on a default does not contain the exposure |
| Handoff §9 decision table IDs | Tracker §7 uses a different mapping for D4-D7 | Use §0.2 above |
| Tracker WP-5 item 5c "NOT RUN" | `ai.backup_runs` holds 4 `succeeded` and 1 `failed` `restore_drill` rows, all manual | 5c is PARTIALLY VERIFIED (manual path proven, scheduled path not); tracker and §6 corrected |

## 1. Approval and sequencing overview

| Order | WP | Tracker status | Approval needed | Blocks |
|---|---|---|---|---|
| 1 | WP-1 Port 8000 containment | OPEN | D2 | WP-4 (target reachability) |
| 2 | WP-3 CI run | PARTIALLY VERIFIED | D4 | WP-2, WP-6 |
| 3 | WP-2 SEC-19 roles | BLOCKED | D1 | WP-5, WP-6 |
| 4 | WP-4 Monitoring delivery | OPEN | D3 | WP-5e |
| 5 | WP-5 Restore drill (5a-5e) | OPEN | D1 + WP-4 | WP-7, WP-9 |
| 6 | WP-6 Live rollout | NOT RUN | D1 + change window | WP-8 |
| 7 | WP-7 Production recoverability | OPEN | D5 + D6 | — |
| 8 | WP-8 Worker HA | OPEN | soak approval | — |
| 9 | WP-9 Cleanup | PARTIALLY VERIFIED | D7 per item | — |

WP-1 and WP-3 are intentionally first: both are independent of the DBA window
and both reduce the length of the highest-risk window.

**Urgency is not the same as execution order.** Tracker Section 9 ranks WP-2
ahead of WP-3 by urgency because the DBA window has the longest lead time. The
dependency graph (tracker Section 6: `WP3 --> WP2`) and handoff Section 9E
(step 3 green CI, then step 4 SEC-19) require the CI run to be green before the
role change is applied. Resolve this by **scheduling WP-2 early while executing
its role change after WP-3 is green**, not by running SEC-19 on a red or missing
CI run.

---

## 2. WP-1 — Port 8000 containment

**Status OPEN. Approval: D2. Blocks WP-4.** This is the only exposure reachable
from off-host today.

### 2.1 Prechecks (read-only, safe now)

```bash
# NOT TO EXECUTE until D2 is recorded
ss -ltnp | grep -E ':8000|:3001'
ps -o pid,user,etime,args -p 23284,5865
for ip in $(hostname -I); do
  curl -s -o /dev/null -w "$ip metrics=%{http_code}\n" --max-time 4 "http://$ip:8000/metrics"
done
curl -s -o /dev/null -w "loopback anon metrics=%{http_code}\n" http://127.0.0.1:8000/metrics
```

Expected baseline matches the tracker: `0.0.0.0:8000` and `0.0.0.0:3001`;
`200` on every non-loopback IP; loopback anonymous `/metrics` currently `200`.
That 200 means the process is serving an older module revision than the current
tree (the current source returns 401 in-process), not that the process predates
the auth files: pid 23284 started 2026-10-25 10:29 UTC, after `metrics_auth.py`
(2026-10-24) and the auth `main.py` (2026-10-25 07:12) were written. Confirm the
drift on the day of execution with the two discriminators in §2.1a.

Record the exact `args` line of pid 23284 before changing anything; it is the
rollback source.

### 2.1a Drift discriminators (read-only, safe now)

These prove whether the live process runs the current tree, independent of
`ps` start times:

```bash
# 1. Route-set drift: live vs current source path count.
curl -s http://127.0.0.1:8000/api/v1/ai/openapi.json \
  | python3 -c "import sys,json;print('live paths',len(json.load(sys.stdin)['paths']))"
cd /workspace/ai-platform/apps/ai-api
PYTHONPATH=src python3 -c \
  "from ai_api.main import create_app;print('source paths',len(create_app().openapi()['paths']))"

# 2. Auth drift: live anonymous /metrics vs current source in-process.
curl -s -o /dev/null -w "live anon metrics=%{http_code}\n" http://127.0.0.1:8000/metrics
PYTHONPATH=src python3 -c \
  "from fastapi.testclient import TestClient;from ai_api.main import create_app;print('source anon metrics',TestClient(create_app()).get('/metrics').status_code)"
```

Observed 2026-10-30: live 94 paths / anon 200; source 97 paths / anon 401. A
restart from the current tree is what closes that drift; do not file a restart as
"containment" unless the post-restart probe shows loopback anon `/metrics` 401.

### 2.2 Procedure — option A, loopback rebind (preferred)

```bash
# NOT TO EXECUTE until D2 is recorded
# 1. Capture the current command line verbatim into the evidence file.
ps -o args= -p 23284 > /tmp/wp1-before.args
# 2. Stop the process by its exact pid (operator action; never a pattern kill).
kill -TERM 23284
# 3. Relaunch from the current working tree on loopback only.
#    Use ONE of the two correct forms below. Do not copy the old
#    "AI_API_HOST=... python3 -m uvicorn ..." line: the uvicorn CLI does not
#    read AI_API_HOST, so that line would silently bind the old address.
cd /workspace/ai-platform/apps/ai-api
# Form 1 (explicit, recommended): pass --host on the CLI.
PYTHONPATH=src python3 -m uvicorn ai_api.main:app --host 127.0.0.1 --port 8000
# Form 2: go through the module entrypoint, whose main() reads Settings.
#         AI_API_HOST=127.0.0.1 PYTHONPATH=src python3 -m ai_api.main
```

**Why this matters (verified 2026-10-31).** `uvicorn` is a click command with
`auto_envvar_prefix="UVICORN"`, so the CLI honors `UVICORN_HOST`, not
`AI_API_HOST`. Empirical check: with `UVICORN_HOST=10.9.9.9` the resolved host is
`10.9.9.9`; with `AI_API_HOST=10.9.9.9` it stays `127.0.0.1` (the option default).
`AI_API_HOST` is only read by `Settings` (`settings.py:243`), which the
`python -m uvicorn` CLI path never constructs for binding — it is used by
`ai_api.main:main()` and by the app object, not by the CLI host option. The
previous `AI_API_HOST=127.0.0.1 <original entrypoint>` step therefore **would not
contain anything** if the original entrypoint was the `uvicorn` CLI, which it is
here (`--host 0.0.0.0` is in the captured args). Set `--host` explicitly or use
`python -m ai_api.main`.

The rebind must be explicit either way: uvicorn's own `--host` default is
`127.0.0.1`, but the captured command passes `--host 0.0.0.0`, so replaying the
captured args reproduces the exposure.

**Monitoring-leg caveat (repo fact).** `infrastructure/monitoring/prometheus/
prometheus.yml` scrapes the API at `host.docker.internal:8000` with a Bearer
`credentials_file`, and `compose.yaml` gives Prometheus
`extra_hosts: host.docker.internal:host-gateway`; from that container the API is
reached on the **docker bridge gateway** (observed `172.17.0.1`), not
`127.0.0.1`. No monitoring stack is deployed today (WP-4 is OPEN), so a loopback
rebind breaks no live scrape now. When WP-4 is deployed, its scrape target must
reach the API with the Bearer token after the rebind; record that as a WP-4
follow-up, not as an extra WP-1 blocker. The authorized leg of WP-1 is proven by
the loopback Bearer `curl` in §2.3, which is independent of whether Prometheus
is running. Do not treat the loopback `docs` 200 (development-only) as either
exposure or authorization.

Option B, if a restart cannot be scheduled: a host packet filter scoped to
`:8000` on non-loopback interfaces with an explicit allow for the monitoring
source. Record the exact rule text before applying; rollback is rule deletion by
reference.

Option C, if neither can be scheduled: the time-boxed risk acceptance in handoff
§3.4. That is **not** containment and must never be recorded as closed.

### 2.3 Verification

```bash
# NOT TO EXECUTE until D2 is recorded
for ip in $(hostname -I); do
  curl -s -o /dev/null -w "$ip metrics=%{http_code}\n" --max-time 4 "http://$ip:8000/metrics"
  curl -s -o /dev/null -w "$ip docs=%{http_code}\n" --max-time 4 "http://$ip:8000/api/v1/ai/docs"
done
curl -s -o /dev/null -w "loopback anon=%{http_code}\n" http://127.0.0.1:8000/metrics
curl -s -o /dev/null -w "loopback bearer=%{http_code}\n" \
  -H "Authorization: Bearer $AI_METRICS_AUTH_TOKEN" http://127.0.0.1:8000/metrics
```

Expected: every non-loopback address refused or filtered (no `200`) for **both**
`/metrics` and `/docs`; loopback anonymous `/metrics` **401**; loopback bearer
**200**.

Test `/docs` from a non-loopback address, not loopback. `api_docs_enabled`
returns true whenever `AI_ENV` is not `production`
(`apps/ai-api/src/ai_api/config/settings.py:379-385`), so on this development host
`/docs` stays `200` on loopback even after containment. That is expected; the
gate is about off-host reachability.

**Baseline captured 2026-10-31 04:13 UTC (pre-change, for comparison).**

| Probe | Before (current) | Expected after containment |
|---|---|---|
| 4 non-loopback IPs `/metrics` | 200 | refused/filtered |
| 4 non-loopback IPs `/docs`, `/openapi.json` | 200 | refused/filtered |
| loopback anon `/metrics` | **200** (stale build) | **401** (auth build) |
| loopback wrong bearer `/metrics` | **200** (stale build) | **401** |
| loopback valid bearer `/metrics` | 200 | 200 |
| `/healthz`, `/readyz` | 200 | 200 |
| live OpenAPI paths | 94 | 97 |
| `ss` bind | `0.0.0.0:8000` | `127.0.0.1:8000` |

**Exact post-change checklist, in order.** Every line must produce the stated
value; stop and roll back if any does not.

```bash
# 1. Bind address: must be 127.0.0.1:8000, not 0.0.0.0.
ss -ltnp | grep ':8000'          # expect 127.0.0.1:8000
# 2. New pid and start time (proves the restart actually happened).
ps -o pid,lstart,args -p <new-pid>
# 3. Host header matches loopback (binds to a name, not a port).
curl -s -o /dev/null -w "healthz=%{http_code}\n" http://127.0.0.1:8000/healthz   # 200
curl -s -o /dev/null -w "readyz=%{http_code}\n"  http://127.0.0.1:8000/readyz    # 200
# 4. Off-host reachability gone (all four must fail to connect / be filtered).
for ip in $(hostname -I); do
  curl -s -o /dev/null -w "$ip metrics=%{http_code}\n" --max-time 4 "http://$ip:8000/metrics"
done                             # no "metrics=200"
# 5. Auth build is actually live on loopback.
curl -s -o /dev/null -w "anon=%{http_code}\n"         http://127.0.0.1:8000/metrics                  # 401
curl -s -o /dev/null -w "wrong=%{http_code}\n" -H "Authorization: Bearer wrong" http://127.0.0.1:8000/metrics  # 401
curl -s -o /dev/null -w "bearer=%{http_code}\n" -H "Authorization: Bearer $AI_METRICS_AUTH_TOKEN" http://127.0.0.1:8000/metrics  # 200
# 6. Runtime now matches source (proves the drift is gone).
curl -s http://127.0.0.1:8000/api/v1/ai/openapi.json | python3 -c \
  "import sys,json;print('live paths',len(json.load(sys.stdin)['paths']))"      # 97
for p in /api/v1/ai/assistant/agents/run /api/v1/ai/knowledge/sources/1/acl; do
  curl -s -o /dev/null -w "$p=%{http_code}\n" -X POST "http://127.0.0.1:8000$p"
done                             # must NOT be 404 (route exists now)
```

Step 5 is the discriminator that separates "restarted into the auth build" from
"restarted the same stale build": if anon `/metrics` is still 200, the restart
did not pick up the current tree - abort and diagnose rather than filing closure.
Step 6 is the discriminator that the 94-vs-97 drift is resolved.

> Caution with `$AI_METRICS_AUTH_TOKEN`: read it from the environment or secret
> manager into the shell; never paste it into this file, a ticket, or a report.
> The token in `.env` is 23 characters, which is valid only because
> `AI_ENV=development`; a production/staging run requires >= 32 characters and
> would fail startup by design (`settings.py:353-360`).

If loopback anonymous `/metrics` still returns `200`, the running process is
still the old build — the restart did not pick up the auth code. Abort and
diagnose before filing anything.

### 2.4 Abort / rollback

```bash
# NOT TO EXECUTE until D2 is recorded
kill -TERM <new pid>
<restore original entrypoint from /tmp/wp1-before.args>
```

For option B, delete the recorded rule by reference. Rollback restores the
exposure; record that in the evidence so it is not mistaken for containment.

### 2.5 Evidence to file

`/tmp/wp1-before.args` contents, the before/after `curl` matrix, the new `ss`
output showing `127.0.0.1:8000`, and the `ps` timestamp proving the new pid
started after the change.

### 2.6 Approval points

- Before §2.1: record D2 (contain) — prechecks are read-only but capture live
  service state.
- Before §2.2: confirm the operator, the window, and the chosen option.
- Risk acceptance instead of containment: signed record with an **absolute UTC
  expiry** and a re-review trigger.

### 2.7 Closure criterion

Off-host anonymous access denied **and** authorized loopback bearer access
verified, or a signed exception with an absolute expiry. Tracker status changes
only with the filed evidence.

---

## 3. WP-3 — GitHub Actions CI

**Status PARTIALLY VERIFIED. Approval: D4.**

### 3.1 Prechecks (static, safe now)

```bash
# NOT TO EXECUTE until D4 is recorded
cd /workspace
ls .github/workflows/ai-platform-ci.yml
grep -n "shards=12\|per_shard=\|postgres:16\|timeout-minutes" .github/workflows/ai-platform-ci.yml
echo "test files: $(ls server/tests/*.test.js | wc -l)"
```

Expected: workflow present; `shards=12`, a derived `per_shard`, `postgres:16`,
`timeout-minutes: 75`. The shard width is computed from the live file count, so
the guard no longer hard-codes 13 files per shard. At the time of writing there
are 162 test files, giving 12 shards of 14 with an 8-file final shard; the guard
covers all files with 0 overlap and 0 uncovered. Verify the partition with
`bash`, not `zsh`: zsh array slicing differs and yields a false "162 per shard"
result. The guard job still fails closed if the derived plan does not cover every
file.

No repository secrets are required for this workflow. The Node shards use the
`postgres:16` service container with the ephemeral CI-only credential
`postgres/postgres` set inline in the workflow, and the only token used is the
implicit read-only `GITHUB_TOKEN` (`permissions: contents: read`). Do not add a
production DSN, `AI_METRICS_AUTH_TOKEN`, or any cloud credential to run it; if a
future change introduces a `secrets.*` reference, stop and review before
dispatching.

### 3.2 Procedure

Open an authorized PR (or dispatch the workflow) from a branch that includes the
current worktree. Do not create a PR from this environment.

```bash
# NOT TO EXECUTE until D4 is recorded
gh workflow run ai-platform-ci.yml --ref <approved-branch>
gh run list --workflow=ai-platform-ci.yml --limit 5
gh run watch <run-id>
```

### 3.3 Verification

```bash
# NOT TO EXECUTE until D4 is recorded
gh run view <run-id> --log
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion}'
gh run download <run-id> -D /tmp/wp3-artifacts
ls /tmp/wp3-artifacts
```

Expected: 12/12 shards `success`; `enterprise-node-coverage` `success`; 12
`node-shard-*.log` artifacts present; `manifests` and `monitoring-configs` jobs
green; every recorded shard duration under 75 minutes. Shard 2 has the least
headroom (projected ~42 minutes locally, never measured on the runner).

### 3.4 Abort / rollback

CI failure is not a rollback trigger by itself; it is a stop signal. Do not
proceed to WP-6 on a red or missing run, and do not "fix" a red run by removing
the coverage guard.

### 3.5 Evidence to file

Run URL, the 12 job conclusions, per-shard durations, the guard job output, and
the downloaded artifact listing.

### 3.6 Approval points

- D4 before dispatching or opening the PR.
- If the run is red, a fix requires a new review; do not re-trigger blind.

### 3.7 Closure criterion

One green full run on `postgres:16` with measured durations and retained
artifacts. A local run, however green, does not close it.

---

## 4. WP-2 — SEC-19 database role separation

**Status BLOCKED. Approval: D1. Blocks WP-5 and WP-6.** Longest lead time.

### 4.1 Prechecks (safe now, read-only)

```bash
# NOT TO EXECUTE until D1 is recorded
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -tAc \
  "select rolname from pg_roles where rolname like 'ai\_%' order by 1"
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -tAc \
  "select max(version) from ai.schema_migrations"
```

Expected baseline: **no rows** (0 `ai_*` roles); max version
`0018_tenant_row_level_security.sql`.

**Fail-closed gate: do not start §4.2 unless all of these hold.** Each is a
stop condition, not a warning.

```bash
# a. The provisioning identity is actually privileged. `helix` is NOT
#    (read-only check; expect rolsuper/t for the role you will use).
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -tAc \
  "select rolname, rolsuper, rolcreaterole from pg_roles where rolname=current_user"
# b. The ai helpers exist and will be re-owned (created by 0018).
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -tAc \
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ai' and proname in ('system_access','current_tenant_id','tenant_isolation_allows') order by 1"
# c. Nothing is mid-migration: a live migration Job or a non-empty lock wait.
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -tAc \
  "select count(*) from pg_stat_activity where state='active' and query ilike '%schema_migrations%'"
```

- (a) must show `rolsuper=t` / `rolcreaterole=t`. The observed `helix` role is
  `rolsuper=f, rolcreaterole=f`; running as `helix` would fail at the script's own
  superuser check. Use the `postgres` superuser (the only superuser observed) or
  an equivalent DBA role.
- (b) must return all three functions, or `provision_roles.sql` will error on its
  trailing `GRANT EXECUTE` (the helpers come from 0018).
- (c) must return `0`; `provision_roles.sql` transfers ownership and takes locks
  on every `ai` object, so it must not overlap a migration or a long write.
- Written confirmation from the DBA that there is no in-flight migration Job. If
  any check fails, stop and reschedule; do not "work around" by running as
  `helix` or by granting owner to a runtime role.

### 4.2 Procedure — DBA, in an approved window

Steps 1-8 require superuser or equivalent DBA authority. The provisioning
script refuses to run otherwise.

```bash
# NOT TO EXECUTE until D1 is recorded
# 1. Provision roles in one transaction (superuser; the script refuses otherwise).
psql --single-transaction -v ON_ERROR_STOP=1 -d helix \
  -f infrastructure/db/roles/provision_roles.sql

# 2. Apply the role-gate migration through the NORMAL RUNNER, not raw psql.
#    Raw `psql -f` applies the SQL but never inserts the schema_migrations row,
#    so the "19 rows" closure criterion in step 8 would fail. The runner records
#    version + checksum and is the documented path (roles README §3).
AI_DB_ROLE_PROFILE=migrate \
AI_MIGRATION_DB_USER=ai_migrate \
AI_MIGRATION_DB_PASSWORD='<from secret manager>' \
AI_MIGRATION_ROLE=ai_owner \
bash scripts/migrate.sh
```

On a **fresh install** the order is: run migrations with
`AI_MIGRATION_STOP_AFTER=0018_tenant_row_level_security.sql`, provision roles,
then rerun `migrate.sh` without the stop variable, then rerun
`provision_roles.sql` once more so grants cover any objects created in between
(roles README §Prerequisites). On an **existing** database already at 0018 (the
current `helix` case) skip the stop-variable step.

Then the checks the handoff §4 lists, in order:

| Step | Check | Expected |
|---|---|---|
| 3 | Attributes | All `NOSUPERUSER`, `NOBYPASSRLS`, `NOINHERIT`, `NOCREATEROLE`; only `ai_restore` has `CREATEDB`; `ai_owner`/`ai_system_access` are `NOLOGIN` |
| 4 | Membership | `ai_owner` and `ai_migrate` in `ai_system_access`; `ai_api` **not**; `ai_worker`, `ai_backup`, `ai_restore` in |
| 5 | Ownership | All `ai` objects owned by `ai_owner`; no runtime role owns a table |
| 6 | Grants | `ai_api`/`ai_worker` CRUD minus `schema_migrations`/`backup_runs`; `ai_api` `SELECT` on `backup_runs`; `ai_backup` read-only plus `backup_runs` insert/update; `ai_restore` DML plus schema `CREATE` |
| 7 | Passwords | Set out-of-band via the secret manager; never on a command line or in a ticket |
| 8 | Migration bookkeeping | 19 rows in `ai.schema_migrations` |
| 9 | RLS | `FORCE` RLS on all 43 protected tables under the new ownership |
| 10 | Role suite | 14/14 pass with real DSNs |
| 11 | Cross-tenant | `ai_api` cross-tenant read and write denied, not bypassed by `set_config('ai.system_access','on')` |
| 12 | Readiness | `/readyz` 200 with the right role, 503 on deliberate `AI_DB_EXPECTED_ROLE` mismatch |

Step 10:

```bash
# NOT TO EXECUTE until D1 is recorded
export AI_ROLE_API_DSN=... AI_ROLE_WORKER_DSN=... AI_ROLE_BACKUP_DSN=... \
       AI_ROLE_RESTORE_DSN=... AI_ROLE_MIGRATE_DSN=...
bash scripts/verify-db-roles.sh
```

`verify-db-roles.sh` exports `AI_REQUIRE_ROLE_DB=1`, so a missing DSN yields
exit 2 and a skipped test yields errors, never a pass.

### 4.3 Verification queries

```bash
# NOT TO EXECUTE until D1 is recorded
psql -d helix -c "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname like 'ai\_%' order by 1"
psql -d helix -c "select r.rolname, m.rolname as member_of from pg_auth_members am join pg_roles r on r.oid=am.member join pg_roles m on m.oid=am.roleid where r.rolname like 'ai\_%' order by 1,2"
psql -d helix -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ai' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity"
psql -d helix -tAc "select count(*) from ai.schema_migrations"
```

Expected: 7 roles with the attributes above; membership matching step 4; **43**;
**19**.

### 4.4 Abort / rollback

Abort if: 0019 fails; any runtime role has `rolsuper`, `rolbypassrls`, or
`rolcreaterole`; table count is not 43; `ai_api` ends up a member of
`ai_system_access`.

Rollback: 0019 is a `CREATE OR REPLACE FUNCTION` plus grants. Restore the
pre-0019 function from `0018` and re-grant. **Do not drop roles while workloads
reference them**, and do not re-grant `ai_owner` to a runtime role as a
shortcut.

Two recovery details the 0019 design makes safe:

- The runner applies each file with `--single-transaction`, so a failed 0019
  either fully commits or leaves the pre-0019 function intact; there is no
  half-applied state to repair.
- The function replacement keeps the same OID, so the `EXECUTE` ACLs that
  `provision_roles.sql` granted survive the rollback; only the function body and
  the `0019` bookkeeping row need attention. If you restore the 0018 body while
  leaving the `0019` row in `ai.schema_migrations`, the runner will treat 0019 as
  applied and skip it on the next run. Either leave the body as shipped (the
  preferred, security-reviewed state) or delete the `0019` row as part of a
  separately approved forward/backward change - the repository does not automate
  bookkeeping deletion.
- Roles are additive and never dropped here; the rollback of record for
  `ai_system_access` itself is a reviewed forward migration, not an automatic
  migration rollback (roles README §Rollback).

### 4.5 Evidence to file

Redacted `pg_roles` and `pg_auth_members` output, the ownership query, the 43/19
counts, `verify-db-roles.sh` output showing 14 passed, the cross-tenant denial
transcript, and the `/readyz` 200/503 pair.

### 4.6 Approval points

- D1 before step 1.
- Written confirmation that no migration Job is mid-flight (the migration and
  the role change must not overlap).
- Password handling stays in the secret manager; no credential appears in the
  evidence bundle.

### 4.7 Closure criterion

7 roles with correct attributes; 0019 applied (19 rows); 14/14 actual-role tests
pass; cross-tenant read/write denied as `ai_api`; `/readyz` 200 intended and 503
on deliberate mismatch.

**A skipped role test is a failure. RLS coverage alone does not close this
package.**

---

## 5. WP-4 — Monitoring and alert delivery

**Status OPEN. Approval: D3. Blocks WP-5e.**

### 5.1 Prechecks (static, safe now)

```bash
# NOT TO EXECUTE until D3 is recorded
python3 scripts/validate-k8s.py
python3 scripts/validate-monitoring.py
PATH="/path/to/promtool:/path/to/amtool:$PATH" bash scripts/check-prometheus-configs.sh
```

Expected: `50 documents in 31 files`; `Monitoring config validation OK (rules,
scrape jobs, routes, network path)` with one WARN about the inert receiver;
`Prometheus/Alertmanager configs OK`.

This is static correctness. It is not delivery.

### 5.2 Procedure — deploy in a non-production cluster first

```bash
# NOT TO EXECUTE until D3 is recorded
AI_NAMESPACE=enterprise-ai ./scripts/k8s-monitoring-config.sh
kubectl apply -k infrastructure/kubernetes/monitoring
kubectl -n observability rollout status deploy/prometheus --timeout=180s
kubectl -n observability rollout status deploy/alertmanager --timeout=180s
```

The config script copies `AI_METRICS_AUTH_TOKEN` server-side into
`ai-metrics-token` and refuses to create an empty token.

### 5.3 Verification — 11 checks (handoff §5.3)

```bash
# NOT TO EXECUTE until D3 is recorded
kubectl -n observability get pods
kubectl -n observability exec deploy/prometheus -- ls /etc/prometheus /etc/prometheus/rules /etc/prometheus/metrics
kubectl -n observability port-forward svc/prometheus 9090:9090 &
curl -s localhost:9090/api/v1/rules
curl -s localhost:9090/api/v1/targets
curl -s localhost:9090/api/v1/alertmanagers
kubectl -n observability get networkpolicy
```

| # | Expected |
|---|---|
| 1 | `prometheus` and `alertmanager` `Running` and ready |
| 2 | `prometheus.yml`, `backup-alerts.yml`, `metrics-token` mounted |
| 3 | 5 rules, health `ok` |
| 4 | `ai-api` plus 4 worker targets `up` |
| 5 | `ai-api` scraped `up` with bearer; a `401` in the Prometheus log means a token mismatch |
| 6 | 4/4 workers `up` |
| 7 | One active Alertmanager |
| 8 | `allow-alertmanager-ingress` **and** `allow-alertmanager-egress` listed |
| 9 | A synthetic `vector(1)` alert reaches the Alertmanager UI |
| 10 | After replacing `unconfigured`, a test alert produces a **receiver receipt** |
| 11 | A forced backup failure makes `AIBackupFailed` fire and be delivered |

A `503` from `/metrics` means the token is empty in the workload — a
configuration failure, not a network one.

### 5.4 Abort / rollback

Abort if pods do not become ready, rules do not load, or any target is down for
a reason other than a missing workload. Rollback:

```bash
# NOT TO EXECUTE until D3 is recorded
kubectl delete -k infrastructure/kubernetes/monitoring
```

This removes the observability namespace objects and the PVC. Confirm the
retention decision before deleting the PVC; if the PVC holds data to keep, stop
and escalate instead.

### 5.5 Evidence to file

Redacted pods YAML, `/api/v1/targets`, `/api/v1/rules`, `/api/v1/alertmanagers`
JSON, the networkpolicy listing, and the receiver receipt from steps 10 and 11.

### 5.6 Approval points

- D3 before the config script and apply.
- Separate approval for the real receiver destination (credentials, channel).
- PVC retention decision before any teardown.

### 5.7 Closure criterion

A test alert generated, forwarded, and received by a real integration, with a
receipt. Steps 1-9 alone leave this OPEN.

---

## 6. WP-5 — Scheduled restore drill

**Status OPEN. Approval: D1 + WP-4 for 5d/5e.** Five items, each evidenced
separately; they must not be collapsed into one checkbox.

| Item | What it proves | Depends on |
|---|---|---|
| 5a | A controlled manual drill succeeds | D1, an approved drill window |
| 5b | The CronJob actually creates and completes a Job | cluster, WP-6 base applied |
| 5c | A `restore_drill` row is written as `succeeded` **by the scheduled path** | 5b |
| 5d | `AIRestoreDrillStale` evaluates and transitions | WP-4 Prometheus |
| 5e | The alert is delivered | WP-4 receiver |

**Current state (verified 2026-10-28).** `ai.backup_runs` already holds 5
`restore_drill` rows: `6ae044` (2026-10-26, succeeded, 21/21, encrypted),
`53495d` (2026-10-26, succeeded, 21/21, unencrypted), `82f76b` and `f9099b`
(2026-10-25, succeeded, 21/21), and `5baad9` (2026-10-26, **failed**, 7/22). All
were produced by manual `drill` invocations at development scale. None came from
the CronJob, so 5c is only partially evidenced: the record-writing code path is
proven, the scheduled path is not.

### 6.1 Prechecks

```bash
# NOT TO EXECUTE until the drill window is approved
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -c \
  "select run_id, kind, status, started_at, finished_at from ai.backup_runs order by started_at desc limit 10"
python3 scripts/backup_restore.py --help
python3 scripts/backup_restore.py drill --help
```

Expected: prior rows visible (do not modify them) — currently 5 `restore_drill`
rows plus `backup` rows; the CLI exposes `drill [--artifact] [--start-app]
[--run-workers]`.

### 6.2 Procedure — 5a manual drill, isolated target

```bash
# NOT TO EXECUTE until the drill window is approved
python3 scripts/backup_restore.py drill
ls "$BACKUP_DIR/restore-drills/"
```

The tool creates `ai_restore_drill_<ts>` and
`ai-knowledge-restore-drill-<ts>`, writes
`$BACKUP_DIR/restore-drills/drill-<id>.json`, and inserts a `restore_drill` row
in `ai.backup_runs`. Do not point it at production or a shared target.

### 6.3 Procedure — 5b scheduled Job

```bash
# NOT TO EXECUTE until the cluster path is approved
kubectl -n enterprise-ai get cronjob ai-restore-drill -o yaml
kubectl -n enterprise-ai create job --from=cronjob/ai-restore-drill wp5-drill-manual
kubectl -n enterprise-ai wait --for=condition=complete job/wp5-drill-manual --timeout=7500s
kubectl -n enterprise-ai logs job/wp5-drill-manual
```

Expected: the CronJob is `0 6 1 * *` UTC, `Forbid`, `activeDeadlineSeconds:
7200`, `backoffLimit: 1`, SA `ai-backup`, `args: ["drill"]`; the Job reaches
`Complete` and its log ends without a drill check failure.

### 6.4 Verification — 5c, 5d, 5e

```bash
# NOT TO EXECUTE until the window is approved
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d helix -c \
  "select run_id, status, started_at, finished_at, details from ai.backup_runs where kind='restore_drill' order by started_at desc limit 3"
curl -s 'localhost:9090/api/v1/query?query=ai_backup_last_success_timestamp_seconds{kind="restore_drill"}'
curl -s 'localhost:9090/api/v1/alerts'
```

Expected for 5c: the newest `restore_drill` row is `succeeded` with a
`finished_at`, **and** its `details.target_database` matches the Job run — that
is what distinguishes a scheduled drill from the manual rows listed in §6.

Expected for 5d: after a fresh success the `AIRestoreDrillStale` expression
`time() - ai_backup_last_success_timestamp_seconds{kind="restore_drill"} >
7776000` is false, and the alert is absent; to prove the alert *can* fire,
observe it in a scratch evaluation rather than by deleting the row.

**Known behaviour:** the gauge initialises to `0`, so on a fresh deployment
`AIRestoreDrillStale` fires until the first successful drill. That is expected,
not a defect. Record it as such in 5d evidence.

Expected for 5e: a receiver receipt for the 5d transition.

### 6.5 Abort / rollback

Abort if any drill check fails, if the report `result` is not `success`, or if
the target is not isolated. On abort, **do not delete the target or the report**
— they are the evidence of the failure. Rollback of a successful drill is only
the approved cleanup in WP-9.

### 6.6 Evidence to file (five distinct artifacts)

`drill-<id>.json`; the Job YAML and `Complete` condition; the `backup_runs` row;
the Prometheus query result showing the alert state; the receiver receipt.

### 6.7 Approval points

- Drill window approval before 5a.
- Cluster access approval before 5b.
- WP-4 receiver approval before 5e.
- Separate written approval before any cleanup of the drill target.

### 6.8 Closure criterion

5a-5e each individually evidenced. A manifest, a local drill, or an alert
definition is not a substitute for any of them.

---

## 7. WP-6 — Live Kubernetes rollout

**Status NOT RUN. Approval: D1 + change window. Depends on a green WP-3 and a
complete WP-2.**

### 7.1 Prechecks

```bash
# NOT TO EXECUTE until the change window is approved
python3 scripts/validate-k8s.py
python3 scripts/validate-monitoring.py
for target in base overlays/production monitoring; do
  kustomize build "infrastructure/kubernetes/$target" > "/tmp/render-$(echo "$target" | tr / -).yaml"
  kubeconform -strict -ignore-missing-schemas -summary "/tmp/render-$(echo "$target" | tr / -).yaml"
done
kubectl -n enterprise-ai get secret ai-api-secrets ai-restore-secret
```

Expected: `50 documents in 31 files`; monitoring OK plus one WARN; base and
production 34 valid each, monitoring 11 valid, 0 invalid; both Secrets exist and
are not the example placeholders.

### 7.2 Procedure — staged apply

```bash
# NOT TO EXECUTE until the change window is approved
# `apply -k` submits every object at once, so it does NOT stage the rollout.
# Apply the overlay once, then gate on the migration Job before the rest.
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=900s
kubectl -n enterprise-ai rollout status deploy/ai-api --timeout=300s
kubectl -n enterprise-ai rollout status deploy/ai-event-consumer --timeout=300s
kubectl -n enterprise-ai rollout status deploy/ai-reconciler --timeout=300s
kubectl -n enterprise-ai rollout status deploy/ai-indexer --timeout=300s
kubectl -n enterprise-ai rollout status deploy/ai-agent-worker --timeout=300s
kubectl -n enterprise-ai rollout status deploy/web --timeout=300s
```

If the window requires a true phasing (migration first, workloads only after it
passes), apply the base namespace/config/SA, then the migration Job, then the
remaining workloads as separate `kubectl apply` calls against the rendered
output. The single `apply -k` above is acceptable only when the migration Job
being co-submitted is understood: the wait on `ai-db-migrate` is what prevents
workloads from serving before the schema is ready.

### 7.3 Verification

```bash
# NOT TO EXECUTE until the change window is approved
kubectl -n enterprise-ai get pods -o wide
# The runtime image is python:3.11-slim-bookworm with a nologin USER; it has
# python but no wget/curl, so probe with urllib rather than a shell one-liner.
kubectl -n enterprise-ai exec deploy/ai-api -- python -c \
  "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8000/readyz', timeout=5).status)"
kubectl -n observability port-forward svc/prometheus 9090:9090 &
curl -s 'localhost:9090/api/v1/targets'
kubectl -n enterprise-ai logs deploy/ai-api --tail=200
```

Expected: all workloads healthy; `/readyz` 200 on every API replica; `ai-api`
and 4 workers `up`; no `system`-scope errors in the log; no serving pod mounts
`ai-restore-secret`.

### 7.4 Rollback

```bash
# NOT TO EXECUTE until the change window is approved
kubectl -n enterprise-ai rollout undo deploy/ai-api
kubectl -n enterprise-ai rollout undo deploy/ai-event-consumer
kubectl -n enterprise-ai rollout undo deploy/ai-reconciler
kubectl -n enterprise-ai rollout undo deploy/ai-indexer
kubectl -n enterprise-ai rollout undo deploy/ai-agent-worker
kubectl -n enterprise-ai rollout undo deploy/web
kubectl -n enterprise-ai rollout status deploy/ai-api --timeout=300s
```

Record the revision numbers before and after, and re-check `/readyz` and the
targets.

Abort on: `/readyz` 503 with the intended role; any `rolsuper`/`rolbypassrls`/
`rolcreaterole`; two consecutive backup Job failures; an unencrypted artifact
when encryption is required; any drill check failure.

### 7.5 Evidence to file

Rollout output, per-replica `/readyz`, target health, sanitized pod YAML, and the
rollback revision diff.

### 7.6 Approval points

- D1 complete and WP-3 green before the window opens.
- Monitoring deployment is a **separate** D3 decision; do not fold it in.
- Rollback exercise is part of the window, not a follow-up.

### 7.7 Closure criterion

Staged deploy with actual-role isolation checks, healthy workloads, working
monitoring and backup, and an exercised rollback. Static manifest validation does
not close this package.

---

## 8. WP-7 — Production recoverability

**Status OPEN. Approval: D5 + D6. Depends on WP-5.**

### 8.1 Prechecks

```bash
# NOT TO EXECUTE until D5 and D6 are recorded
grep -n "RPO\|RTO" docs/backup-recovery.md | head -20
grep -rn "object-lock\|ObjectLock\|kms\|KMS" docs/backup-recovery.md | head -20
```

Expected: `docs/backup-recovery.md` Section 2 shows **proposed** objectives
(RPO 24 h, RTO 4 h) explicitly labelled "proposed initial objectives, not a
claim of compliance", and Sections 5/13 state that no off-site replication,
object lock, immutable retention, or KMS is implemented. Do not read the 24 h
figure as an approved RPO, and do not treat the absence of a grep hit as an
absence of the decision — the decision is D5.

### 8.2 Procedure

No command can be run before D5 and D6. The sequence is: obtain the approved
RPO/RTO; agree the off-site, immutable, and KMS/escrow design; implement it; then
run a production-scale isolated drill measured against the approved targets.

### 8.3 Verification

A production-scale drill whose measured restore time and data-loss window are
compared with the approved RPO/RTO, plus proof of an off-site copy, an
immutability configuration, and a key-recovery drill.

### 8.4 Abort / rollback

Abort if any measured result exceeds an approved target. There is no rollback of
a failed production recovery claim; the gate stays OPEN.

### 8.5 Evidence to file

Approved targets, measured restore times, off-site copy proof, object-lock
configuration, and the key-recovery drill result.

### 8.6 Approval points

- D5 before any target is used for assessment.
- D6 before any off-site, immutability, or KMS work.
- Explicit approval for a production-scale drill window.

### 8.7 Closure criterion

Approved RPO/RTO met by a production-scale, off-site, immutable, KMS-backed
restore. No target values are proposed in this pack.

---

## 9. WP-8 — Worker HA

**Status OPEN. Approval: a 2-replica soak in a non-production environment.
Depends on WP-6.**

### 9.1 Prechecks

```bash
# NOT TO EXECUTE until soak approval is recorded
grep -n "replicas:" infrastructure/kubernetes/base/worker-deployments.yaml
grep -rn "SKIP LOCKED\|FOR UPDATE" apps/ai-api/src/ai_api/workers/*.py
```

Expected: all four at `replicas: 1`; only `agent.py` shows `FOR UPDATE SKIP
LOCKED`.

### 9.2 Per-worker state

| Worker | Claim | Safe to scale now |
|---|---|---|
| `ai-event-consumer` | Per-`(event, group)` rows, no atomic claim | No |
| `ai-reconciler` | No global lease | No |
| `ai-indexer` | Lease exists, queued selection not atomic | No |
| `ai-agent-worker` | `SKIP LOCKED` + lease/generation fence | After soak |

Do not scale any worker before its row says yes.

### 9.3 Procedure

Scale one worker at a time in a non-production environment, starting with
`ai-agent-worker` only after its soak. Implement an atomic claim or advisory lock
before touching the other three.

```bash
# NOT TO EXECUTE until soak approval is recorded
kubectl -n <non-prod-ns> scale deploy/ai-agent-worker --replicas=2
kubectl -n <non-prod-ns> rollout status deploy/ai-agent-worker --timeout=300s
```

Soak acceptance: force a claim race, kill a replica mid-flight, and prove no item
is processed twice, nothing is stranded past its lease, and a stale writer is
rejected by the fencing token.

### 9.4 Verification

Duplicate-processing query over the soak window, the lease/reclaim trace, and the
fencing rejection in the logs.

### 9.5 Abort / rollback

```bash
# NOT TO EXECUTE until soak approval is recorded
kubectl -n <non-prod-ns> scale deploy/ai-agent-worker --replicas=1
```

Abort on any duplicate authoritative side effect or any item stranded past its
lease.

### 9.6 Evidence to file

Soak logs (retained for the window), the duplicate query result, the lease trace,
and the fencing proof.

### 9.7 Approval points

- Soak approval and the non-production target before scaling.
- Code change for the unsafe workers requires review before any further scale.

### 9.8 Closure criterion

A documented soak showing no duplicate authoritative side effects. "Safe after
soak" is not the same as "soaked".

---

## 10. WP-9 — Cleanup

**Status PARTIALLY VERIFIED. Approval: D7 per item. Follows WP-5 evidence.**

### 10.1 Prechecks — inventory only, no deletion

```bash
# NOT TO EXECUTE until per-item D7 approval is recorded
PGPASSWORD=helix psql -h 127.0.0.1 -U helix -d postgres -tAc \
  "select datname from pg_database where datname like 'ai_restore_drill_%' order by 1"
ls -1 /backup/artifacts 2>/dev/null
ls -1 /tmp/sec20-backups/artifacts 2>/dev/null
ls -1 /backup/restore-drills 2>/dev/null
```

Expected inventory (matches the tracker):

- 5 drill databases: `ai_restore_drill_20261025_072800`, `_20261025_080325`,
  `_20261026_043531`, `_20261026_102324`, `_20261026_103451`.
- 5 drill buckets, one per timestamp above.
- 3 artifacts under `/backup/artifacts`.
- 4 artifacts under `/tmp/sec20-backups/artifacts`.

### 10.2 Protected — never a cleanup candidate

`20261026T103104Z-3e8513`; `drill-20261026T103451Z-6ae044.json`; everything under
`docs/audit/evidence/`; and `ai_restore_drill_20261026_103451` plus its bucket
while the current SEC-20 report is retained.

### 10.3 Procedure — per item, dry-run first

```bash
# NOT TO EXECUTE until per-item D7 approval is recorded
python3 scripts/backup_restore.py cleanup \
  --target-db ai_restore_drill_<ts> --confirm-target ai_restore_drill_<ts> \
  --target-bucket ai-knowledge-restore-drill-<ts> --confirm-bucket ai-knowledge-restore-drill-<ts>
```

Expected dry-run: `"executed": false`. The tool refuses any name that does not
start with the drill prefixes, so it cannot drop the source database.

`--execute` is added **only** for an item with written approval, one item per
invocation. Deleting an artifact is irreversible; deleting a drill DB or bucket
is recoverable from the retained artifact, so the artifact's fate must be decided
before the target it backs.

### 10.4 Abort / rollback

Stop on any name that is not on the approved list. There is no rollback for a
deleted artifact; that is why the source decision is separate from the target
decision.

### 10.5 Evidence to file

The reviewed dry-run output, the per-item approve/reject record, and proof the
protected set is intact after execution.

### 10.6 Approval points

- D7 per item, in writing, naming the exact database, bucket, or artifact.
- Explicit confirmation that WP-5 evidence is filed first.

### 10.7 Closure criterion

Every item decided in writing; approved items executed separately; protected
evidence intact.

---

## 11. Post-execution tracker update

After each package, update **only** these tracker fields: status, actual result,
evidence ledger row, and next action. Do not rewrite historical evidence, do not
renumber work packages, and do not record an approval that was not filed.

If a package aborts, record the abort and keep the status unchanged. An aborted
window is not a downgrade and not a pass.

## 12. Final decision

**NO-GO for production. Stage 7-10 are code complete, not operationally gated.
Unchanged by this pack.**

This pack adds procedure, not evidence. No work package closes here, no approval
is recorded here, and no owner or date is invented. Execution above closes a
package only when its evidence is filed and its closure criterion is met.
