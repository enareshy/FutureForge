# Enterprise AI Platform V1 — Phase 0 Discovery & Decisions

Status: complete. Baseline captured before any implementation. No existing
files were modified to produce this document.

## 1. Existing architecture summary

The host repository (`FutureForge`, package name `helix-iam`) is an
established modular enterprise lifecycle platform. The AI platform is an
additive layer; it does not replace the existing backend.

- Backend: Node.js 22 ESM, Express 4, PostgreSQL 15 (`pg`), tested with
  `node:test`. ~506 tables and ~45 service modules (IAM, objects, lifecycle,
  workflow, audit, notifications, delivery, jobs + job-execution engine,
  files + file-storage, search, events, content, metadata, numbering,
  versioning, reference, classification, BOM, PDM, change, requirements,
  verification-validation, digital thread, integration, observability,
  deployment).
- Data layer: dual synchronous (`server/db.js`) and asynchronous
  (`server/db-async.js`) access. Schema is applied from `server/schema.sql`
  with an idempotent `schema_migrations` marker
  (`SCHEMA_VERSION = "postgres_007"`). Seed is idempotent; there is no
  down-migration tooling.
- Frontend: React 18 + Vite 6 in **JavaScript**, react-router 6, pages under
  `web/src/pages`; dev proxy `/api -> 127.0.0.1:3001`.
- Identity: opaque session tokens (`Authorization: Bearer` or
  `x-session-token`) stored in the `sessions` table; authorization via
  `requirePermission(db, resource, action)`; module availability via
  deployment editions (community/standard/enterprise).
- Events: transactional outbox with a durable `database` broker and a
  `memory` broker; pluggable via `registerBusProvider()` (Kafka is a known
  provider code but has no registered adapter).
- Search: relational provider by default; pluggable via
  `registerSearchProvider()`.
- File storage: `local` and `memory` providers only (no S3/MinIO).
- Audit: reusable immutable audit service (`writeAudit`, `capture`,
  `auditRoute`).
- Object model, metadata, numbering, lifecycle, content and digital-thread
  providers are all reusable.

## 2. Technology inventory

| Spec requirement | Present in environment |
|---|---|
| React + TypeScript + Vite | React + Vite present (JavaScript) |
| Python + FastAPI | Python 3.11.2 present; FastAPI/uvicorn/pydantic absent |
| PostgreSQL | 15.19, Debian cluster `15/main`, 127.0.0.1:5432 |
| pgvector | Absent (only pg_trgm, pgcrypto, uuid-ossp) — not in Debian repo |
| OpenSearch | Absent |
| Apache Kafka | Absent (no JVM) |
| Redis | Absent; `redis-server 7.0.15` installable / containerized |
| LiteLLM / LangGraph / MLflow / scikit-learn / XGBoost | Absent |
| MinIO / S3 | Absent |
| OpenTelemetry / Prometheus / Grafana / Langfuse | Absent |
| Docker / Compose | Installed during Phase 1 verification |
| pytest / Vitest / Playwright / Ruff / ESLint / Prettier | Absent |
| Go 1.25.6, gcc/g++/make/pkg-config/git | Present (`cmake`, `jq` absent) |

## 3. Environment facts

- Debian 12 (bookworm), x86_64, running inside a Firecracker microVM.
- CPU: 2 vCPU. RAM: 7.8 GiB total, ~1 GiB free before containers. Disk:
  20 GiB total, ~13 GiB free.
- Init is not systemd; long-running daemons (dockerd) must be started
  explicitly.
- Network egress works (PyPI and npm reachable).
- Ports in use: 3001 (existing API), 5173 (existing Vite), 5432 (Postgres),
  plus internal agent ports.
- Container runtime verified: dockerd 20.10.24 (overlay2, cgroupfs/2),
  container run, port publishing and Docker Compose v2.29.7 all functional.

## 4. Compatibility and dependency matrix (critical findings)

1. Container runtime: available. `compose.yaml` is the local development
   path; Kubernetes manifests target production.
2. pgvector: must be compiled from source into the existing cluster
   (`postgresql-server-dev-15` + gcc/make). Modern pgvector is a trusted
   extension, so the non-superuser `helix` role can `CREATE EXTENSION`.
3. Memory is the hard constraint: heavy services (OpenSearch, Kafka,
   Langfuse, MLflow, Grafana) run only under Compose profiles and/or on the
   deployment target.
4. No JVM: Kafka and OpenSearch require a JDK; run them in containers.
5. Existing UI is JavaScript; the AI console is a new TypeScript app.
6. Network egress is available for image pulls and package installs.

## 5. Reuse map

| AI platform need | Reused capability | Gap to add |
|---|---|---|
| Identity / authorization | `sessions` + `authorization` + editions | token -> actor + permission bridge for Python |
| Audit | audit service / audit tables | `ai` audit category |
| Events | event framework + `registerBusProvider` | Kafka adapter (or outbox reuse) |
| Indexing / long tasks | job management + job-execution engine | index job handlers |
| Files / object storage | files + file-storage | S3/MinIO provider |
| Full-text search | search provider registry | OpenSearch provider |
| Metadata / numbering / objects | metadata, numbering, objects | knowledge-source registry |

## 6. Proposed repository structure (additive)

```text
ai-platform/
├── apps/
│   ├── ai-api/            # Python + FastAPI
│   └── web-ai/            # React + TypeScript + Vite
├── services/              # copilot, retrieval, agent-runtime, indexing, model-management
├── packages/              # frontend-components, api-contracts, shared-types
├── infrastructure/
│   ├── docker/
│   ├── compose/
│   ├── kubernetes/
│   └── monitoring/
├── migrations/
├── scripts/
├── tests/
├── docs/
├── .env.example
├── compose.yaml
├── Makefile
└── README.md
```

## 7. Configuration and secrets plan

- `.env.example` is committed; the real `.env` is git-ignored.
- Local values use `AI_*` prefixes; no provider secret is ever committed or
  sent to the browser.
- Deployed environments use a secret manager; the repository stores
  references only.
- Missing or invalid required configuration fails fast with a clear message.
- A clearly-labelled mock LLM provider is used when no provider credentials
  are present.

## 8. Security risks and mitigations

- Retrieval must be authorization-filtered before results are returned and
  again before any protected tool action.
- pgvector similarity is never treated as authorization.
- Retrieved documents are untrusted data; embedded instructions cannot
  override platform policy.
- The Python service must not trust the browser; identity is derived from the
  enterprise session token and re-validated server-side.
- V1 agents are read-only; no writes to business objects.
- Secrets never appear in logs, responses, or source control.

## 9. Implementation sequence

Phase 1 environment/infrastructure -> Phase 2 structure -> Phase 3 database &
pgvector -> Phase 4 provider gateway -> Phase 5 API -> Phase 6 security ->
Phase 7 ingestion & RAG -> Phase 8 events -> Phase 9 agents -> Phase 10
frontend -> Phase 11 MLflow/predictive -> Phase 12 observability -> Phase 13
testing & security validation -> Phase 14 deployment readiness.

## 10. Agreed assumptions

1. This repository hosts the AI platform additively; nothing existing is
   removed.
2. Reuse over rebuild: the Node backend, PostgreSQL, IAM, audit, events, jobs,
   files and search remain authoritative; Python/FastAPI is the AI layer only.
3. The existing PostgreSQL instance is shared (tenant-scoped) for AI metadata
   and vectors.
4. No LLM credentials exist, so V1 demonstrates a labelled mock provider.
5. V1 agents are read-only.
6. Pinned versions are recorded; `latest` is not used.
7. Source-level ACLs are enforced by the platform, not by prompts.
8. The existing app keeps running on ports 3001/5173/5432.
9. Docker Compose and Kubernetes are the deployment artifacts.
10. Demo/test/synthetic data is explicitly labelled.

## 11. Resolved decisions

1. Container runtime: use local Docker + Compose profiles (verified working),
   plus Kubernetes manifests for production.
2. pgvector: compile from source into the existing cluster.
3. Local scope: run a lean profile locally; scaffold heavy services behind
   Compose profiles and deployment artifacts.
4. Frontend: new TypeScript app under `ai-platform/apps/web-ai`.
5. Auth integration: verify the enterprise session token and resolve
   permissions through the existing Node backend.
6. Event path: reuse the enterprise event framework; add a Kafka bus adapter.
7. Layout: the `ai-platform/` tree above.
8. Java services: run in containers (no host JVM required).
9. MLflow/Langfuse/Grafana: scaffolded and profile-gated.
10. Identity: AI features are gated by new `ai_*` feature codes and tenant
    scoping.
11. Migrations: AI tables follow the existing schema-migration marker
    approach, with versioned SQL under `ai-platform/migrations`.
