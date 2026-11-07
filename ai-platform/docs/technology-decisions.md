# Technology decisions and licensing

This document records the chosen technologies, the versions tested, their
licenses, the rationale, and the external/commercial dependencies that sit
outside the open-source stack. It complements `architecture.md`.

## Language and frameworks

| Component | Version tested | License | Rationale |
| --- | --- | --- | --- |
| Python | 3.11 | PSF | Team standard; mature async ML ecosystem. |
| FastAPI | 0.143.0 | MIT | Typed, async, OpenAPI-native. |
| Uvicorn | 0.54.0 | BSD-3-Clause | ASGI server. |
| Pydantic / pydantic-settings | 2.14.1 / 2.15.0 | MIT | Validation + typed env configuration. |
| structlog | 26.1.0 | Apache-2.0 / MIT | Structured, correlated logs. |
| httpx | 0.28.1 | BSD-3-Clause | Async HTTP for providers, MLflow, enterprise IAM. |
| asyncpg | 0.32.0 | Apache-2.0 | Fast async PostgreSQL driver. |
| litellm | 1.105.0 | MIT | Multi-provider gateway with a single interface. |
| LangGraph | 1.2.14 | MIT | Bounded, typed agent runtime. |
| prometheus-client | 0.23.1 | Apache-2.0 | Metrics exposition. |
| OpenTelemetry (api/sdk/instrumentation/exporter) | 1.45.1 / 0.66b1 | Apache-2.0 | Vendor-neutral tracing. |
| jsonschema | 4.26.0 | MIT | Tool/agent argument validation. |
| ruff | 0.17.0 | MIT | Lint + format. |
| pytest / pytest-asyncio / pytest-cov | 9.1.1 / 1.4.0 / 7.1.0 | MIT / Apache-2.0 | Test framework. |

## Data and infrastructure

| Component | Version tested | License | Rationale |
| --- | --- | --- | --- |
| PostgreSQL | 15.x | PostgreSQL License | Shared enterprise database (reused). |
| pgvector | 0.8.x | PostgreSQL License | Vector similarity inside the shared DB; no separate store in V1. |
| Redis | 7.2.16 | BSD-3-Clause | Cache / ephemeral state only (never authoritative). |
| OpenSearch | 2.19.6 | Apache-2.0 | Optional hybrid/full-text search. |
| Apache Kafka | 3.9.2 | Apache-2.0 | Optional event transport (DB outbox is the default). |
| SeaweedFS (S3) | 3.80 | Apache-2.0 | S3-compatible object storage for local/dev. |
| MLflow | 3.8.1 | Apache-2.0 | Optional experiment tracking / registry backend. |
| OpenTelemetry Collector | 0.162.0 | Apache-2.0 | Trace/metrics pipeline. |
| Prometheus | 2.53.5 | Apache-2.0 | Metrics storage/scraping. |
| Grafana | 13.2.3 | AGPL-3.0 | Dashboards. **AGPL** — deploy as an isolated service, not linked code. |
| Langfuse | 4.56.0 | MIT (core) | Optional LLM generation tracing; features marked EE are commercial. |
| nginx (unprivileged) | 1.27 | BSD-2-Clause | Console static serving + reverse proxy. |

## Frontend

| Component | Version tested | License |
| --- | --- | --- |
| React / React DOM | 18 (console) / 19 (web-ai) | MIT |
| Vite | 6 (console) / 8 (web-ai) | MIT |
| React Router | 6 / 7 | MIT |
| Vitest + Testing Library | 2 / 16 | MIT |
| jsdom | 25 | MIT |

## Decisions

1. **Reuse the existing platform** for identity, authorization, audit, events,
   jobs, files and search. The AI layer adds no parallel IAM or audit store.
2. **pgvector in the shared PostgreSQL** for V1 vectors. Embeddings are fixed
   at 1536 dimensions (a `CHECK` constraint). A dedicated vector database can
   replace the adapter later without changing callers.
3. **PostgreSQL is the authorization-metadata authority**; similarity ranking
   never grants access. ACL filters are applied in the query and re-checked on
   results and tool calls.
4. **Durable database outbox by default**, with Kafka as an optional transport
   (`EVENT_BUS_PROVIDER`). This avoids making Kafka a hard dependency.
5. **A clearly-labelled mock provider is the default.** No fabricated quality
   metrics; real model quality requires a configured provider and the opt-in
   live test suite.
6. **Langfuse and OpenTelemetry are fail-open** no-ops when disabled/unreachable.

## External / commercial services (not part of the open-source stack)

Documented separately so they are not assumed to be bundled:

- **Managed PostgreSQL** with pgvector (cloud RDS/Cloud SQL/etc.) or self-hosted.
- **Object storage** (cloud S3/GCS/Azure Blob) or self-hosted SeaweedFS/MinIO.
- **Managed Kafka** (e.g. Confluent, MSK) — only if `EVENT_BUS_PROVIDER=kafka`.
- **Secret manager** (Vault, cloud KMS/Secrets Manager, Sealed Secrets).
- **TLS / ingress / DNS / CDN** provided by the customer's cluster.
- **LLM provider** — any that litellm supports (OpenAI, Anthropic, Azure OpenAI,
  Bedrock, a self-hosted OpenAI-compatible endpoint). Costs and terms are the
  customer's; keys are supplied via secrets and never committed or logged.
- **Langfuse Cloud** — optional managed tracing if not self-hosting.

## Unimplemented / deferred (honest scope)

- V1 agents are **read-only**; write actions and human-in-the-loop approvals are
  scaffolded but not wired to real side effects.
- The ML layer tracks experiments, models and evaluations; it does **not** serve
  models or claim validated manufacturing predictions.
- No dedicated vector database, feature store, or model-serving runtime.
- Windows/macOS deployment is not supported; targets Linux containers +
  Kubernetes.
