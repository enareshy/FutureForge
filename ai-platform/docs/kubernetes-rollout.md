# Kubernetes rollout and alerting runbook

Executable procedure for taking the Stage 1-6 AI platform from static manifests
to a live, observed rollout, and for proving that backup alerts reach a human.

Status of the underlying evidence (2026-10-27):

| Layer | Status | Basis |
|---|---|---|
| Manifest structure | VERIFIED | `scripts/validate-k8s.py`: 50 documents in 31 files |
| Kustomize render + schema | VERIFIED (static) | `kustomize v5.5.0` + `kubeconform v0.6.7`: base/production 34/34, monitoring 11/11 valid |
| Monitoring config | VERIFIED (static) | `scripts/validate-monitoring.py`: rules, scrape jobs, routes |
| Compose config | VERIFIED | `docker compose config -q` exit 0 |
| Live rollout | NOT RUN | no cluster, no `kubectl` |
| Alert delivery | OPEN | Alertmanager receiver has no integration; no notification verified |

Nothing in this document has been executed against a live cluster. Do not treat a
step as complete because the command is written here.

## 0. Known prerequisites and gaps

Read this before scheduling the window. These are current facts, not wishes:

1. **Role separation must be done first.** Apply
   `infrastructure/db/roles/provision_roles.sql` as a superuser in a maintenance
   window, then migration `0019_system_access_role_gate.sql`. Until then every
   workload fails closed on readiness. See
   `docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` Section 3.
2. **The restore credential lives in its own Secret.** `ai-api-secrets` carries
   `AI_API_POSTGRES_PASSWORD`, `AI_WORKER_POSTGRES_PASSWORD`,
   `AI_BACKUP_POSTGRES_PASSWORD`, `AI_MIGRATION_POSTGRES_PASSWORD` only. The
   monthly `ai-restore-drill` CronJob mounts `ai-restore-secret` (key
   `password`) for the isolated target, so serving pods never receive a role
   that can create databases. Section 3 creates both Secrets.
3. **Monitoring is a separate, opt-in kustomization.** `monitoring/` deploys a
   Prometheus and an Alertmanager into the `observability` namespace. It is not
   part of the production overlay because the operator must supply a real
   notification receiver. `alertmanager.yml` ships with an inert receiver: the
   five rules evaluate and reach Alertmanager, but **no human is notified** until
   Section 8.2 adds an integration.
4. **Workers now have Services.** `worker-services.yaml` gives the four workers
   stable `:9100` targets; `prometheus-kubernetes.yml` scrapes them by DNS name.
   `validate-monitoring.py` fails if a scrape target has no matching Service.
   The `prometheus.io/scrape` pod annotations remain for operators that deploy
   pod-discovery scraping instead.
5. **The drill is scheduled.** `ai-restore-drill` runs monthly at 06:00 UTC on
   day 1 and records a `restore_drill` row, which is the producer for
   `AIRestoreDrillStale`. It does not delete its target database or bucket;
   Section 7.2 shows the operator cleanup.
6. **`BACKUP_ENCRYPTION_PASSPHRASE` must be set** in the real secret. The base
   ConfigMap sets `BACKUP_REQUIRE_ENCRYPTION=true`, so the Job fails closed
   without it.

## 1. Pre-flight (static, no cluster)

```bash
cd ai-platform
python3 scripts/validate-k8s.py
python3 scripts/validate-monitoring.py
PATH="/path/to/promtool-dir:/path/to/amtool-dir:$PATH" \
  bash scripts/check-prometheus-configs.sh
docker compose --env-file .env -f compose.yaml config -q
for target in base overlays/production monitoring; do
  kustomize build "infrastructure/kubernetes/$target" > "/tmp/render-$(echo "$target" | tr / -).yaml"
  kubeconform -strict -ignore-missing-schemas -summary "/tmp/render-$(echo "$target" | tr / -).yaml"
done
```

Expected: `50 documents in 31 files`; monitoring validator prints
`Monitoring config validation OK` plus one expected warning about the inert
receiver; `check-prometheus-configs.sh` prints `Prometheus/Alertmanager configs
OK`; Compose exits 0; base and production render 34 valid resources each,
monitoring 11, 0 invalid. Abort the window if any render or schema check fails.

## 2. Provision roles (blocker)

Stop API, workers, backup CronJob (`suspend: true`) and the migration Job first.

```bash
psql --single-transaction -v ON_ERROR_STOP=1 -h "$POSTGRES_HOST" -U "$PGSUPERUSER" \
  -d "$POSTGRES_DB" -f infrastructure/db/roles/provision_roles.sql
psql -h "$POSTGRES_HOST" -U "$PGSUPERUSER" -d "$POSTGRES_DB" -Atc \
  "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
   from pg_roles where rolname like 'ai_%' order by rolname;"
```

Expected: seven roles; every `rolsuper=false`, `rolbypassrls=false`,
`rolcreaterole=false`; only `ai_restore` has `rolcreatedb=true`. Never print
passwords.

## 3. Create the real secret out-of-band

```bash
kubectl -n enterprise-ai create secret generic ai-api-secrets \
  --from-literal=AI_API_POSTGRES_PASSWORD='<from secret manager>' \
  --from-literal=AI_WORKER_POSTGRES_PASSWORD='<from secret manager>' \
  --from-literal=AI_BACKUP_POSTGRES_PASSWORD='<from secret manager>' \
  --from-literal=AI_MIGRATION_POSTGRES_PASSWORD='<from secret manager>' \
  --from-literal=BACKUP_ENCRYPTION_PASSPHRASE='<from secret manager>' \
  --from-literal=AI_METRICS_AUTH_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=LLM_API_KEY='<licensed provider key>'
```

Expected: `secret/ai-api-secrets created`. Then the isolated drill credential in
its own Secret:

```bash
kubectl -n enterprise-ai create secret generic ai-restore-secret \
  --from-literal=password='<ai_restore password from the secret manager>'
```

Expected: `secret/ai-restore-secret created`. Do not add this key to
`ai-api-secrets`: that Secret is injected into every serving pod with `envFrom`.

Verify key names only, never values:

```bash
kubectl -n enterprise-ai get secret ai-api-secrets -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
kubectl -n enterprise-ai get secret ai-restore-secret -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
```

## 4. Migration ConfigMap and migration Job

```bash
AI_NAMESPACE=enterprise-ai ./scripts/k8s-migrations-configmap.sh
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai delete job ai-db-migrate --ignore-not-found
kubectl apply -k infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=180s
kubectl -n enterprise-ai logs job/ai-db-migrate --tail=40
```

Expected: log shows `apply 0019_system_access_role_gate.sql` then
`migrations complete`; 19 rows in `ai.schema_migrations`. Abort if 0019 raises
`missing required database role(s)`: Section 2 did not complete.

## 5. Roll out API, console and workers

```bash
kubectl -n enterprise-ai rollout status deploy/ai-api --timeout=300s
kubectl -n enterprise-ai rollout status deploy/web --timeout=300s
for d in ai-event-consumer ai-reconciler ai-indexer ai-agent-worker; do
  kubectl -n enterprise-ai rollout status "deploy/$d" --timeout=300s
done
```

Readiness is the gate, not liveness. Liveness stays 200 even when the role
assertion is rejected; readiness returns 503 in that case.

```bash
kubectl -n enterprise-ai get pods -o wide
kubectl -n enterprise-ai logs deploy/ai-api --tail=20
```

Expected: API log has no `db.role_verification_failed`; pods `Ready 1/1`.

## 6. Verify isolation under real identities

Run from an operator shell with direct database access, as the real roles. This
is the same suite the SEC-19 sign-off requires:

```bash
AI_TEST_ROLE_DB=1 \
AI_ROLE_API_DSN='postgresql://ai_api:<secret>@<host>/<db>' \
AI_ROLE_WORKER_DSN='postgresql://ai_worker:<secret>@<host>/<db>' \
AI_ROLE_BACKUP_DSN='postgresql://ai_backup:<secret>@<host>/<db>' \
AI_ROLE_RESTORE_DSN='postgresql://ai_restore:<secret>@<host>/<db>' \
AI_ROLE_MIGRATE_DSN='postgresql://ai_migrate:<secret>@<host>/<db>' \
  bash scripts/verify-db-roles.sh
```

Expected: 14 passed, 0 skipped. Then prove the readiness boundary explicitly:

- with the intended profile: `/readyz` 200 for API and each worker;
- with a deliberate mismatch (`AI_DB_EXPECTED_ROLE=ai_backup` on the API): pod
  logs `unexpected_role`, `/readyz` 503, `/healthz` still 200.

## 7. First backup run and a restore drill

```bash
JOB="ai-backup-manual-$(date +%s)"
kubectl -n enterprise-ai create job --from=cronjob/ai-backup "$JOB"
kubectl -n enterprise-ai wait --for=condition=complete "job/$JOB" --timeout=7200s
kubectl -n enterprise-ai logs "job/$JOB" --tail=40
```

Expected: exit 0; an artifact directory under the PVC with `manifest.json`,
`postgres.dump.gpg`, `objects.tar.gz.gpg`; `ai.backup_runs` row with
`status='succeeded'`, `encrypted=true`, `integrity_ok=true`; API `/metrics`
carries `ai_backup_last_encrypted{kind="backup"} 1`.

Then verify and drill outside the cluster with the `ai_backup`/`ai_restore`
credentials and a separate target:

```bash
python3 scripts/backup_restore.py verify --artifact <run-id>
RESTORE_TARGET_USER=ai_restore RESTORE_TARGET_PASSWORD='<secret>' \
RESTORE_TARGET_ROLE_PROFILE=restore RESTORE_TARGET_EXPECTED_ROLE=ai_restore \
  python3 scripts/backup_restore.py drill
```

Expected: `verify` exit 0; drill report with 21/21 checks and no failure. Record
the wall-clock time as the measured drill duration. This is still not a
production RTO until business approves the target and the data volume is
production-sized.

Note: the `ai_restore` role is verified through the maintenance database, because
the isolated drill database does not exist yet when the check runs. The role
therefore needs `CONNECT` on `postgres` (the cluster superuser grants it by
default) and the tool fails with `restore_role_probe_failed` if it cannot.

## 7.1 Scheduled drill

`ai-restore-drill` runs monthly at 06:00 UTC on day 1. It restores the newest
artifact with the `ai_restore` credential and records a `restore_drill` row, which
feeds `AIRestoreDrillStale`. It runs without `--start-app`/`--run-workers`
because the backup image does not contain the application package; use the
operator command in Section 7 when a live app check is required.

Trigger one now instead of waiting for the schedule:

```bash
DRILL="ai-restore-drill-manual-$(date +%s)"
kubectl -n enterprise-ai create job --from=cronjob/ai-restore-drill "$DRILL"
kubectl -n enterprise-ai wait --for=condition=complete "job/$DRILL" --timeout=7200s
kubectl -n enterprise-ai logs "job/$DRILL" --tail=40
```

Expected: exit 0; a `drill-<id>.json` report on the PVC; `ai.backup_runs` has a
`restore_drill` row with `status='succeeded'`; API `/metrics` shows
`ai_backup_last_success_timestamp_seconds{kind="restore_drill"}` within the last
hour.

## 7.2 Clean up a drill target

The drill never drops its database or bucket. After reviewing the report:

```bash
python3 scripts/backup_restore.py cleanup \
  --target-db ai_restore_drill_<timestamp> --confirm-target ai_restore_drill_<timestamp> \
  --target-bucket ai-knowledge-restore-drill-<timestamp> \
  --confirm-bucket ai-knowledge-restore-drill-<timestamp>
```

Run once without `--execute` to see the dry-run, then with `--execute`. The
command refuses non-drill names.

## 8. Make alerts real

`infrastructure/kubernetes/monitoring/` now ships an opt-in Prometheus and
Alertmanager. Applying it is necessary but **not sufficient**: the shipped
`alertmanager.yml` receiver has no integration, so alerts are visible in the
Alertmanager UI and are not delivered to a human. Complete 8.2 before claiming
alerting works.

### 8.1 Deploy Prometheus and Alertmanager

```bash
AI_NAMESPACE=enterprise-ai ./scripts/k8s-monitoring-config.sh
kubectl apply -k infrastructure/kubernetes/monitoring
kubectl -n observability rollout status deploy/prometheus --timeout=180s
kubectl -n observability rollout status deploy/alertmanager --timeout=180s
```

The script copies `AI_METRICS_AUTH_TOKEN` from `ai-api-secrets` into the
`ai-metrics-token` Secret so Prometheus scrapes with the same value the API and
workers validate. It refreshes three ConfigMaps from the canonical files in
`infrastructure/monitoring/prometheus/`.

Path A - Prometheus Operator (use this instead if the cluster already runs it):
the worker Services and API annotations are already in place. Replace the
Deployment/Service in `monitoring/` with a `Prometheus` CR, create
`ServiceMonitor` objects selecting `app.kubernetes.io/component in (backend,
worker)` on port `metrics`, and load `backup-alerts.yml` as a `PrometheusRule`.
Keep the observability namespace name so `allow-metrics-scrape` admits the
scraper.

### 8.2 Add a real receiver

`alertmanager.yml` must stay empty by default because the repository cannot know
the organisation's paging destination. To make delivery real:

1. Edit `infrastructure/monitoring/prometheus/alertmanager.yml` and replace the
   `unconfigured` receiver with the real integration (webhook/PagerDuty/Slack).
2. Re-run `scripts/k8s-monitoring-config.sh` and roll Alertmanager.
3. Fire a test alert and obtain the receiver receipt.

Until step 3 produces a receipt, alert delivery remains **OPEN**, not verified.

### 8.3 Verify rules, targets and delivery

```bash
# Rules loaded and evaluating
kubectl -n observability port-forward svc/prometheus 9090:9090 &
curl -s http://localhost:9090/api/v1/rules | jq '.data.groups[].rules[].name'
# Targets up
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job:.labels.job, health:.health}'
# Prometheus can reach Alertmanager
curl -s http://localhost:9090/api/v1/alertmanagers | jq '.data.activeAlertmanagers'
# Alertmanager receives the alert
kubectl -n observability port-forward svc/alertmanager 9093:9093 &
curl -s http://localhost:9093/api/v2/alerts | jq '.[].labels.alertname'
```

Expected: five rule names; every `ai-api`/`ai-workers` target `up`; a
deliberately failed backup run produces `AIBackupFailed` in `pending`/`firing`;
the alert appears in Alertmanager; and, only after 8.2, the receiver records the
notification (screenshot or ticket id). A loaded rule is not delivery.

Network path: Prometheus-to-Alertmanager needs an allow rule in **both**
directions. `monitoring/networkpolicy.yaml` ships
`allow-prometheus-egress` (9093) and `allow-alertmanager-ingress` (from
Prometheus, 9093). Removing either one makes `scripts/validate-monitoring.py`
exit non-zero, and in a live cluster `default-deny` would drop the alert before
it reaches Alertmanager. Confirm the policy exists before trusting step 8.3:

```bash
kubectl -n observability get networkpolicy allow-alertmanager-ingress -o yaml
```

## 9. Exercise one cycle of real work

- Send one authenticated chat request; confirm `ai_http_requests_total` moves.
- Confirm the event consumer marks a delivery and no dead letters appear.
- Queue an index job; confirm the indexer completes it.
- Queue an agent execution; confirm claim, approval and completion.
- Confirm tenant isolation: an `ai_api` request for another tenant returns 403 or
  an empty result, and `ai_rls_context_missing_total` does not rise on healthy
  paths.

## 10. Rollback and abort criteria

Abort and roll back if any of these occur:

- 0019 fails or `ai.schema_migrations` does not reach 19 rows.
- `/readyz` is 503 after rollout with the intended role.
- Any role has `rolsuper`, `rolbypassrls` or `rolcreaterole` true.
- The backup Job exits nonzero twice, or the artifact is unencrypted with
  `BACKUP_REQUIRE_ENCRYPTION=true`.
- A drill check fails.

Rollback:

```bash
kubectl -n enterprise-ai rollout undo deploy/ai-api
kubectl -n enterprise-ai rollout undo deploy/ai-event-consumer
kubectl -n enterprise-ai rollout undo deploy/ai-reconciler
kubectl -n enterprise-ai rollout undo deploy/ai-indexer
kubectl -n enterprise-ai rollout undo deploy/ai-agent-worker
kubectl -n enterprise-ai rollout undo deploy/web
```

For a role-gate failure, do not re-grant `ai_owner` to a runtime role and do not
revert `ai.system_access()` to the GUC-only form. Use a security-reviewed
forward migration. See `docs/deployment.md`, `docs/backup-recovery.md` and
`docs/tenant-isolation.md`.

## 11. Evidence to retain

- Sanitized role attribute query output.
- Migration Job log showing 0019 applied and 19 rows.
- 14/14 role test summary line.
- `/readyz` 200 and the deliberate-mismatch 503 response.
- Backup Job log, artifact manifest (no passphrase), `ai.backup_runs` row.
- Drill report JSON under `docs/audit/evidence/`.
- Prometheus rule list, target health, firing alert, and the receiver receipt.
- Signed change record with the maintenance window and approvers.
