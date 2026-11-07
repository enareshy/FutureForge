# Deployment

Two targets:

- **Local development / testing** — Docker Compose (`compose.yaml`) runs the
  backing services; the app processes run on the host for fast iteration. See
  `installation.md`.
- **Production** — Kubernetes. Manifests live in
  `infrastructure/kubernetes/` (Kustomize base + `production` overlay). The AI
  API and console are built as pinned, non-root container images.

Docker Compose is not the production orchestrator. Kubernetes is the target,
subject to the customer's platform.

## Container images

| Image | Dockerfile | Base | User | Port |
| --- | --- | --- | --- | --- |
| `enterprise-ai-platform/ai-api` | `apps/ai-api/Dockerfile` | `python:3.11.12-slim-bookworm` | `app` (uid 10001) | 8000 |
| `enterprise-ai-platform/web-ai` | `apps/web-ai/Dockerfile` | `node:22.22.0-bookworm-slim` → `nginxinc/nginx-unprivileged:1.27-alpine` | `101` | 8080 |

The four reliability workers reuse the `ai-api` image with a different module
command; no separate image is built. See `WORKER_DEPLOYMENT.md`.

The images are multi-stage (build tooling never reaches the runtime layer), run as
non-root with `readOnlyRootFilesystem` where possible, and ship a container
`HEALTHCHECK`. Runtime dependencies are fully pinned (`requirements.txt`,
`package-lock.json`). For supply-chain hardening, pin base images by digest.

Build:

```bash
docker build -t enterprise-ai-platform/ai-api:0.1.0 ai-platform/apps/ai-api
docker build -t enterprise-ai-platform/web-ai:0.1.0 ai-platform/apps/web-ai
```

Tagging convention: `:<semver>` for releases, `:<git-sha>` for every CI build.

## Least-privilege database roles

Production must not connect the API, workers, backup, or migration jobs with the
table-owning login. Before applying migration 0019:

1. Stop API/worker/backup/migration processes and run
   `infrastructure/db/roles/provision_roles.sql` as a superuser (ownership
   transfer; old pooled sessions must not keep serving).
2. Set one password per login role in `ai-api-secrets`:
   `AI_API_POSTGRES_PASSWORD`, `AI_WORKER_POSTGRES_PASSWORD`,
   `AI_BACKUP_POSTGRES_PASSWORD`, `AI_MIGRATION_POSTGRES_PASSWORD`.
3. Run migrations with `ai_migrate` (`AI_MIGRATION_DB_*`, session role
   `ai_owner`).
4. Run `scripts/verify-db-roles.sh` with the five role DSNs and record the
   result.

The base manifests set `POSTGRES_USER` per workload (`ai_api`, `ai_worker`,
`ai_backup`, `ai_migrate`) and no longer provide a shared default. Missing
credentials fail at startup instead of falling back to the owner. See
`infrastructure/db/roles/README.md` and `docs/tenant-isolation.md`.

## Releases and change management

1. Merge to the release branch; CI runs lint/tests, builds both images, scans
   them (Trivy, fail on HIGH/CRITICAL), and produces CycloneDX SBOMs.
2. Tag the release (`0.1.0`) and push the versions to the registry used by the
   cluster.
3. Update `images[].newTag` in `overlays/production/kustomization.yaml` (or set
   it with `kustomize edit set image`).
4. Apply in order: refresh the migration ConfigMap, apply the overlay, run the
   migration Job, wait for rollout.

```bash
AI_NAMESPACE=enterprise-ai ./ai-platform/scripts/k8s-migrations-configmap.sh
kubectl apply -k ai-platform/infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai delete job ai-db-migrate --ignore-not-found
kubectl apply -k ai-platform/infrastructure/kubernetes/overlays/production
kubectl -n enterprise-ai wait --for=condition=complete job/ai-db-migrate --timeout=180s
kubectl -n enterprise-ai rollout status deploy/ai-api
kubectl -n enterprise-ai rollout status deploy/web
for d in ai-event-consumer ai-reconciler ai-indexer ai-agent-worker; do
  kubectl -n enterprise-ai rollout status "deploy/$d"
done
```

The migration Job must complete before workers start processing; workers fail
readiness closed until their first successful cycle. Exact commands and
verification are in `WORKER_DEPLOYMENT.md`.

Migration 0018 enables `FORCE ROW LEVEL SECURITY` on all tenant-owned tables.
Migration 0019 binds system scope to the `ai_system_access` role; it must run
after role provisioning. Deploy the matching API/worker image immediately after
the migrations: older images issue global queue queries without the
system/tenant context and will process nothing. The API fails readiness if RLS
verification is missing; with `AI_DB_ROLE_PROFILE` set it also refuses to start
on an owner, superuser, `BYPASSRLS`, or mismatched role. See
`tenant-isolation.md` for the context model and role requirements. Backups and
restores from this release carry the required `PGOPTIONS`/row-security flags.

## Health and readiness

| Probe | Endpoint | Notes |
| --- | --- | --- |
| liveness | `GET /healthz` | Always 200 while the process is up. |
| readiness | `GET /readyz` | 200 when PostgreSQL (the authorization/vector store) is reachable; 503 otherwise. |
| startup | `GET /healthz` | Allows a slow first boot before liveness applies. |
| metrics | `GET /metrics` | Bearer token required; never exposed through the ingress or console proxy. |

Workers expose `/healthz`, `/readyz` and token-protected `/metrics` on port
9100. The AI API docs/schema routes are disabled in production by default
(`AI_DOCS_ENABLED=false`). Worker
readiness is activity-based: 503 until the first successful cycle, and 503 when
the last success exceeds the worker's staleness window. Liveness only proves the
process is alive; a stopped loop is detected by readiness and the
`ai_worker_last_success_timestamp_seconds` metric.

The console image answers `/healthz` directly from nginx.

## Scaling

`HorizontalPodAutoscaler/ai-api` scales 2..6 replicas on CPU (70%). The API is
stateless — all state is in PostgreSQL, Redis, object storage and the event log
— so any replica can serve any request. `PodDisruptionBudget/ai-api` keeps at
least one replica available during node maintenance.

Workers intentionally run one replica each (`strategy: Recreate`) because the
event outbox, reconciler and index queue do not yet have atomic claims or a
global lease. The agent worker is lease-fenced and can be scaled after cluster
validation. Scaling constraints and the remediation needed before raising
replicas are in `WORKER_DEPLOYMENT.md`.

## Configuration and secrets

- **Non-secret** configuration is the `ai-api-config` ConfigMap.
- **Secrets** are the `ai-api-secrets` Secret. Never commit real values; use the
  cluster's secret manager (Sealed Secrets, External Secrets Operator, or a
  cloud secret store). `secret.example.yaml` contains inert placeholders only.
- `AI_METRICS_AUTH_TOKEN` is required in production/staging (minimum 32
  characters). The API and workers require it for `/metrics`; attach the same
  token to the cluster Prometheus scrape configuration.
- No secret is ever logged, echoed into metrics/labels, or sent to the browser.
  See `security.md`.

## Network exposure

Only the console is published, via `Ingress/web` with TLS terminated at the
ingress (cert-manager `ClusterIssuer`). PostgreSQL/pgvector, Redis, object
storage, OpenSearch, Kafka, MLflow and the monitoring consoles stay
cluster-internal; operators reach them with `kubectl port-forward`.
`networkpolicy.yaml` applies default-deny ingress/egress and re-opens only DNS,
console ingress, console→API, API/worker→backing-services traffic, and metrics
scraping from the observability namespace.

## Rollback

```bash
# Roll back the container images to the previous release (fast, no schema change).
kubectl -n enterprise-ai rollout undo deploy/ai-api
kubectl -n enterprise-ai rollout undo deploy/web
for d in ai-event-consumer ai-reconciler ai-indexer ai-agent-worker; do
  kubectl -n enterprise-ai rollout undo "deploy/$d"
done
kubectl -n enterprise-ai rollout status deploy/ai-api
```

Workers share the API image tag, so rolling back the image rolls back the worker
command set with it. Confirm migrations are compatible before rolling back. Do
not roll back below the release that introduced RLS while migration 0018 is
applied: the older application cannot establish the required context. Rolling
back the isolation control itself is a security-reviewed forward migration, not
an automatic step.

For a Kustomize-managed rollback, set `images[].newTag` back to the previous
release and re-apply. Schema migrations are forward-only and idempotent; a
release that changed the schema ships its own compensating migration. Restore
from backup only for data corruption (see `backup-recovery.md`).

## Disaster recovery

- **Backups**: the AI PostgreSQL schema (metadata, vectors, audit mirror) and
  object bytes (source documents) are authoritative and are covered by the
  encrypted backup CronJob. Kafka is a mirror of the database outbox, Redis is
  cache-only, and OpenSearch is reconstructed from authoritative rows. See
  `backup-recovery.md` for the exact inventory and commands.
- **RPO/RTO**: the repository proposes 24 hours / 4 hours and measures the
  procedure only at development scale. It does **not** ship PostgreSQL
  point-in-time recovery or WAL archiving; those require a platform-level
  continuous-archive configuration.
- **Stateless tiers** (API, console) are recreated from manifests; recovery is
  a redeploy plus restore of the stateful tiers.
- **Runbook**: restore PostgreSQL → restore object storage → verify document
  object links → rebuild search if enabled → resume workers → deploy → check
  `/readyz`, a RAG query and an audit record. Do not run migrations blindly on a
  restored database; compare `ai.schema_migrations` with the application first.
- **Evidence**: run `scripts/backup_restore.py drill` and keep the JSON report.
  A backup is not considered recoverable until a drill restores it.

## CI checks

`.github/workflows/ai-platform-ci.yml`:

- `ai-api`: ruff + hermetic tests, including worker runtime/health and manifest
  tests.
- `web-console`, `web-ai`: frontend tests + builds.
- `manifests`: structural validation (`scripts/validate-k8s.py`), then
  `kustomize build` + kubeconform schema validation of `base` and
  `overlays/production`.
- `monitoring-configs`: `promtool check config`, `otelcol validate`, and
  Grafana provisioning/dashboard parsing.
- `images`: build both images, Trivy scan (HIGH/CRITICAL), CycloneDX SBOMs.
- `dependency-scan`: `pip-audit` (Python) and `npm audit`. The AI-owned
  `web-ai` app enforces; the pre-existing enterprise console audit runs
  advisory only (its advisories are in dev-only build/test tooling owned by the
  platform team, not the AI platform).

## Software bill of materials

SBOMs (CycloneDX JSON) are produced per image in CI and uploaded as the `sbom`
artifact. Generate locally with [syft](https://github.com/anchore/syft):

```bash
syft enterprise-ai-platform/ai-api:0.1.0 -o cyclonedx-json > sbom-ai-api.cdx.json
```

## Licensing and commercial dependencies

The open-source stack is Apache-2.0/MIT/BSD compatible; see
`technology-decisions.md` for the per-component license table and the separate
list of optional commercial services (managed PostgreSQL, object storage,
secret managers, ingress/CDN, a commercial LLM provider).
