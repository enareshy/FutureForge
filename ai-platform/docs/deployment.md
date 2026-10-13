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

Both are multi-stage (build tooling never reaches the runtime layer), run as
non-root with `readOnlyRootFilesystem` where possible, and ship a container
`HEALTHCHECK`. Runtime dependencies are fully pinned (`requirements.txt`,
`package-lock.json`). For supply-chain hardening, pin base images by digest.

Build:

```bash
docker build -t enterprise-ai-platform/ai-api:0.1.0 ai-platform/apps/ai-api
docker build -t enterprise-ai-platform/web-ai:0.1.0 ai-platform/apps/web-ai
```

Tagging convention: `:<semver>` for releases, `:<git-sha>` for every CI build.

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
```

## Health and readiness

| Probe | Endpoint | Notes |
| --- | --- | --- |
| liveness | `GET /healthz` | Always 200 while the process is up. |
| readiness | `GET /readyz` | 200 when PostgreSQL (the authorization/vector store) is reachable; 503 otherwise. |
| startup | `GET /healthz` | Allows a slow first boot before liveness applies. |
| metrics | `GET /metrics` | Prometheus scrape; never exposed through the ingress. |

The console image answers `/healthz` directly from nginx.

## Scaling

`HorizontalPodAutoscaler/ai-api` scales 2..6 replicas on CPU (70%). The API is
stateless — all state is in PostgreSQL, Redis, object storage and the event log
— so any replica can serve any request. `PodDisruptionBudget/ai-api` keeps at
least one replica available during node maintenance.

## Configuration and secrets

- **Non-secret** configuration is the `ai-api-config` ConfigMap.
- **Secrets** are the `ai-api-secrets` Secret. Never commit real values; use the
  cluster's secret manager (Sealed Secrets, External Secrets Operator, or a
  cloud secret store). `secret.example.yaml` contains inert placeholders only.
- No secret is ever logged, echoed into metrics/labels, or sent to the browser.
  See `security.md`.

## Network exposure

Only the console is published, via `Ingress/web` with TLS terminated at the
ingress (cert-manager `ClusterIssuer`). PostgreSQL/pgvector, Redis, object
storage, OpenSearch, Kafka, MLflow and the monitoring consoles stay
cluster-internal; operators reach them with `kubectl port-forward`.
`networkpolicy.yaml` applies default-deny ingress/egress and re-opens only DNS,
console ingress, console→API, and API→backing-services traffic.

## Rollback

```bash
# Roll back the container images to the previous release (fast, no schema change).
kubectl -n enterprise-ai rollout undo deploy/ai-api
kubectl -n enterprise-ai rollout undo deploy/web
kubectl -n enterprise-ai rollout status deploy/ai-api
```

For a Kustomize-managed rollback, set `images[].newTag` back to the previous
release and re-apply. Schema migrations are forward-only and idempotent; a
release that changed the schema ships its own compensating migration. Restore
from backup only for data corruption (see `backup-recovery.md`).

## Disaster recovery

- **Backups**: PostgreSQL (metadata, vectors, audit mirror), object storage
  (source documents) and, if enabled, the Kafka event log. See
  `backup-recovery.md` for schedules and commands.
- **RPO/RTO targets** are customer-defined; the platform supports
  point-in-time recovery for PostgreSQL via WAL archiving.
- **Stateless tiers** (API, console) are recreated from manifests; recovery is
  a redeploy plus restore of the stateful tiers.
- **Runbook**: restore PostgreSQL → restore object storage → run migrations →
  deploy → verify `/readyz`, a RAG query and an audit record.

## CI checks

`.github/workflows/ai-platform-ci.yml`:

- `ai-api`: ruff + hermetic tests.
- `web-console`, `web-ai`: frontend tests + builds.
- `manifests`: structural validation (`scripts/validate-k8s.py`) and
  kubeconform schema validation.
- `images`: build both images, Trivy scan (HIGH/CRITICAL), CycloneDX SBOMs.
- `dependency-scan`: `pip-audit` (Python) and `npm audit` (both frontends).

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
