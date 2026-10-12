# ai-api

FastAPI service for the Enterprise AI Platform control plane. This is the seam layer
between the existing platform and the AI features; every request is authorized
server-side before any retrieval or action is attempted.

## Architecture

The app is organized as a strict, one-directional layered architecture:

| Layer | Path | Responsibility |
| --- | --- | --- |
| API | `src/ai_api/api` | HTTP transport: routes, request/response wiring, error mapping |
| Schemas | `src/ai_api/schemas` | Pydantic contracts for the public HTTP surface |
| Application | `src/ai_api/application` | Use cases / services orchestrating the domain |
| Domain | `src/ai_api/domain` | Pure domain models and errors (no frameworks) |
| Infrastructure | `src/ai_api/infrastructure` | Adapters to Postgres, Kafka, object store, providers |
| Security | `src/ai_api/security` | Authorization policies and principal plumbing |
| Telemetry | `src/ai_api/telemetry` | Structured logging, request context, OpenTelemetry |

Dependencies point inward: `api -> application -> domain`. Infrastructure implements
ports defined by the application/domain layers.

## Endpoints

All endpoints are under `/api/v1/ai` and require an enterprise session token
(`Authorization: Bearer <token>`); requests are authorized server-side before any
retrieval or action. Without a token the API returns `401`.

| Method | Path | Status | Notes |
| --- | --- | --- | --- |
| GET | `/healthz` | 200 | Liveness probe (outside the versioned prefix) |
| GET | `/api/v1/ai/health` | 200 | Readiness/detail for the AI API |
| GET | `/api/v1/ai/capabilities` | 200 | Version, models, providers, feature flags |
| GET | `/api/v1/ai/models` | 200 | Models exposed by the gateway |
| POST | `/api/v1/ai/chat` | 200 | Chat completion; records usage + audit |
| POST | `/api/v1/ai/summarize` | 200 | Summarization; records usage + audit |
| GET | `/api/v1/ai/knowledge/sources` | 200 | Paged knowledge sources |
| POST | `/api/v1/ai/knowledge/sources` | 201 | Register a knowledge source |
| POST | `/api/v1/ai/knowledge/index` | 202 | Enqueue an index job (idempotent) |
| GET | `/api/v1/ai/knowledge/jobs/{job_id}` | 200 | Job status |
| GET | `/api/v1/ai/usage` | 200 | Usage summary for the tenant |
| GET | `/api/v1/ai/usage/records` | 200 | Paged usage records |
| GET | `/api/v1/ai/audit` | 200 | Paged audit events |
| GET | `/api/v1/ai/agents` | 200 | Registered agents |
| GET | `/api/v1/ai/agents/{agent_id}` | 200 | Agent detail |
| POST | `/api/v1/ai/agents/{agent_id}/execute` | 503 | `planned:phase9` (fails closed) |
| POST | `/api/v1/ai/search` | 503 | `planned:phase7` (fails closed) |
| POST | `/api/v1/ai/rag/query` | 503 | `planned:phase7` (fails closed) |

Features not yet implemented fail closed with `503 feature_unavailable` rather than
returning a partial or insecure result. See `ai-platform/docs/PHASE5_AI_API.md`.

All errors are returned in a single envelope:

```json
{ "error": { "code": "not_found", "message": "Not Found", "details": {}, "request_id": "..." } }
```

Every response carries an `x-request-id` header (echoed or generated per request).

## Providers and the model gateway

Business code calls `ModelGateway` with a model code; it never references a
concrete provider. The gateway enforces capability checks, a rate limit,
timeouts, bounded retries, a per-provider circuit breaker, token-usage/cost
capture, and structured-output validation.

- Default provider is a clearly labelled **mock** (`LLM_PROVIDER=mock`), used
  when no provider credentials exist.
- A **LiteLLM** adapter (`litellm==1.105.0`) backs real providers; the client is
  imported lazily and injectable for tests.
- Secrets are never logged, returned, or sent to the browser.

See `ai-platform/docs/PHASE4_PROVIDER_GATEWAY.md` for configuration and usage.

## Security and governance

- **Identity**: the AI API does not implement authentication. It verifies the
  enterprise opaque session token against the enterprise IAM
  (`/api/auth/me` + `/api/authorization/effective/{userId}`) and fails closed on
  any error. In non-production a labelled development provider may be used.
- **Authorization**: every route requires an enterprise permission resolved from a
  configurable capability map; a configurable admin permission grants full access.
- **Governance**: per-tenant usage policies (model allow-list, prompt size, daily
  token quota, feature toggles, retention) are evaluated before each operation.
- **Prompt injection**: untrusted content is scanned and the system prompt is
  hardened; tenants may reject suspicious requests.
- **Secrets**: sensitive settings use `SecretStr`; secrets are never logged or
  returned.

See `ai-platform/docs/PHASE6_SECURITY_GOVERNANCE.md` for details.

## Local development

Requirements: Python 3.11+.

```bash
python3 -m pip install --break-system-packages -r requirements.txt -r requirements-dev.txt
python3 -m uvicorn ai_api.main:app --app-dir src --host 0.0.0.0 --port 8000
```

## Quality gates

```bash
ruff check src tests
python3 -m pytest
```

`pyproject.toml` sets `pythonpath = ["src"]` and `testpaths = ["tests"]`, so tests run
against the source tree without an editable install.
