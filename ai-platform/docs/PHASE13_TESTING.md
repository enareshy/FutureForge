# Phase 13 — Testing and Security Validation

This document describes the Phase 13 test strategy for the Enterprise AI Platform:
what is covered, how to run each suite, and how external dependencies are isolated
so the default suite stays hermetic and fast.

The suite is split into four layers that mirror the phase plan: **unit**,
**integration**, **end-to-end**, and **AI evaluation**, plus a **frontend** suite
for the enterprise console. Repeatable tests use mocks; anything that needs a real
external system is opt-in and skipped by default.

## Goals

- Prove domain/application logic, API validation, authorization policies, provider
  adapters, chunking/indexing, retry/idempotency and event processing behave as
  specified.
- Prove the security properties: ACL is enforced before retrieval and tool
  execution, prompt injection is treated as data, and unauthorized documents are
  never returned.
- Prove the end-to-end copilot path: sign in, register a document, index it, query
  it through RAG, see citations, and confirm cross-tenant isolation.
- Evaluate AI output quality deterministically against the labeled mock provider.
- Exercise the console (rendering, API errors, auth states, citations, resilience).

## Layers and how to run them

All backend commands run from `apps/ai-api`:

```bash
# Unit + application + API + deterministic AI evaluation (hermetic, default).
PYTHONPATH=src python3 -m pytest

# Lint.
ruff check src tests scripts

# Full request path with the in-memory repository/vector store.
PYTHONPATH=src python3 -m pytest -m e2e

# Integration suite (each service is individually opted into).
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -m integration
```

The frontend suite runs from the repository root (vitest + Testing Library):

```bash
npm run test:web        # single run
npm run test:web:watch  # watch mode
```

## Unit and application tests

The default run covers the domain and application layer with the in-memory
repository and a deterministic mock provider:

| Area | Representative files |
| --- | --- |
| API contracts and validation | `test_api_v1.py`, `test_errors.py` |
| Authorization policies / permissions | `test_permissions.py`, `test_access_control.py` |
| Provider adapters and gateway | `test_model_gateway.py`, `test_litellm_adapter.py`, `test_mock_provider.py` |
| Ingestion, chunking, indexing | `test_ingestion.py`, `test_retrieval.py` |
| Reliability: retries, idempotency, dead letters | `test_reliability.py`, `test_events.py` |
| Agents and tool authorization | `test_agents.py` |
| Governance, prompt safety, identity | `test_governance.py`, `test_prompt_safety.py`, `test_enterprise_identity.py` |
| ML tracking foundation | `test_ml.py` |
| Observability | `test_observability.py` |

`tests/conftest.py` configures a hermetic environment: `AI_REPOSITORY=memory`,
`EVENT_BUS_PROVIDER=database`, a quiet log level and a shared development
principal. No network, database or container is required.

## End-to-end tests (`tests/test_e2e_copilot.py`)

Marked `e2e` and run by default. They exercise the full request path against the
FastAPI app with the in-memory backing services:

- Unauthenticated requests are rejected; sign-in succeeds with the configured test
  identity.
- Register → index → query through the copilot, asserting the answer cites only
  authorized chunks.
- Audit records are written and correlate with the echoed request id.
- An event is published for the ingestion/indexing lifecycle.
- A second principal cannot retrieve the first principal's restricted document.

## Integration tests (`tests/test_integration_services.py`)

Marked `integration` and **opt-in per service** via `AI_TEST_*` variables:

| Variable | Service |
| --- | --- |
| `AI_TEST_POSTGRES` | PostgreSQL + pgvector (cosine/HNSW roundtrip) |
| `AI_TEST_REDIS` | Redis cache |
| `AI_TEST_KAFKA` | Kafka event bus |
| `AI_TEST_OPENSEARCH` | OpenSearch index |
| `AI_TEST_OBJECT_STORAGE` | S3-compatible object storage |
| `AI_TEST_MLFLOW` | MLflow tracking backend |
| `AI_TEST_OTLP` | OTLP/observability endpoint |
| `AI_TEST_LIVE_LLM` | A real LLM provider (needs provider credentials) |

Each test skips with an actionable message when its flag is unset, so a partially
provisioned environment still runs cleanly.

## Live smoke suite (`tests/test_live_smoke.py`)

Marked `live` and skipped unless `AI_E2E=1`. It targets a running deployment and
reads its location and credentials from the environment:

```bash
AI_E2E=1 \
AI_E2E_BASE_URL=http://127.0.0.1:8000 \
AI_E2E_TOKEN=<session-token> \
PYTHONPATH=src python3 -m pytest -m live
```

It checks liveness, readiness, the Prometheus exposition, that protected endpoints
require authentication, and (when a token is supplied) an authenticated chat and
search roundtrip.

## AI evaluation (`tests/test_ai_evaluation.py`)

Deterministic evaluation against the labeled mock provider — repeatable and free of
external calls. It asserts the properties the platform must hold, not a score on a
public benchmark:

- **Retrieval relevance**: recall@k and MRR on a small labeled set.
- **Citation correctness**: every citation refers to a returned, authorized chunk.
- **Groundedness**: the grounded answer only uses authorized context.
- **Insufficient evidence**: with no relevant context the platform reports
  insufficient evidence and fabricates no citations.
- **Prompt injection resistance**: instructions embedded in retrieved content are
  treated as data.
- **Unauthorized leakage**: a restricted document never appears in results for a
  principal without access — even for the same similarity ranking.
- **Provider failure recovery**: transient failures are retried and a persistent
  failure maps to a `502` without leaking internals.

Real model quality is out of scope for the default suite and belongs in the opt-in
`AI_TEST_LIVE_LLM` path.

## Frontend tests (vitest + Testing Library)

The console (`/web`) uses **vitest** with **jsdom** and Testing Library. Config
lives in `vite.config.js` (`test` block) with a shared setup file at
`web/src/test/setup.js`.

| File | Coverage |
| --- | --- |
| `web/src/aiApi.test.js` | Request building (`/api/v1/ai` prefix, bearer token attach/omit, JSON body, query strings); error-envelope mapping to `AiApiError` (status/code/message/request id/details); non-JSON fallback; timeout/abort; SSE `delta`/`done` parsing; stream error frames; pre-stream HTTP errors. |
| `web/src/aiMarkdown.test.jsx` | Safe Markdown rendering (headings, lists, code, emphasis, links with `rel="noopener noreferrer"`); injected HTML is shown as literal text and never executed; `javascript:` pseudo-links are not linkified. |
| `web/src/pages/AiChatPage.test.jsx` | Copilot header/empty state; grounded answers with source-citation display; insufficient-evidence state with no fabricated citations; API error banner including request id; authentication (401) state; SSE token streaming and indicator clearing; cancelled stream handling. |
| `web/src/components/ErrorBoundary.test.jsx` | A throwing view shows a readable fallback; retry re-renders children. |

The frontend tests mock `fetch` and the `aiApi` module, so they run without a
backend.

### Defect found by the suite

Writing the citation/link tests surfaced a real bug in the Markdown renderer
(`web/src/aiMarkdown.jsx`): the inline link branch read the wrong regex capture
groups, so `[text](https://…)` links were rendered as plain text. The groups were
corrected (`match[4]`/`match[5]`/`match[6]`), and the regression is now covered by
`web/src/aiMarkdown.test.jsx`.

## What is explicitly not covered

- **No fabricated metrics or quality scores.** Evaluation asserts held properties
  against mocks; it does not claim manufacturing-useful model accuracy.
- **No live-provider assertions in the default run.** External providers, OpenSearch,
  Kafka, Redis, object storage and MLflow require the opt-in flags above.
- **No security scanning or offensive testing.** This phase validates the platform's
  own authorization and data-isolation behavior with unit/integration tests.

## Results

- Backend: **134 passed, 14 skipped** (skips are the opt-in integration/live tests).
- Frontend: **23 passed** (4 files).
- `ruff check src tests scripts`: clean.
