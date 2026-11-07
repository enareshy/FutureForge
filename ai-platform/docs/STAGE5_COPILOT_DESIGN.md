# Stage 5 — Enterprise AI Copilot (architecture discovery and design)

This is the Phase 0 deliverable for Stage 5. It records what exists in the
repository, what is reused, what must be added, and the contracts the
implementation follows. It is intentionally conservative: no duplicate
conversation store, retrieval engine, identity system or LLM gateway.

## 1. What already exists

### AI API (`ai-platform/apps/ai-api`)

| Capability | Existing implementation | Reuse decision |
|---|---|---|
| Identity / tenant | `security/identity.py`, `security/enterprise_identity.py` (enterprise session bridge) | Reuse unchanged; server resolves identity, never the browser |
| Authorization | `security/access_control.py`, `security/policies.py`, `api/deps.py` capabilities | Reuse; every retrieval and context read stays ACL/classification-aware |
| Conversations | `ai.assistant_conversations`, `ai.assistant_messages`, `ai.assistant_message_sources` (migration 0008) | **Extend**, do not duplicate |
| Conversation API | `/api/v1/ai/assistant/conversations` (create/list/get/delete, post message, feedback) | Extend with rename, message pagination, cancel, tasks |
| RAG / retrieval | `RetrievalService` (hybrid + lexical + semantic, RRF, authorization-before-ranking, honest fallback, citations) | Reuse as the single retrieval path |
| Enterprise search | `SearchService`, `/search/*`, facets/health/saved/history (Stage 4) | Reuse for retrieval; no second index |
| LLM gateway | `ModelGateway` (providers, timeouts, retries, streaming, usage) | Reuse; no provider logic in Copilot services |
| Governance / limits | `GovernanceService`, rate limiting, token/cost policy | Reuse |
| Prompt hardening | `security/prompt_safety.py` (`PromptGuard`) | Reuse in every Copilot prompt |
| Prompt storage | `ai.prompt_templates`, `ai.prompt_versions` (migration 0002, currently unused by services) | Reuse as the override path; ship versioned built-in defaults |
| Feedback | `ai.feedback`, `FeedbackService`, `/feedback`, `/assistant/feedback` | Extend categories; keep message link |
| Audit / telemetry | `AuditService`, OpenTelemetry spans, Prometheus metrics, Langfuse metadata | Reuse and add Copilot spans/metrics |
| Knowledge documents | `ai.documents` (classification, ACL, status, revision timestamps), chunks | Use as the first context adapter source |
| Agents | `AgentService`, versioned read-only knowledge assistant (Phase 9) | Reuse concepts; do **not** add a second agent framework for deterministic tasks |

### Helix enterprise platform (`server/`, `web/`)

- Enterprise IAM/session, tenants, RBAC/ABAC, audit and enterprise records
  (`/api/objects`, `/api/content`, `/api/bom`, `/api/requirements`, changes).
- Enterprise search (`/api/search/*`) and a search UI.
- The main console already proxies `/api/v1/ai/*` to the AI API.

The Copilot lives in the existing console (`web/`), inside the AI Platform
navigation, not as a separate application. `apps/web-ai` is a dashboard shell
only and is not reused for Copilot.

## 2. Gap assessment

| Stage 5 requirement | Current state | Work |
|---|---|---|
| Multi-turn context | Each answer ignores prior messages | Add server-side bounded history builder + optional stored summary |
| Rename / message pagination | Missing (get all messages, no PATCH) | Add PATCH conversation, paginated GET messages |
| Cancellation / generation status | No persisted status, no cancel | Add generation status + cancellation endpoint and cooperative checks |
| Streaming assistant | Only generic `/chat/stream` | Add grounded Copilot streaming endpoint when enabled |
| Context references | None | Adapter framework + `knowledge_document` adapter, persisted refs |
| Summarization / explanation | Generic `/summarize` accepts arbitrary text, no grounding/citations | Add grounded document summarization and explanation tasks |
| Comparison | None | Structured sentence diff + grounded synthesis with per-source evidence |
| Structured extraction | None | Typed, evidence-backed extraction with configurable fields |
| Task routing | None | Lightweight typed task dispatcher (no autonomous agent runtime) |
| Prompt versioning | Tables exist, services use inline strings | Versioned prompt templates + prompt version recorded on messages |
| Feedback categories | Rating/comment only | Add category + links; keep rating |
| Evaluation | RAG/search evaluation exists | Add Copilot grounding/citation/comparison/extraction/security evaluation |
| Context-aware UI | Chat page with citations and ratings | Copilot workspace: history, context picker, tasks, stop/retry/copy |

## 3. Service boundary and contracts

### 3.1 API namespace decision

Stage 3 already owns `/api/v1/ai/assistant/*`. The spec's `/copilot/*` endpoints
are proposals; the platform rule is to reuse equivalent endpoints. Therefore:

- Conversation lifecycle stays under `/api/v1/ai/assistant/*` (backward
  compatible), extended additively:
  - `PATCH /assistant/conversations/{id}` — rename (and archive).
  - `GET /assistant/conversations/{id}/messages?limit&offset` — paged history.
  - `POST /assistant/conversations/{id}/cancel` — cancel the active generation.
  - `POST /assistant/conversations/{id}/messages` — now accepts `task`,
    `context[]`, `output_format`, `parent_message_id` (retry/regenerate).
  - `POST /assistant/conversations/{id}/messages/stream` — SSE (grounded).
  - `POST /assistant/messages/{id}/feedback` — spec-compatible alias.
- Task endpoints (stateless, still authorize every source):
  - `POST /assistant/summarize`
  - `POST /assistant/explain`
  - `POST /assistant/compare`
  - `POST /assistant/extract`
  - `GET /assistant/capabilities`

No duplicate `/copilot` surface is added.

### 3.2 Request/response contracts

- `task`: `ask | summarize | explain | compare | extract` (default `ask`).
- `context[]`: `{type, id}` only. Types are server-registered; IDs are stable
  server identifiers. Client-supplied names/metadata/permissions are ignored.
- `context` resolution returns a normalized `ContextRef`:
  `type, object_id, display_name, source_system, revision, lifecycle_state,
  metadata, provenance`.
- `output_format`: `markdown | executive | technical | bullets | json` where the
  task supports it.
- Responses include `task_type`, `generation_status`, `answer_status`,
  `warnings`, `citations_required`, `citation_status`, `prompt_version`,
  `is_mock`, `citations`/`context` and `request_id`.
- `answer_status` is `answered` only when required citations validate. Missing
  or invalid citations downgrade it to `citation_warning` (with `citation_status`
  `missing`/`invalid` and opaque warnings); insufficiency, cancellation and
  provider errors use `insufficient_evidence`, `cancelled` and `error`. The
  same values are persisted and returned by streaming `done` events.
- Errors keep the platform envelope (`{error:{code,message,details,request_id}}`).

### 3.3 Retrieval and grounding

One path only: `RetrievalService`. Copilot adds:

1. Bounded conversation history (`CopilotHistoryBuilder`), never the full log.
2. Authorized context resolution (`ContextService` + adapters).
3. Evidence assembly: retrieved chunks + resolved context chunks, deduplicated
   by chunk id, bounded by characters/tokens.
4. Prompt hardening (`PromptGuard`) and evidence-labelled context.
5. Citation validation: every citation id must exist in the evidence set; the
   model cannot invent sources. Citations are persisted as snapshots.
6. Insufficient evidence is explicit when no authorized evidence exists or the
   similarity gate fails (lexical-only mode uses match presence).

Context adapters verify authorization server-side before returning content:
tenant scope, ACL and classification ceiling. Frontend identifiers cannot widen
scope. Unauthorized/missing objects return the same not-found shape.

## 4. Data model (migration 0011, additive)

Extend the Stage 3 conversation model; do not create new conversation tables.

- `ai.assistant_messages` add:
  - `task_type` (`ask|summarize|explain|compare|extract`).
  - `generation_status` (`pending|streaming|completed|cancelled|failed`).
  - `prompt_version`, `parent_message_id` (retry/regenerate), `cancelled_at`.
- `ai.assistant_context_refs` (new): per-message context references with
  `context_type`, `object_id`, display/source/revision/lifecycle metadata and
  provenance; tenant-scoped, FK cascade.
- `ai.assistant_conversation_summaries` (new): one active derived summary per
  conversation with `through_message_id`; never treated as authoritative.
- `ai.feedback` add `category` (`helpful|not_helpful|incorrect|
  missing_information|poor_citations|other`), indexed; rating/comment retained.

No new tables for prompts (reuse 0002), citations (reuse 0008) or feedback.

## 5. Security design

- Identity/tenant always resolved server-side; client metadata is not trusted.
- Conversation access requires tenant + ownership; cross-user/cross-tenant
  attempts return 404 (no existence oracle).
- Every context id and every retrieval query is re-authorized at request time;
  no cached context bypasses permission changes.
- Context and citations never include content the caller cannot access.
- Stored answers/citations are snapshots for audit, but new turns re-retrieve
  live; a revoked source cannot be used to answer a later question.
- Prompt injection: retrieved content is fenced and labelled untrusted; system
  rules are hardened; output is rendered as sanitized Markdown (no HTML).
- No enterprise mutations: Stage 5 only reads; no tool execution endpoints.
- Request limits: message size, context count, history size, evidence size,
  output tokens, rate limiting and timeouts.
- Secrets/tokens are never logged; prompts and document bodies are not logged by
  default.

## 6. Observability

- Spans: `ai.copilot.ask`, `ai.copilot.task`, `ai.copilot.context`,
  `ai.copilot.stream`, plus existing retrieval/model spans.
- Metrics: Copilot requests by task/status, latency, cancellation, citation
  validation failures, context size, retrieval latency and feedback categories.
- Correlation: existing `request_id` is persisted on messages and propagated.

## 7. Testing and evaluation plan

- Unit: history bounds, context authorization, prompt construction, task
  routing, citation validation, extraction schema validation, feedback.
- Integration: persistence, retrieval, gateway (mock), streaming/cancel.
- Security: cross-user/tenant, unauthorized context ids, revoked access,
  prompt injection, citation leakage, malicious Markdown, request abuse.
- End-to-end scenarios 1–8 from the spec.
- Evaluation dataset: grounded QA, summary fidelity markers, comparison
  differences, extraction validity, insufficient evidence, leakage checks.
  Results are recorded as signals, not claims of real-model quality.

## 8. Phase plan and exact change surface

1. Contracts + migration 0011; repository ports/implementations (conversation
   update, paged messages, context refs, message status, document chunks,
   summary, feedback category).
2. Conversation management (rename, pagination, cancel, status).
3. Context framework + `knowledge_document` adapter; bounded history.
4. Grounding upgrade (history/context in prompts, citation validation).
5. Tasks: summarize, explain, compare, extract; typed output validation.
6. Prompt registry/versioning + capability discovery.
7. Feedback categories + evaluation dataset.
8. Security/observability/performance tests.
9. Frontend Copilot workspace (history, context, tasks, stop/retry/copy,
   citation inspection, feedback categories).
10. Docs, config, final report.

## 9. Explicit non-goals and limitations

- No autonomous tool execution, enterprise writes, approvals or unrestricted
  agents (Stage 6).
- No new vector database, retrieval engine, identity system or LLM gateway.
- No cross-service context adapter yet: the first adapter is the AI knowledge
  document store. The adapter interface is ready for Helix objects, BOM,
  requirements and change records, but those adapters must forward the user's
  token and re-check Helix authorization before they are enabled.
- Conversation summaries are derived context, not authoritative records.
- With the mock provider, task outputs are clearly labelled as mock; evaluation
  asserts structure, grounding and citation validity, not human-level quality.

## 10. Implementation status

Implemented and verified against PostgreSQL + the labelled mock provider:

- Migration 0011 and both repositories (PostgreSQL and in-memory).
- Conversation rename, paged messages, generation status, prompt version,
  parent-message retry links and best-effort cancellation.
- Typed context references with server-side re-authorization for
  `knowledge_document`; unauthorized refs are dropped without an oracle.
- Bounded history plus derived summary (toggleable; failures non-blocking).
- Task endpoints (`summarize`, `explain`, `compare`, `extract`) and
  `/assistant/capabilities`.
- SSE streaming for `ask`/`explain` with `start`/`delta`/`done`/`error`
  events; citation validation and cite-or-abstain enforcement.
- Typed extraction validation (missing vs empty, evidence refs) and
  evidence-backed comparison with a two-source minimum.
- Feedback categories and the console copilot workspace (task/format selectors,
  authorized document attach, context chips, streaming stop/retry/copy,
  structured output and warnings, citation inspection).
- Tests: `test_stage5_copilot.py` (14) and `test_stage5_security.py` (7);
  full backend 218 passed / 14 skipped; web 29 passed; ruff clean.
