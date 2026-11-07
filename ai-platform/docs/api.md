# API

The AI service exposes a versioned HTTP API under `/api/v1/ai`. In development
the app serves its own schema:

- Swagger UI: `GET /api/v1/ai/docs`
- OpenAPI JSON: `GET /api/v1/ai/openapi.json`
- ReDoc is disabled.

Both schema routes return `404` in production by default. Set
`AI_DOCS_ENABLED=true` only when a documented, temporary requirement exists.
Disabling the schema does not disable API routes. Base URL examples below are
relative to `/api/v1/ai`.

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

Process probes `GET /healthz` and `GET /readyz` sit at the root (not under
`/api/v1/ai`) and stay unauthenticated. `GET /metrics` is also at the root but
requires `Authorization: Bearer <AI_METRICS_AUTH_TOKEN>`; it returns `401` for a
missing/wrong token and `503` when no token is configured. Metrics are not
proxied by the console nginx.

### Chat and reasoning

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/chat` | Single chat completion. |
| POST | `/chat/stream` | Server-Sent Events streaming completion. |
| POST | `/summarize` | Summarization. |

### Knowledge and retrieval

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/search` | Authorized search. `mode` (`hybrid`/`lexical`/`semantic`), allowlisted `filters`, `sort`, `page`/`limit`; returns `mode`, `fallback`, `total`, per-result metadata and explainable `score_components`. |
| GET | `/search/facets` | Authorized facet counts (`q`, `mode`, `limit`, optional `filters` JSON) over the same ranked set as `/search`. |
| GET | `/search/suggestions` | Typeahead suggestions from the caller's own history/saved searches (`q`, `limit`). |
| GET/DELETE | `/search/history` | List / clear the caller's search history (personal, actor-scoped). |
| DELETE | `/search/history/{history_id}` | Delete one history entry (owner only). |
| GET/POST | `/search/saved` | List / create saved searches (stores the request, not results). |
| GET/DELETE | `/search/saved/{saved_id}` | Fetch / delete a saved search (owner only). |
| GET | `/search/health` | Tenant-scoped index health: counts (indexed/pending/stale/missing/failed), chunks/embeddings, last index time, job counts; `status` is `degraded` when the corpus has stale/missing/failed documents. |
| POST | `/rag/query` | Grounded answer with citations (or insufficient evidence). Accepts the same `mode` and allowlisted `filters` as `/search`; filters narrow the authorized candidate set. Required citation failures are reported via `answer_status: citation_warning`, `citation_status` and `warnings`. |
| GET/POST | `/knowledge/sources` | List / create sources. |
| GET/DELETE | `/knowledge/sources/{source_id}` | Fetch / delete a source. Fetch includes `version` for optimistic updates. |
| PUT | `/knowledge/sources/{source_id}/acl` | Replace the source ACL (`acl`, `expected_version`). Propagates to documents/chunks immediately; `409` when the version is stale. Requires `ai.knowledge:update`. |
| PUT | `/knowledge/sources/{source_id}/classification` | Raise or (platform-admin only) lower the source classification (`classification`, `expected_version`). `409` on stale version. Requires `ai.knowledge:update`. |
| GET | `/knowledge/sources/{source_id}/documents` | List documents in a source. |
| POST | `/knowledge/sources/{source_id}/ingest` | Ingest inline documents. |
| POST | `/knowledge/sources/{source_id}/upload` | Upload a file (multipart) and enqueue indexing. |
| POST | `/knowledge/sources/{source_id}/reindex` | Rebuild chunks/embeddings from stored content. |
| GET | `/knowledge/index-status` | Per-source index status plus a bounded list of problem documents. |
| POST | `/knowledge/reconcile` | Enqueue reindex jobs for sources with stale/missing/failed documents (skips sources with an active index job; never mutates content). |
| POST | `/knowledge/duplicates/scan` | Advisory duplicate/conflict scan over the tenant corpus (bounded by `AI_DEDUP_SCAN_LIMIT`). Records findings; never merges or deletes documents. Rescans update open findings and skip reviewed ones. |
| GET | `/knowledge/duplicates` | List duplicate/conflict findings (`status`, `kind`, pagination). |
| GET | `/knowledge/duplicates/{finding_id}` | Fetch one finding. |
| POST | `/knowledge/duplicates/{finding_id}/review` | Mark a finding `dismissed` or `resolved` with an optional note (owner-audited). |
| GET | `/knowledge/documents/{document_id}` | Fetch one document (same ceiling/ACL checks as listing). Includes `version` and `metadata`. |
| PATCH | `/knowledge/documents/{document_id}` | Update `title`/`metadata` only (content untouched). Bumps `version`, records history, refreshes the search copy. `409` on stale `expected_version`. Requires `ai.knowledge:update`. |
| GET | `/knowledge/documents/{document_id}/versions` | Metadata-only version history (newest first): `version`, `title`, `reason` (`superseded`/`metadata_update`/`deleted`), `superseded_at`. Never includes chunk text. |
| POST | `/knowledge/documents/{document_id}/reindex` | Rebuild chunks/embeddings for a single document, clamped to current labels. |
| GET | `/knowledge/documents/{document_id}/download` | Stream stored bytes (authorized). |
| DELETE | `/knowledge/documents/{document_id}` | Delete a document and its chunks; records a `deleted` version snapshot. |
| POST | `/knowledge/index` | Enqueue indexing. |
| GET | `/knowledge/jobs`, `/knowledge/jobs/{job_id}` | Indexing job status. |
| POST | `/knowledge/jobs/{job_id}/retry` | Requeue a failed/queued job. |

Search/`rag_query` filters are validated against a fixed allowlist:
`source_id`, `source_code`, `classification`, `mime_type`, `external_id`,
`document_status`, `section`, `page`, plus the document-metadata keys
`product`, `part_number` and `revision` (resolved from `documents.metadata`,
backed by expression indexes). An unknown field returns `422`. Filters only ever
narrow the already-authorized set.

### Assistant conversations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/assistant/capabilities` | Per-task availability, streaming support and context requirements (feature-policy resolved server-side). |
| GET/POST | `/assistant/conversations` | List (actor-scoped by default; `mine=false` requires platform admin) / create conversations. |
| GET/PATCH/DELETE | `/assistant/conversations/{conversation_id}` | Fetch, rename (bounded title) or delete a conversation. |
| GET | `/assistant/conversations/{conversation_id}/messages` | Page through persisted messages oldest-first. |
| POST | `/assistant/conversations/{conversation_id}/messages` | Ask/explain with a grounded answer; persists message status, citation diagnostics (`warnings`, `citations_required`, `citation_status`), prompt version and citation snapshots. Accepts `task`, `context`, `output_format`, `fields` and `parent_message_id` (retry). |
| POST | `/assistant/conversations/{conversation_id}/messages/stream` | SSE variant for `ask`/`explain`: `start`, `delta`, `done`, `error` events, then the persisted message. |
| POST | `/assistant/conversations/{conversation_id}/cancel` | Best-effort cancellation flag for an in-flight generation. |
| POST | `/assistant/summarize` | Stateless summarize task over authorized `knowledge_document` context. |
| POST | `/assistant/explain` | Stateless explain task (streaming-capable). |
| POST | `/assistant/compare` | Compare at least two authorized sources; evidence-backed, never modifies sources. |
| POST | `/assistant/extract` | Typed field extraction with evidence references and explicit missing values. |
| POST | `/assistant/feedback`, `/assistant/messages/{message_id}/feedback` | Rate an answered message (optional category). |

Context items are typed pointers (`{"type": "knowledge_document", "id": "74"}`),
never content. The server re-resolves each reference against the caller's
tenant, ACLs and classification ceiling, and drops anything unauthorized
without revealing whether it exists. Similarity scores are never used as an
authorization signal. Mock-provider output is explicitly labelled and must not
be treated as real analysis.

### Usage, audit and feedback

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/usage`, `/usage/records` | Usage summary and records. |
| GET | `/audit` | Audit events (mirror of enterprise audit). |
| GET/POST | `/feedback` | List / create feedback. |

### Agents

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/agents` | List authorized agents / create a draft (requires manage capability). |
| GET/PATCH | `/agents/{id}` | Details / update a draft with `lock_version` optimistic locking. |
| POST | `/agents/{id}/validate` | Validate definition, tools, schemas, steps and budgets. |
| POST | `/agents/{id}/publish` | Publish a validated immutable version. |
| POST | `/agents/{id}/disable` | Disable new executions. |
| POST | `/agents/{id}/rollback` | Activate a previously published version. |
| GET | `/agents/{id}/versions`, `/agents/{id}/versions/{version_id}/tools` | Version history and pinned tool snapshot. |
| GET/POST | `/agent-tools` | List / register a versioned tool. |
| GET/PATCH | `/agent-tools/{id}` | Tool detail / draft metadata update. |
| GET/POST | `/agent-tools/{id}/versions` | Tool version history / new draft version. |
| POST | `/agent-tools/{id}/validate`, `/agent-tools/{id}/publish` | Validate and publish a tool version. |
| POST/GET | `/agent-executions` | Request a durable execution / list executions. |
| GET | `/agent-executions/{id}`, `/trace`, `/result` | Status, steps, budgets, trace and completed result. |
| POST | `/agent-executions/{id}/cancel`, `/retry` | Request cancellation / retry an eligible failure. |
| GET | `/agent-approvals`, `/agent-approvals/{id}` | Approval inbox and exact-operation evidence. |
| POST | `/agent-approvals/{id}/approve`, `/reject` | Human decision; approval releases the paused execution. |
| POST | `/assistant/agents/run` | Copilot-initiated run through the same execution engine and audit path. |
| GET | `/agents/executions` | Legacy synchronous execution history. |
| POST | `/agents/{id}/execute` | Legacy read-only convenience endpoint (bounded + audited). |

Published agent and tool versions are immutable; the model cannot supply
permissions, tenant identity, approvals or authoritative tool arguments.

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

# Upload a file to a source (multipart; the browser sets the boundary).
curl -s -X POST http://127.0.0.1:8000/api/v1/ai/knowledge/sources/1/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@manual.pdf;type=application/pdf"

# Ask the grounded assistant (persists the answer and its citations).
curl -s -X POST http://127.0.0.1:8000/api/v1/ai/assistant/conversations/1/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"what is the torque spec?"}'
```

The console client (`web/src/aiApi.js`) wraps all of the above in JavaScript.
