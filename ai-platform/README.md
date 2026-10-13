# Enterprise AI Platform — V1

AI foundation layer for the FutureForge enterprise lifecycle platform (PDM,
PLM, MES, SLM, engineering, manufacturing, quality, service). It is an
**additive** layer: the existing Node/Express enterprise backend, PostgreSQL
database, IAM, audit, events, jobs, files and search remain authoritative.
Python/FastAPI provides the AI service layer.

See `../docs/ai-platform/PHASE0_DISCOVERY.md` for the Phase 0 assessment and
the full phase plan.

## Layout

```text
ai-platform/
├── apps/
│   ├── ai-api/            # Python + FastAPI service (Phase 2+)
│   └── web-ai/            # React + TypeScript console (Phase 2+)
├── services/              # copilot, retrieval, agent-runtime, indexing, model-management
├── packages/              # frontend-components, api-contracts, shared-types
├── infrastructure/
│   ├── docker/
│   ├── compose/
│   ├── kubernetes/        # production manifests (Phase 14)
│   └── monitoring/        # otel, prometheus, grafana
├── migrations/            # versioned SQL for the `ai` schema
├── scripts/               # setup / up / down / migrate / health
├── tests/
├── docs/
├── compose.yaml
├── Makefile
└── .env.example
```

## Local stack (Docker Compose)

PostgreSQL is **not** containerised: the platform reuses the enterprise
PostgreSQL instance (with the `pgvector` extension). Everything else runs in
containers behind Compose profiles.

| Profile | Services | Notes |
|---|---|---|
| (default) | `redis`, `objectstore` (SeaweedFS S3) | fits the lean headroom |
| `search` | `opensearch` | ~1.5 GiB RAM |
| `events` | `kafka` | ~1 GiB RAM |
| `mlops` | `mlflow` | light |
| `observability` | `otel-collector`, `prometheus`, `grafana` | |
| `llmops` | `langfuse` + PostgreSQL + ClickHouse | heavy, needs >= 4 GiB RAM |

## Quick start

```bash
# One-shot bootstrap: .env, docker daemon, lean stack, migrations, health
make setup

# Or step by step
make env        # copy .env.example -> .env
make daemon     # start the Docker daemon (no systemd in this VM)
make up         # start the lean stack
make migrate    # apply SQL migrations to the `ai` schema
make health     # verify pgvector, schema and containers

# Extra profiles
PROFILES=observability ./scripts/up.sh
```

## Ports (host, loopback only)

| Service | Port |
|---|---|
| AI API (FastAPI) | 8000 |
| Redis | 6379 |
| SeaweedFS S3 | 8333 |
| SeaweedFS master | 9333 |
| OpenSearch | 9200 |
| Kafka | 9092 |
| MLflow | 5000 |
| Prometheus | 9090 |
| Grafana | 3100 |
| OTLP gRPC / HTTP | 4317 / 4318 |
| Langfuse | 3300 |

The existing enterprise backend keeps running on 3001 (API) and 5173 (web).

## Documentation

- `docs/installation.md` — prerequisites and installation
- `docs/configuration.md` — environment variables and secrets
 - `docs/PHASE7_KNOWLEDGE_RAG.md` — knowledge ingestion, retrieval and RAG
 - `docs/PHASE8_EVENTS.md` — durable event streaming and background processing
 - `docs/PHASE9_AGENTS.md` — agent framework and the Enterprise Knowledge Assistant
  - `docs/PHASE10_FRONTEND.md` — enterprise console integration, feedback, providers and SSE chat
  - `docs/PHASE11_ML.md` — experiment tracking, model registry and evaluation foundation
  - `migrations/README.md` — database migration conventions
  - `../docs/ai-platform/PHASE0_DISCOVERY.md` — Phase 0 assessment and plan

## Status

Phases 0-11 complete: infrastructure, application skeleton, provider gateway,
the AI API (capabilities/chat/summarize/knowledge/usage/audit/agents), enterprise
security and governance, knowledge ingestion + authorized RAG, durable event
streaming with a background consumer, a LangGraph-based read-only agent
framework with the Enterprise Knowledge Assistant, integration of the AI
surface into the existing enterprise console (feedback capture, read-only
provider view and SSE chat streaming), and an experiment-tracking / model-registry
/ evaluation foundation with an optional MLflow backend and a synthetic reference
pipeline (training, evaluation, and inference kept separate; no serving).
Do not treat any demo, mock or synthetic value as production data.
