# API

The AI service exposes a versioned HTTP API under `/api/v1/ai`. The interactive
OpenAPI schema is served by the app itself:

- Swagger UI: `GET /docs`
- ReDoc: `GET /redoc`
- OpenAPI JSON: `GET /openapi.json`

Base URL examples below are relative to `/api/v1/ai`.

## Authentication

Every endpoint except `/health` requires the enterprise session token, sent as
`Authorization: Bearer <token>`. The AI API validates the token against the
enterprise backend; the resulting principal carries the tenant, user and
effective permissions. Each route maps to a required capability/permission (see
`security.md`); missing permission yields `403`.

Requests may carry `x-request-id`; it is echoed in the response and used to
correlate logs, traces and audit records.

## Errors

Errors use a single envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Not allowed",
    "details": { "permission": "ai.agents:execute" },
    "request_id": "b1f0…"
  }
}
```

Common codes: `unauthorized` (401), `forbidden` (403), `not_found` (404),
`validation_error` (422), `rate_limited` (429), `provider_error` (502),
`server_error` (500).

## Pagination

List endpoints return `{ "items": [...], "total": n, "limit": l, "offset": o }`
and accept `limit`/`offset` query parameters.

## Endpoints

### Health and capabilities

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Detailed health (components). |
| GET | `/capabilities` | Feature capabilities for the caller. |
| GET | `/models` | Registered models. |
| GET | `/providers` | Provider registry (available/mock flags). |

Process probes `GET /healthz`, `GET /readyz` and `GET /metrics` sit at the root
(not under `/api/v1/ai`).

### Chat and reasoning

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/chat` | Single chat completion. |
| POST | `/chat/stream` | Server-Sent Events streaming completion. |
| POST | `/summarize` | Summarization. |

### Knowledge and retrieval

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/search` | Authorized semantic search. |
| POST | `/rag/query` | Grounded answer with citations (or insufficient evidence). |
| GET/POST | `/knowledge/sources` | List / create sources. |
| GET/DELETE | `/knowledge/sources/{source_id}` | Fetch / delete a source. |
| GET | `/knowledge/sources/{source_id}/documents` | List documents in a source. |
| POST | `/knowledge/sources/{source_id}/ingest` | Ingest documents. |
| POST | `/knowledge/index` | Enqueue indexing. |
| GET | `/knowledge/jobs`, `/knowledge/jobs/{job_id}` | Indexing job status. |

### Usage, audit and feedback

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/usage`, `/usage/records` | Usage summary and records. |
| GET | `/audit` | Audit events (mirror of enterprise audit). |
| GET/POST | `/feedback` | List / create feedback. |

### Agents

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/agents`, `/agents/{id}`, `/agents/{id}/versions` | Registry. |
| GET | `/agents/executions` | Execution history. |
| POST | `/agents/{id}/execute` | Run a read-only agent (bounded + audited). |

### Events

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/events`, `/events/stats`, `/events/dead-letters` | Inspect the event log. |
| POST | `/events/{event_id}/replay` | Replay a dead-lettered event. |

### ML tracking and registry

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ml/status` | Tracking backend status (honest availability). |
| GET/POST | `/ml/experiments`, `/ml/experiments/{id}`, `/ml/experiments/{id}/runs` | Experiments and runs. |
| GET/POST | `/ml/runs`, `/ml/runs/{id}`, `/ml/runs/{id}/finish` | Runs. |
| GET/POST | `/ml/models`, `/ml/models/{id}` | Model registry. |
| GET/POST | `/ml/models/{id}/versions`, `/ml/models/{id}/versions/{v}/status` | Versions and promotion. |
| GET/POST | `/ml/evaluations`, `/ml/evaluations/{id}`, `/ml/evaluations/{id}/results` | Evaluation definitions and results. |

## Streaming

`POST /chat/stream` returns `text/event-stream` frames:

```
event: delta
data: {"content":"Hello"}

event: done
data: {"model":"mock-chat","provider":"mock","is_mock":true,"usage":{"total_tokens":3}}
```

Proxies must disable buffering and use a long read timeout (see
`deployment.md`).

## Examples

```bash
# Chat.
curl -s -X POST http://127.0.0.1:8000/api/v1/ai/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'

# Grounded RAG query.
curl -s -X POST http://127.0.0.1:8000/api/v1/ai/rag/query \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"what is the torque spec?","limit":5}'
```

The console client (`web/src/aiApi.js`) wraps all of the above in JavaScript.
