# Enterprise AI Platform - Stages 1-6 Independent Re-Audit

- Date: 2026-10-23
- Scope: Stages 1-6 (environment, AI foundation, knowledge assistant, search, copilot, agent platform) plus the Phase 1-6 remediation work.
- Mode: Audit first; remediation was applied in Batch A (SEC-09, SEC-11, SEC-14), Batch B (SEC-13), Batch C (worker deployment), Batch D (SEC-02), Batch E (SEC-15), Batch F (SEC-17), Batch G (SEC-18), Batch H (SEC-10), Batch I (SEC-12), Batch J (SEC-20) and Batch K (SEC-19), recorded in Sections H through R.
- Baseline: branch `postgres`, HEAD `296ea36`, uncommitted remediation work in the working tree (treated as the implementation under audit).
- Reference: `ai-platform/docs/audit/STAGES_1-6_AUDIT_2026-10-22.md` (original audit and remediation log).

## A. Executive Summary

### Verdict

The remediation work is real and largely correct at the code level. All twenty original security findings are now closed; SEC-19 (RLS defense-in-depth) is implemented and verified against PostgreSQL in Batch K. The Stage 6 execution-integrity cluster (SEC-05, SEC-06, SEC-07) is genuinely fixed with fencing, atomic single-use approvals and runtime tool governance, not just documentation.

The platform is still **not production-ready** and **not ready for Stage 7**. The reasons have narrowed after Batches A-J:

1. **The reliability workers are deployed in the repo but not verified against a live cluster.** Batch C adds four Kubernetes Deployments (event consumer, reconciler, indexer, agent), a Compose `workers` profile, health/readiness, metrics and static manifest tests. Security-update events, reconciliation and agent recovery now have a shipped runtime path; what remains is applying it to a real cluster and observing a full cycle.
2. **The RLS backstop is verified at development scale.** SEC-19 adds `FORCE ROW LEVEL SECURITY`, tenant-context policies for 43 protected tables and transaction-local context for API/workers. It is tested against real PostgreSQL. The separate non-owner roles are prepared (provisioning SQL, migration 0019, deployment wiring and a role test) but cannot be provisioned in this environment, and no production-scale plans were available. SEC-09, SEC-11 and SEC-14 are closed in Batch A (Section H); plaintext session tokens are closed in Batch B (Section I); SEC-02 document-listing authorization is closed in Batch D (Section K); SEC-15 object-key authorization is closed in Batch E (Section L); SEC-17 conversation ownership is closed in Batch F (Section M); SEC-18 public docs and metrics is closed in Batch G (Section N); SEC-10 prompt-injection enforcement is closed in Batch H (Section O); SEC-12 citation diagnostics is closed in Batch I (Section P); SEC-20 backup and restore is closed in Batch J (Section Q), with production-scale and off-site storage still outstanding.

### Maturity

- Stages 1-5: functional beta with demonstrated correctness and good test coverage.
- Stage 6: materially stronger than the original audit; execution governance is credible at code level.
- Operations/deployment: still the weakest layer - worker manifests now exist but have not been run against a real cluster, and backup automation is implemented and drill-verified only at development scale, without off-cluster replication or alert delivery.

### Revalidation summary

| Status | Count | Findings |
|---|---|---|
| Fixed | 20 | SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08, SEC-09, SEC-10, SEC-11, SEC-12, SEC-13, SEC-14, SEC-15, SEC-16, SEC-17, SEC-18, SEC-19, SEC-20 |
| Partially fixed | 0 | - |
| Not fixed | 0 | - |

### Most important verified strengths

- **Live authorization at retrieval** (`_authorize_live` / `authorized_search`) recomputes tenant, existence, status, effective classification and every ACL layer from authoritative rows; the search index is only an accelerator.
- **Fail-closed deletion**: search copy is removed before the database row; repository reindex clamps labels to live source/document values.
- **Execution fencing**: monotonic `lease_generation` predicates every execution-owned write; heartbeat plus two-worker reclaim tests.
- **Approvals**: bound to `(execution, step, tool_version, target, operation_hash)`, atomically consumed, single-use, with a partial unique index.
- **Runtime tool governance**: allowlist, enabled/published lifecycle, capability/risk mapping and input/output JSON Schema validation.
- **Backoff is durable**: `next_attempt_at` is persisted for jobs and event deliveries, so restarts keep the delay; jitter is configurable.
- **Consumer re-reads authority**: `KnowledgeSourceSecurityUpdated` handler ignores stale versions and disabled/deleted sources and never trusts payload ACLs.
- **Test evidence**: 349 passed / 35 skipped on the full AI API suite after Batch C, plus targeted safety suites and real OpenSearch integration. Batch B added a clean full enterprise Node run: 1932 passed, 0 failed across 156 files (Section I). Batch C adds 20 worker runtime/manifest tests and a clean kustomize/kubeconform render (Section J). Batch D adds 11 document-listing authorization tests; the full AI API suite after Batch D is **360 passed, 35 skipped** (Section K). Batch E adds 26 object-key authorization tests and a real S3 roundtrip; the full AI API suite after Batch E is **386 passed, 36 skipped** (Section L). Batch F adds 20 conversation-ownership tests; the full AI API suite after Batch F is **406 passed, 36 skipped** (Section M). Batch G adds metrics authentication, production docs gating and deployment wiring; the full AI API suite after Batch G is **413 passed, 35 skipped** (Section N). Batch H adds secure prompt-injection defaults, evidence abstention and detection auditing; the full AI API suite after Batch H is **419 passed, 35 skipped** (Section O). Batch I adds shared citation validation, persisted diagnostics and answer-status downgrades across RAG, assistant, Copilot (stream and non-stream), extraction and agents; the full AI API suite after Batch I is **429 passed, 37 skipped** (Section P). Batch J adds encrypted backup/restore automation, integrity checks, deployment wiring, metrics/alerts and a real isolated restore drill; the full AI API suite after Batch J is **445 passed, 38 skipped** (Section Q).

### Critical concerns

1. Worker deployment exists only as rendered/schema-validated manifests; no live-cluster rollout or end-to-end cycle was observed. Single-replica coordination limits remain.
2. Backup/restore works in a real development-scale drill, but artifacts are on a single PVC with no off-cluster replication, the K8s CronJob has not run in a live cluster, and no Alertmanager receiver exists.
3. RLS runs under the single table-owner role; split non-owner app/worker roles remain a DBA task, so context-setting privilege is not yet separated.
4. `SEARCH_PROVIDER: "postgres"` in the base configmap; OpenSearch is implemented and tested but not the deployed default.

Resolved in Batch A: SEC-09 (legacy authorization inspection), SEC-11 (mock provider / tracing-off production posture) and SEC-14 (unenforced request-body limit). Resolved in Batch B: SEC-13 (plaintext session tokens). Resolved in Batch D: SEC-02 (document-listing ACL/classification filtering). Resolved in Batch E: SEC-15 (server-controlled, tenant-scoped object keys). Resolved in Batch F: SEC-17 (fail-closed conversation ownership). Resolved in Batch G: SEC-18 (authenticated metrics and production docs gating). Resolved in Batch H: SEC-10. Resolved in Batch I: SEC-12. Resolved in Batch J: SEC-20 (development-scale drill; production storage/notification prerequisites documented). Resolved in Batch K: SEC-19 (real-PostgreSQL RLS tests; separate DB roles and production-scale plan validation documented as remaining operational work).

### Audit limitations

- No live Kubernetes cluster; manifests were validated statically.
- No external alerting destination exists, so alert delivery could not be verified.
- The enterprise Node suite runs longer than the one-hour command window; Batch B ran all 156 files to completion in serial file-range chunks (Section I).
- No destructive/unauthorized requests were executed against shared services.
- The object-storage integration test used live SeaweedFS but the in-memory repository; no CI test combines live PostgreSQL and live object storage.

## B. Security Finding Revalidation

Status definitions: **Fixed** = the original exploit path is closed and covered by a test; **Partial** = the primary path is closed but a related path or default remains; **Not fixed** = the original evidence still applies.

### SEC-01 - Cross-tenant AI event disclosure - Fixed

- `InMemoryEventStore.list_events/list_dead_letters/replay/get_event` filter on `tenant_id` (`infrastructure/events/memory_event_store.py:97`).
- `PostgresEventStore` filters `WHERE tenant_id = $1` for events, dead letters and replay (`infrastructure/events/postgres_event_store.py:143`).
- Routes pass `require_tenant(principal)` for list, dead letters, stats and replay (`api/v1/routes/events.py:34,50,66,80`).
- Residual: none observed for tenant scoping.

### SEC-02 - Document download/list bypasses ACL/classification - Fixed

- `get_document_content` rejects disabled sources, applies the effective maximum classification against the governance ceiling, and requires every ACL layer to allow (`application/services/knowledge_service.py`).
- `list_documents` now enforces tenant and source existence, rejects disabled sources, validates the tenant classification ceiling, and applies the effective maximum of document and source classification plus both ACL layers using the same `AccessControl.allows` implementation as download and retrieval.
- Repository queries narrow by tenant, source, `status <> 'disabled'` and classification ceiling before rows reach the service; ACL filtering happens before pagination and totals, so counts cannot reveal hidden rows. Postgres ordering is deterministic (`created_at DESC, id DESC`); the service strips internal fields and returns only `DocumentOut` metadata.
- `AccessControl.allows` now fails closed for non-dict ACL values (an absent `None` still means the legacy tenant-wide default), non-boolean `deny_all`, non-list grants and non-string grant entries.
- Tests: `tests/test_document_listing_security.py` (11 passed) covers permitted listings, document and source ACL denial, document and source classification ceilings, disabled/deleted sources, cross-tenant isolation, malformed ACLs and missing identity, invalid ceiling policy, authorized-only totals, pagination/order boundaries, explicit superuser access and unchanged download authorization.
- Residual: ACL predicate evaluation occurs in the service so the listing scans classification-eligible candidate pages for a source; this is bounded memory but O(candidates) database work per request, and there is no ACL index.

### SEC-03 - Caller relabels classification/ACL during ingestion - Fixed

- `_resolve_labels` clamps classification upward only, rejects values above the caller/source ceiling, rejects ACL replacement or broadening, and audits `relabeled` (`application/services/ingestion_service.py`).
- Reindex uses the same clamp against live source/document state.

### SEC-04 - Stale OpenSearch documents/ACLs - Fixed

- Retrieval revalidates candidates against authoritative rows (`get_authoritative_chunks`, tenant-scoped join of chunk/document/source).
- Deletion removes the search copy by stable `(source_id, external_id)` identity before deleting the database row; a search failure fails closed.
- Reindex replaces prior chunks by the same identity and clamps labels.
- Real OpenSearch integration suite passes (10 tests).
- Residual: physically stale index entries created before the fix remain until reindex/cleanup, but are never returned because live revalidation drops them. This is an accepted, documented residual.

### SEC-05 - Execution lease without fencing - Fixed

- `lease_generation` increments on claim; every execution-owned write predicates on `(state, lease_owner, lease_generation)`.
- Heartbeat renews the lease; `_LeaseLost` aborts a stolen worker.
- Two-worker reclaim and PostgreSQL fencing tests exist.

### SEC-06 - Approvals not revalidated/single-use - Fixed with documented residual

- Approvals bind execution, step, tool version, target and `operation_hash`.
- Decision revalidates expiry, self-approval, caller authorization snapshot, agent/tool state and target; consumption is atomic and single-use via `consume_agent_approval` plus partial unique index `agent_approvals_active_uniq`.
- Residual (documented): the engine re-checks the creation-time permission snapshot rather than re-resolving live IAM permissions, because bearer tokens are intentionally not persisted. Live revocation applies to new executions/approvals, not an already-authorized read-only step.

### SEC-07 - Tool permissions/enabled/schemas unenforced - Fixed

- `_runtime_tool` enforces allowlist membership, `enabled`, published lifecycle, capability/permission, risk mapping and input/output JSON Schema.
- Disabled-tool, schema-mismatch and risk-mismatch tests exist.

### SEC-08 - Legacy synchronous agent endpoint bypass - Fixed

- Legacy `/agents/{id}/execute` rejects client-supplied approvals with 422 (`application/services/agent_service.py:123`).
- Workflow agents return 503 pointing to `/agent-executions` (`agent_service.py:138`).
- Only read-only simple agents remain on the legacy path; the governed execution API owns approvals and multi-step workflows.

### SEC-09 - Authorization metadata enumeration - Fixed (Batch A)

- `/api/authorization/effective/:userId` now allows self-inspection, and otherwise requires `iam.users:read` plus a subject resolved through the tenant-scoped `users` repository (`server/app.js`). Cross-tenant subjects return 404, so tenant membership cannot be probed.
- `/api/authorization/check` now requires `iam.security.decisions:read` at the route level and validates that a supplied organization belongs to the caller's tenant.
- `server/tests/security-authz-legacy.test.js` covers self-access, cross-user denial/grant, tenant-header spoofing, cross-tenant 404s, malformed subjects and organization scope (9 passed).
- Residual: legacy routes remain as UI entrypoints; they now mirror the versioned route's permission checks.

### SEC-10 - Prompt-injection blocking optional - Fixed (Batch H)

- `GovernancePolicy.block_prompt_injection` and `PromptGuard.block` now default to true; `AI_PROMPT_INJECTION_BLOCKING` is an operator floor and deployed environments refuse to disable it.
- Chat/stream/summarize, Copilot, RAG and the legacy agent all use the shared screening helper. Suspicious input is rejected with `403`; suspicious retrieved evidence is filtered, and RAG/agent requests abstain if no usable evidence remains.
- Every detection is audited as `ai.security.prompt_injection` with finding counts and disposition, never prompt or document content.
- Tests: `tests/test_prompt_injection_security.py`, updated `tests/test_ai_evaluation.py`, `tests/test_governance.py`, `tests/test_production_config.py` (Section O).

### SEC-11 - Production can use mock provider - Fixed (Batch A)

- Settings now fail closed when `AI_ENV` is `production`, `prod` or `staging`: `LLM_PROVIDER` must be a real provider with `LLM_API_KEY` or `LLM_BASE_URL`, `OTEL_ENABLED` must be true, and the OTLP endpoint must be an http(s) URL (`config/settings.py`).
- The production overlay adds `LLM_PROVIDER=openai`, enables OTel and points at the collector (`infrastructure/kubernetes/overlays/production/configmap-patch.yaml`), so it no longer inherits the base mock/disabled values.
- Telemetry dependency imports now raise `ConfigurationError` in deployed environments instead of silently continuing without tracing.
- `tests/test_production_config.py` covers accepted/rejected postures (10 passed).

### SEC-12 - Citation validation advisory/invisible - Fixed (Batch I)

- Citation validation now lives in one shared module (`citation_validation.py`) and is used by RAG, assistant, Copilot stateless/conversation (stream and non-stream), extraction and the knowledge agent.
- Required citations are checked for well-formed `[n]` markers, in-range references, complete metadata, duplicates and a match to this request's evidence. Failures are reported as opaque warning codes.
- `answer_status` is downgraded to `citation_warning` when required citations are missing or invalid; insufficiency, cancellation and provider errors use their own canonical statuses. `citation_status` records `not_required`/`valid`/`missing`/`invalid`.
- Assistant messages persist `warnings`, `citations_required` and `citation_status` (migration `0016_citation_validation.sql`), so diagnostics survive page refresh. Agent execution output carries the same fields.
- Streaming `done` events and persisted messages report the same outcome, closing the previous parity gap.
- `tests/test_citation_validation.py` covers validator semantics, RAG/assistant/agent persistence, extraction and stream/non-stream parity, failure persistence and warning opacity (12 passed); the full suite is 429 passed / 37 skipped (Section P).

### SEC-13 - Plaintext session tokens - Fixed (Batch B)

- `sessions` now stores only `token_hash` (`sha256:<hex>`); the schema version is `postgres_008` (`server/schema.sql`, `server/db.js`).
- Creation, authentication, logout, revoke-all, expiry handling and tenant switching hash the presented raw token before every read/write (`services/sessions.js`, `services/tenants.js`). Public session representations strip both token fields.
- Startup backfills legacy plaintext rows, verifies every value is a canonical hash, then drops `token` and restores the primary key on `token_hash`; the migration is idempotent and runs after the schema transaction (`server/session-tokens.js`, `db.js`).
- `server/tests/session-token-hashing.test.js` covers storage, lookup, failure, revocation, expiry, tenant switching, audit/log hygiene, concurrency and the legacy migration (11 passed).
- Residual: the migration is one-way and requires restarting all application instances for the release; see the rollout note in `docs/AUTHENTICATION_DESIGN.md`.

### SEC-14 - Request body limit unenforced - Fixed (Batch A)

- `RequestBodyLimitMiddleware` is registered in `create_app` with `settings.ai_max_request_bytes`, so oversized requests are rejected with 413 before routing, parsing, authentication or ingestion (`main.py`).
- The cap is enforced for both declared `Content-Length` and streamed/chunked bodies, and the body is never read into memory before rejection.
- The default transport cap is now 32 MiB, above the 25 MiB upload limit; settings validation rejects a transport cap below the upload limit. Ingress (`proxy-body-size`), the web proxy (`client_max_body_size`) and the API are aligned at 32 MiB.
- `tests/test_request_body_limits.py` covers wiring, early rejection, at-limit and streamed requests, no-body-read rejection, and the settings invariant (8 passed).

### SEC-15 - Client object keys not tenant-constrained - Fixed

- The public `KnowledgeDocumentIn` schema no longer accepts `object_key` (`extra="forbid"`), so ingest/upload callers cannot choose a storage destination. The upload endpoint writes the original itself and queues an internal `StoredKnowledgeDocumentIn` through `enqueue_stored`.
- New keys are server-generated as `knowledge/{tenant}/{YYYY}/{MM}/{uuid}/{safe_filename}`. Key validation rejects empty/absolute/trailing keys, backslashes, duplicate or `.`/`..` segments, percent-encoded traversal, null bytes, non-ASCII characters and over-long keys.
- `validate_tenant_object_key` rechecks the exact tenant namespace for queued uploads. Reads, downloads, reindex and deletion resolve the key from the tenant-scoped document row and use `validate_document_object_key`, which rejects a key claiming another tenant's `knowledge/` prefix. The prefix is not the authorization boundary: tenant lookup, source state, classification and ACLs are still applied by `get_document_content`.
- Upload deduplication is tenant-scoped; an invalid legacy key on a same-tenant duplicate is ignored and a new canonical object is written. Cleanup of a server-written original occurs only before a durable job exists, so post-job audit/event failures cannot break a queued retry.
- Legacy compatibility: a syntactically safe non-namespaced key is accessible only through its authoritative document record (the prior behaviour); it cannot be supplied by a client. Live development data was checked before the change: 2 stored keys, both canonical, 0 legacy, and 0 queued/running index jobs containing object keys, so no data migration was required.
- Tests: `tests/test_object_key_security.py` (26 passed) and the opt-in S3 roundtrip in `tests/test_object_storage_integration.py` (1 passed).

### SEC-16 - Unknown ACL keys fail open - Fixed

- `validate_acl` rejects unknown keys; `AccessControl.allows` denies any ACL with a non-empty unknown key (superuser excepted). Retrieval applies the same check to live ACLs.

### SEC-17 - Ownership bypass when actor ID absent - Fixed

- `_owned_conversation` previously rejected only when both owner and caller IDs were non-null and different. A principal without an actor ID could read another actor's conversation; `mine=true` also became a tenant-wide list because the repository received a null actor filter.
- A shared `require_actor_id` now rejects missing, zero/negative, boolean, string or other malformed actor IDs with 403 before any conversation lookup. Creation stores the validated actor, and access requires an exact owner match plus the tenant-scoped lookup. Mismatch, a malformed stored owner, and a missing conversation all return the same 404 body.
- Conversation listing is actor-filtered by default. `mine=false` is retained only for an explicit platform administrator (`Policy.is_superuser`, including the configured admin permission); it is no longer an ordinary-user tenant-wide read.
- The checks cover read, update, delete, message list/ask, cancel, streaming prepare, both feedback routes and the legacy assistant service used for feedback. Client-supplied `actor_id`/`owner_id` is rejected by `extra="forbid"` on conversation create/update, message create and feedback schemas.
- The development identity now has an explicit `AI_DEV_ACTOR_ID` (default 1); no production system workflow uses an actorless principal. Enterprise identity continues to set `actor_id` from the verified user ID.
- Tests: `tests/test_conversation_ownership_security.py` (20 passed).

### SEC-18 - Public docs and metrics - Fixed (Batch G)

- Original evidence: `/metrics` was registered without authentication and docs
  were always enabled at `${API_PREFIX}/docs`; only topology limited exposure.
- Current control: API and worker `/metrics` require
  `Authorization: Bearer <AI_METRICS_AUTH_TOKEN>` (401 on mismatch, 503 when
  unset). Production disables Swagger and the OpenAPI schema unless
  `AI_DOCS_ENABLED=true`. The console nginx returns 404 for `/metrics`.
- Tests: `tests/test_observability.py`, `tests/test_production_config.py`,
  `tests/test_worker_runtime.py`, `tests/test_worker_deployment.py`
  (Section N).

### SEC-19 - No RLS backstop - Fixed (Batch K)

- Migration `0018_tenant_row_level_security.sql` adds transaction-local tenant
  context helpers, `FORCE ROW LEVEL SECURITY` and `tenant_isolation` policies to
  36 direct-tenant tables; seven child tables are isolated through their
  authoritative parent. `schema_migrations` and `backup_runs` are documented
  global exceptions (no customer data).
- The DB wrapper installs `ai.tenant_id`/`ai.system_access` with
  `set_config(..., true)` in every transaction; API, indexer, event consumer,
  reconciler and agent worker establish tenant or narrow system scopes
  explicitly. Backup and migration sessions receive system access only through
  `PGOPTIONS`.
- Startup/readiness fails if any protected table lacks RLS/FORCE or its policy.
- `tests/test_rls_tenant_isolation.py` seeds two tenants across all protected
  tables and proves cross-tenant reads/writes fail against real PostgreSQL;
  context leakage, transaction rollback, worker scopes and request-scope
  teardown are covered.
- Limitations: single table-owner deployment role (no superuser/CREATEROLE was
  available to split app/worker roles), development-scale plans, and
  superuser/BYPASSRLS bypass by design. See `docs/tenant-isolation.md`.

### SEC-20 - Backup/restore not automated - Fixed (Batch J)

- `scripts/backup_restore.py` now creates encrypted, checksummed, self-describing artifacts and implements verification, restore, drill, and guarded cleanup.
- The K8s base adds a daily CronJob, dedicated PVC, token-less service account, and restricted egress; Compose adds a manual profile.
- A real encrypted backup was restored into an isolated database and bucket on 2026-10-25; 21/21 checks passed in 22.446s, including API and four workers. Evidence is in Section Q and `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json`.
- Limitations: development-scale data only, same PostgreSQL server, no live-cluster Job run, no off-site replication/immutability, and no alert receiver.

## C. Phase 6 Implementation Correctness

### What is correct

- **Durable backoff**: `ai.jobs.next_attempt_at` and `ai.event_deliveries.next_attempt_at` persist delays; `EventConsumer` and `IndexingService` compute bounded exponential delay with configurable jitter (`event_service.py:257-280`, `indexing_service.py:225`).
- **Event handling**: `build_security_updated_handler` validates event version and subject, re-reads the source, ignores stale versions and disabled/missing sources, logs when the event is ahead of the store, and enqueues an idempotent `source-security-{id}-v{version}` reindex. It never writes payload ACLs (`workers/event_consumer.py:44-120`).
- **Reconciliation**: `reconcile_all_tenants` is bounded (`limit`, `max_tenants`), time-bucketed, idempotent, skips disabled sources and active index jobs, supports dry-run, and never deletes authoritative rows (`knowledge_service.py:556`, `workers/reconciler.py`).
- **Dead-letter and replay**: replay is tenant-scoped, age-bounded, audited, and reflects the store's replay result.
- **Index job retry**: terminal vs retryable classification, persisted `next_attempt_at`, jitter, and metrics.
- **Metrics**: backlog (`pending`, `delayed`, `dead`), job status counts, security-refresh overdue, reconcile outcomes.

### Gaps found

1. **Workers are now deployed, but only statically verified (addressed in Batch C).** `infrastructure/kubernetes/base/worker-deployments.yaml` defines `ai-event-consumer`, `ai-reconciler`, `ai-indexer` and `ai-agent-worker`; `compose.yaml` adds a `workers` profile; each exposes `/healthz`, `/readyz` and `/metrics` on 9100. `AI_INGEST_INLINE=false` makes the indexer own ingestion. Kustomize render and kubeconform pass, but no real cluster was available, so a rollout and end-to-end event/reconcile/agent cycle remain unverified (`docs/WORKER_DEPLOYMENT.md`).
2. **No global scheduler lease for the reconciler.** Two replicas started manually would both reconcile. The work is idempotent, but `purge_orphans=true` would race. No `pg_try_advisory_lock` or lease is used.
3. **No external alerting.** Metrics exist, but there is no Alertmanager rule or notification destination. `security_refresh_overdue` and `dead` backlog are observable but nobody is paged.
4. **No membership oracle for missing index entries.** Reconciliation can detect stale/missing rows it can enumerate, but cannot prove that a document absent from the index should be present without scanning authoritative rows; `purge_orphans` is off by default.
5. **Worker-inactivity metric added (Batch C).** `ai_worker_last_success_timestamp_seconds`, `ai_worker_consecutive_failures` and activity-based `/readyz` now expose a stopped loop directly.
6. **`AI_INGEST_INLINE` is set false in the base configmap (Batch C).** Ingestion is owned by the indexer Deployment; the code default remains true for local/test use.

## D. API and Data Model Notes

- Migration state: `ai.schema_migrations` contains 0001-0015 with recorded checksums; `scripts/migrate.sh` and `scripts/validate-k8s.py` pass.
- Migration 0013 (execution governance), 0014 (`knowledge_sources.version`) and 0015 (durable backoff) are applied.
- The base Search provider is `postgres`, not OpenSearch. OpenSearch correctness is verified in integration tests, but the default deployment does not use it.
- `AI_EVENT_CONSUMER_GROUP=ai-api-events` is set and a consumer Deployment now runs it.
- Legacy enterprise routes (`/api/authorization/*`) and the AI API's governed routes coexist; the legacy routes are the weaker surface.

## E. Test and Quality Evidence

Executed in this audit (read-only or disposable test services):

| Check | Command | Result |
|---|---|---|
| Full AI API suite (before Batch A) | `python3 -m pytest -o addopts="" -q` | 313 passed, 33 skipped |
| Full AI API suite (after Batch A) | `python3 -m pytest -o addopts="" --tb=short` | **331 passed, 33 skipped** |
| Full AI API suite (after Batch D) | `python3 -m pytest -o addopts="" -q` | **360 passed, 35 skipped** |
| Full AI API suite (after Batch E) | `python3 -m pytest -o addopts="" -q` | **386 passed, 36 skipped** |
| Full AI API suite (after Batch F) | `python3 -m pytest -o addopts="" -q` | **406 passed, 36 skipped** |
| Batch A SEC-09 | `node --test tests/security-authz-legacy.test.js` | **9 passed** |
| Batch A SEC-11 | `pytest tests/test_production_config.py` | **10 passed** |
| Batch A SEC-14 | `pytest tests/test_request_body_limits.py` | **8 passed** |
| Existing authz callers | `node --test tests/security.test.js tests/api.test.js` | **32 passed** |
| Targeted security suite | pytest on `test_security_remediation`, `test_source_security`, `test_search_lifecycle_security`, `test_agent_executions`, `test_agent_registry`, `test_security_reconciliation`, `test_events` | 102 passed |
| PostgreSQL integration | `AI_TEST_POSTGRES=1 ... test_integration_services.py` | 10 passed, 7 skipped |
| OpenSearch integration | `AI_TEST_OPENSEARCH=1 OPENSEARCH_URL=... test_opensearch_integration.py` | 10 passed |
| Lint | `python3 -m ruff check src tests scripts` | clean |
| Whitespace | `git diff --check` | clean |
| Web unit tests | `npm run test:web -- --run` | 30 passed (6 files) |
| Web build | `npx vite build` | success (161 modules) |
| Manifest validation (after Batch C) | `scripts/validate-k8s.py` | 28 documents / 18 files OK |
| Kustomize render + schema (Batch C) | `kustomize build` (base, production) + `kubeconform -strict` | 24/24 resources valid each |
| Worker runtime/manifest tests (Batch C) | `pytest tests/test_worker_runtime.py tests/test_worker_deployment.py` | 18 passed, 2 skipped (no kustomize on PATH); 20 passed with kustomize on PATH |
| Document listing authorization (Batch D) | `pytest tests/test_document_listing_security.py` | **11 passed** |
| Focused authorization suites (Batch D) | listing, access control, source security, remediation, Stage 5 security, retrieval, Stage 4 search, Stage 3 assistant, API v1, ingestion | **124 passed** |
| Object-key security (Batch E) | `pytest tests/test_object_key_security.py` | **26 passed** |
| Object storage integration (Batch E) | `AI_TEST_OBJECTSTORAGE=1 pytest -m integration tests/test_object_storage_integration.py` | **1 passed** (real S3-compatible provider) |
| Focused storage/auth suites (Batch E) | object-key, Stage 3 assistant, source security, listing security, remediation, API v1, request limits, access control, retrieval | **131 passed** |
| Enterprise backend | `npm test` | **timed out (exit 124)**, 54 passing / 0 failing captured before termination |

Notes:

- `npm run build` does not exist at the repository root; use `npx vite build`.
- A single-shot enterprise Node run exceeds the one-hour command window. Batch B instead ran all 156 files to completion in serial ranges: 1932 passed, 0 failed (Section I). Two previously flaky Helix tests were included in that run.
- OpenSearch integration requires `docker start ai-opensearch-itest`; the container is limited to 900 MiB with a 256 MiB heap because the host is RAM-constrained.

### Coverage gaps

- SEC-02 now has dedicated ACL/classification listing tests (Section K); no live PostgreSQL integration test exercises the exact SQL predicate in CI without `AI_TEST_POSTGRES`.
- SEC-11 posture and SEC-14 body limits are now covered by dedicated tests (see Section E).
- SEC-15 now rejects client-supplied object keys and covers cross-tenant, malformed, legacy and lifecycle cases (Section L).
- SEC-17 has dedicated missing/malformed actor, owner mismatch, cross-tenant, listing, message, streaming, feedback and spoofing tests (Section M).
- No test asserts the reconciler takes a scheduler lease.
- Conversation ownership is enforced in the service layer on top of tenant-scoped repository lookups; repositories do not take an actor predicate. New callers must use the ownership helper.
- Batch C adds static tests for the deployed topology (kustomization membership, commands, probes, resources, service account, network policy, Compose services, kustomize render), but no live-cluster rollout test exists.

## F. Prioritized Residual Backlog

### P0 - Blockers for production / Stage 7

1. ~~Deploy the workers as Kubernetes workloads with health checks and resource limits.~~ **Implemented in Batch C**; remaining work is live-cluster rollout plus an observed event/reconcile/agent cycle.
2. ~~SEC-20: add an encrypted backup CronJob and a documented restore drill.~~ **Fixed in Batch J** (Section Q).

Closed in Batch A: SEC-09 (legacy authorization inspection), SEC-11 (mock provider / tracing-off production posture), SEC-14 (unenforced request-body limit). Closed in Batch B: SEC-13 (plaintext session tokens). Addressed in Batch C: worker deployment (P0 item 1), with live-cluster verification outstanding. Fixed in Batch J: SEC-20, with a real encrypted backup and isolated restore drill.

### P1 - Security correctness

7. ~~SEC-02: filter `list_documents` by document ACL and classification ceiling.~~ **Fixed in Batch D** (Section K).
8. ~~SEC-15: require `knowledge/{tenant}/` on client-supplied object keys or resolve keys server-side only.~~ **Fixed in Batch E** (Section L).
9. ~~SEC-10: default `block_prompt_injection` to true for sensitive features and scan retrieved evidence; audit detections.~~ **Fixed in Batch H** (Section O).
10. ~~SEC-12: persist citation warnings on non-stream messages and downgrade `answer_status` when citations are missing.~~ **Fixed in Batch I** (Section P).
11. ~~SEC-17: require `actor_id` or a principal-identity fallback for conversation ownership.~~ **Fixed in Batch F** (Section M).
12. SEC-19: closed in Batch K with database-enforced RLS and cross-tenant regression tests. Follow-up role artifacts are implemented; the remaining operational action is to provision and verify the separate non-owner app/worker/backup roles (Section R).

### P2 - Operations and hardening

13. Add Alertmanager rules for `dead` backlog, `security_refresh_overdue`, worker inactivity/failures and oldest pending event age. Metric names and suggested expressions are in `docs/WORKER_DEPLOYMENT.md`, but no notification path exists yet. Batch J adds backup/restore rules, not a notification receiver.
14. Add a reconciler scheduler lease (advisory lock) before enabling multi-replica runs.
15. ~~Protect `/metrics` with network policy and disable docs in production.~~ **Fixed in Batch G** (Section N).
16. Decide and document the production search provider (`postgres` vs `opensearch`); the base manifest currently ships repo search.

## G. Stage 7 Readiness Decision

### Decision: Not ready

The Stage 6 execution model is now credible, and the retrieval authorization design is a genuine strength. Batch A closed the authorization oracle, the unsafe deployed LLM/telemetry posture and the unenforced body limit; Batch B removed plaintext session tokens; Batch G authenticated metrics and disabled production docs by default. The platform still cannot be called production-ready while its reliability workers have not been exercised in a real cluster, its backup storage has not been replicated off-cluster, and there is no RLS backstop. Batch J closes the backup/restore gap at development scale, but does not establish production RTO or off-site recoverability.

### Conditions to revisit

1. Worker Deployments rolled out and an event/reconcile/index/agent cycle observed in a real cluster.
2. ~~A restore drill has been executed from an automated backup.~~ **Done in Batch J** on development data; repeat on production-sized data and on a separate physical target.
3. Enterprise test suite completes green (or its documented flakes are quarantined) in CI.
4. Backup artifacts are replicated off-cluster with tested key custody and an Alertmanager delivery path.

## H. Batch A Remediation Log (2026-10-23)

Scope was limited to the three P0 security findings above; no other finding, schema, worker deployment or backup automation was changed.

### Changes

- **SEC-09** (`server/app.js`): added subject parsing and tenant-scoped subject/organization checks to the legacy authorization inspection routes. Self-inspection stays available; cross-user inspection requires `iam.users:read` and a subject visible in the caller's tenant; the decision probe requires `iam.security.decisions:read`. Cross-tenant subjects and organizations return 404. New `server/tests/security-authz-legacy.test.js`.
- **SEC-11** (`config/settings.py`, `telemetry/otel.py`, production overlay): deployed environments (`production`, `prod`, `staging`) now reject the mock provider, missing LLM credentials, disabled OTel or a non-http(s) OTLP endpoint at settings construction. The production overlay patches the base configmap with a real provider and tracing. Telemetry imports fail closed when deployed. New `tests/test_production_config.py`.
- **SEC-14** (`main.py`, settings, ingress, web nginx): registered Starlette's `RequestBodyLimitMiddleware` with `ai_max_request_bytes`; it rejects declared and streamed bodies with 413 before routing/parsing. Default transport cap raised to 32 MiB (above the 25 MiB upload limit), with a settings invariant preventing a cap below the upload limit. Ingress and the web proxy are aligned at 32m. New `tests/test_request_body_limits.py`; configuration docs updated.

### Verification

| Check | Result |
|---|---|
| SEC-09 focused | 9 passed |
| SEC-11 focused | 10 passed |
| SEC-14 focused | 8 passed |
| Existing authz callers (`security.test.js`, `api.test.js`) | 32 passed |
| `authz.test.js` / `authorization-async.test.js` (serial) | 9 / 11 passed |
| `iam.test.js` / `tenants.test.js` (serial) | 12 / 10 passed |
| Full AI API suite | 331 passed, 33 skipped |
| `ruff check src tests` | clean |
| `git diff --check` | clean |
| `scripts/validate-k8s.py` | 21 documents / 17 files OK |

### Limitations

- No live cluster: the production overlay was validated statically, not rendered with `kustomize` or applied.
- The 25 MiB upload path was not exercised with a full-size body in this batch; the transport cap, the handler limit and the settings invariant are tested, and the edge limits are aligned above both.
- Operators with an existing `AI_MAX_REQUEST_BYTES` below `AI_UPLOAD_MAX_BYTES` will now fail startup by design; raise it to at least the upload limit (32 MiB is the new default).
- Enterprise `npm test` was not re-run to completion in this batch; only the focused Node authz suites were executed.
- Node test files create PostgreSQL clones from a fixed slot pool. Running several files concurrently can collide on `pg_database_datname_index`; the suites above were re-run serially and pass. This is a harness limitation, not an application failure.

## I. Batch B Remediation Log (2026-10-23)

Scope was limited to SEC-13; no other finding, authorization rule, worker
deployment or backup automation was changed.

### Changes

- **Schema**: `sessions` stores `token_hash TEXT PRIMARY KEY` instead of the
  plaintext token; `SCHEMA_VERSION` is `postgres_008`. The upgrade pass adds
  `token_hash` before the startup backfill so a crash cannot lose the source
  column early (`server/schema.sql`, `server/db.js`).
- **Hashing**: `server/session-tokens.js` derives a canonical
  `sha256:<64 hex>` digest from the 256-bit `randomToken()` value. A single
  SHA-256 is appropriate because the credential has full-entropy input; no
  salt or slow KDF is needed. Empty/NULL inputs hash to no value and never
  authenticate.
- **Session operations**: creation, authentication, logout, expiry handling,
  administrative revoke, revoke-all and tenant switching hash before every
  read/write (`server/services/sessions.js`, `server/services/tenants.js`).
  `publicSession` and the list/me projections strip `token` and `token_hash`;
  `auth.session.create` audits only provider and MFA state. No token or hash is
  logged.
- **Migration**: `migrateLegacySessionTokens()` runs after the schema
  transaction. It deletes NULL/empty legacy tokens (they could never
  authenticate), hashes every remaining row whose hash is NULL, refuses to drop
  plaintext unless every row now has a canonical hash, then drops `token` and
  installs the primary key on `token_hash`. Re-running is a no-op and cannot
  double-hash.
- **Tests**: `server/tests/session-token-hashing.test.js` covers storage,
  positive/negative lookup, public representations, logout, admin revoke, expiry,
  revoke-all, tenant switching, audit hygiene, concurrent async lookups and the
  legacy migration (single application, no double hashing). Existing auth suites
  were updated where they asserted on the stored column.

### Rollout and rollback

The migration is one-way and removes plaintext during startup, so old
application instances that still query `token` cannot coexist with a migrated
database. This release requires restarting all application instances (the
startup advisory lock serialises concurrent bootstraps). Active sessions are
hashed in place and continue to work; users do not need to re-authenticate.
Rollback cannot recover raw tokens from hashes: it requires a pre-migration
backup and forces user re-login, which reintroduces the plaintext exposure, so a
forward fix is preferred. Backups taken after migration contain only hashes;
pre-migration backups must be purged or rotated under the retention policy.
These constraints are documented in `docs/AUTHENTICATION_DESIGN.md`.

### Verification

| Check | Result |
|---|---|
| SEC-13 focused: storage, lookup, fail-closed, revoke, expiry, tenant switch, audit, concurrency, migration | 11 passed |
| `auth.test.js` / `auth-async.test.js` / `auth-me-api.test.js` | 10 / 3 / 3 passed |
| `api.test.js` | 15 passed |
| `tenants.test.js` | 10 passed |
| Full Node suite (serial chunks, 156 files) | **1932 passed, 0 failed / 333 suites** (A1 580, A2 406, B 382, C 176, D 388) |
| `git diff --check` | clean |
| Residual raw-token SQL/audit/log search | none outside the legacy `WHERE token IS NULL` backfill and the one-time `DROP COLUMN` |

### Limitations

- No production-scale migration timing was measured. The backfill is a single
  sequential pass over live sessions and the plaintext drop happens at the same
  startup; plan a maintenance window for very large session tables.
- There is no dual-write/dual-read compatibility release, so a rolling upgrade
  with overlapping old and new instances is unsupported by design.
- The full Node suite exceeds the 1-hour command limit and had to be run as
  serial file-range chunks with `--test-concurrency=1`; per-chunk counts are in
  the verification table above. Running files concurrently collides in the PostgreSQL clone
  pool and is not a valid signal.
- The `audit-api.test.js` export test failed once inside the interrupted
  all-files run and passed when rerun alone and in a fresh chunk; it is a
  pre-existing timing-sensitive test, unrelated to session storage.

## J. Batch C Remediation Log (2026-10-23)

Scope was limited to P0 item 1, deploying the Stage 1-6 reliability workers. No
authorization rule, backup integration or Stage 7 functionality was changed.

### Changes

- **Worker runtime**: new `workers/health.py` serving `/healthz`, `/readyz` and
  `/metrics`. Readiness is fail-closed until the first successful cycle and when
  the last success exceeds a per-worker staleness window; liveness only proves
  the process is alive.
- **All four entry points wired**: `event_consumer`, `reconciler`, `indexer` and
  `agent` accept `--metrics-port` and `--health-stale-seconds`, run cycles
  through shared health accounting, and stop after the in-flight batch on
  SIGTERM/SIGINT.
- **Metrics**: `ai_worker_cycles_total`, `ai_worker_last_success_timestamp_seconds`,
  `ai_worker_consecutive_failures`, `ai_worker_shutdowns_total`,
  `ai_event_delivery_oldest_pending_seconds`, `ai_index_jobs_current`,
  `ai_security_refresh_overdue` and reconcile outcomes. Both event stores now
  compute `oldest_pending_seconds` in `delivery_backlog()`.
- **Kubernetes**: `base/worker-deployments.yaml` adds `ai-event-consumer`,
  `ai-reconciler`, `ai-indexer` and `ai-agent-worker` (one replica, `Recreate`,
  non-root, read-only root, resource requests/limits, activity-based probes on
  9100). `ai-worker` ServiceAccount has no API token automount. ConfigMap sets
  `AI_INGEST_INLINE=false`; NetworkPolicy allows worker egress to backends and
  metrics scraping from the observability namespace.
- **Compose**: `x-worker-common` plus four services behind the `workers` profile
  (healthcheck `/readyz`, 60-300s stop grace, host metrics ports 9101-9104).
- **Prometheus**: `ai-workers` scrape job for the four endpoints.
- **Tests/docs**: `tests/test_worker_runtime.py` and
  `tests/test_worker_deployment.py`; `docs/WORKER_DEPLOYMENT.md` plus updates to
  deployment, events, observability, configuration and Kubernetes README.

### Deployment model and limits

- One replica each. The event outbox has no atomic claim, the reconciler has no
  global lease and index-job selection is not `FOR UPDATE SKIP LOCKED`; running
  more than one of those workers can duplicate work. The agent worker is
  lease/generation-fenced and can be scaled after cluster validation.
- Workers share the API image and run explicit `python -m` commands; the API
  process never starts a worker. Migrations remain a separate Job and must
  complete before workers start.
- Restart safety: event deliveries are acknowledged only after handling and are
  redelivered; index jobs are reclaimed after their lease; agent executions are
  fenced. No worker deletes authoritative rows.

### Verification

| Check | Result |
|---|---|
| Worker runtime + manifest tests | **20 passed** with kustomize on PATH; 18 passed / 2 skipped without it |
| Full AI API suite after Batch C | **349 passed, 35 skipped** |
| `ruff check src tests` | clean |
| Kustomize render (`base`, `overlays/production`) | 24 resources each |
| kubeconform v0.6.7 `-strict -ignore-missing-schemas` | **48 valid, 0 invalid** |
| `scripts/validate-k8s.py` | 28 documents / 18 files OK |
| `docker compose --profile workers config` | valid |
| `git diff --check` | clean |

### Limitations

- No live Kubernetes cluster was available. The manifests were rendered and
  schema-validated, but not applied, and no event/reconcile/index/agent cycle was
  observed in-cluster. Live rollout remains a Stage 7 condition.
- No Alertmanager rule or notification destination is deployed; metric names and
  suggested expressions are documented only.
- The Compose `workers` profile is a development aid and is not part of the
  default stack; it assumes host PostgreSQL reachable at `host.docker.internal`.
- Single-replica limits above are deliberate until atomic claims/leases land.

## K. Batch D Remediation Log (2026-10-23)

Scope was limited to SEC-02 (document listing authorization). Stage 7 was not
started; no schema, migration or worker change was made.

### Changes

- `AccessControl.allows` now fails closed for non-dict ACL values (an absent
  `None` still means the legacy tenant-wide default), non-boolean
  `deny_all`, non-list grant containers and non-string or blank grant entries.
  Unknown ACL keys carrying a non-empty value fail closed; inert falsey unknown
  keys are ignored for compatibility, so an unrecognized grant cannot widen
  access.
- `AiRepository.list_documents` now takes the tenant classification
  ceiling rank. The Postgres query joins `ai.knowledge_sources`, excludes
  `disabled` sources, computes the effective rank as the greater of document and
  source classification, filters by tenant + source + ceiling, orders
  deterministically (`created_at DESC, id DESC`) and applies the identical
  predicate to the total count. The memory repository implements the same
  semantics.
- `KnowledgeService.list_documents` resolves the source and governance policy,
  returns `404` for a missing/foreign-tenant source, `403` for a disabled source
  or a ceiling that is not a known classification, and evaluates
  `AccessControl.allows` on **both** document and source ACLs against the
  effective classification. Filtering occurs before page slicing and totals;
  only public document fields are returned.
- Download and retrieval authorization were not weakened; listing reuses the
  same `AccessControl` and `within_ceiling` implementations.

### Verification

| Check | Result |
|---|---|
| `pytest tests/test_document_listing_security.py` | **11 passed** |
| Focused authorization/retrieval suites | **124 passed** |
| Full AI API suite after Batch D | **360 passed, 35 skipped** |
| `ruff check src tests` | clean |
| Read-only live PostgreSQL probe (tenant 1, source 62) | ceiling `internal` (rank 1): 2 rows; `public` (rank 0): 0; tenant 2: 0 |
| `git diff --check` | clean |

The live probe confirmed the SQL ceiling filter and tenant predicate against
existing development data. It did not create or mutate rows.

### Residual

- ACL grants are stored as JSON and evaluated in Python, so listing scans
  classification-eligible candidate pages for a source. Memory is bounded by
  `_DOCUMENT_SCAN_PAGE_SIZE`, but database work grows with candidate count and
  there is no ACL index.
- No automated CI test runs the Postgres query path without
  `AI_TEST_POSTGRES`; the memory path is covered by the 11 regression tests.
- SEC-15 (client-supplied object-key tenant prefix) is closed in Batch E
  (Section L). Stage 7 remains gated in Section G.

## L. Batch E - SEC-15 Server-Controlled Object Keys

Status: **Fixed** (2026-10-23). No Stage 7 work was performed.

### Root cause

The public ingest schema accepted a caller-provided `object_key`, and the
ingestion path fetched that key without tying it to the caller's tenant. Key
validation checked syntax only. Knowing an opaque key from another tenant was
therefore sufficient to read that object during indexing.

### Implemented boundary

1. Public ingest and upload no longer accept `object_key`. `KnowledgeDocumentIn`
   uses `extra="forbid"`, so a supplied key is rejected with 422. Only the
   upload route can queue an original, through the internal
   `StoredKnowledgeDocumentIn` and `enqueue_stored`.
2. Destinations are server-generated by `build_object_key`:
   `knowledge/{tenant}/{YYYY}/{MM}/{uuid}/{safe_filename}`. Filenames are
   sanitized; keys are validated before every storage operation.
3. `validate_object_key` rejects rather than normalizes: empty or absolute
   keys, trailing `/`, `//`, `.`/`..` segments, backslashes, percent-encoded
   traversal, null bytes, non-ASCII characters and keys over 1024 characters.
4. `validate_tenant_object_key` enforces the exact `knowledge/{tenant}/`
   namespace when an upload is queued. Reads, downloads, reindex and deletion
   resolve the key from the tenant-scoped document record and call
   `validate_document_object_key`, which rejects keys claiming a different
   tenant's namespace. The document row remains the authorization anchor;
   tenant, source state, classification and ACL checks are unchanged.
5. Deduplication is tenant-scoped. A malformed or foreign existing key is logged
   and ignored rather than reused. Pre-job cleanup removes only server-written
   originals and only before a durable job exists; once a job exists, failures
   must not delete the original needed by retry.
6. Responses, events and error messages do not echo stored object keys.

Legacy compatibility is deliberately narrow: a syntactically safe
non-namespaced key remains reachable only through its owning tenant's document
record. It cannot be supplied by a client and cannot claim another tenant's
`knowledge/` prefix, so this is not a permanent bypass.

### Verification

| Check | Result |
|---|---|
| `pytest tests/test_object_key_security.py` | **26 passed** |
| `AI_TEST_OBJECTSTORAGE=1 pytest -m integration tests/test_object_storage_integration.py` | **1 passed** against live SeaweedFS (`ai-knowledge`) |
| Focused storage/auth suites | **131 passed** |
| Full AI API suite | **386 passed, 36 skipped** |
| `ruff check src tests` | clean |
| `git diff --check` | clean |
| Read-only live PostgreSQL probe | 2 documents, 2 canonical keys, 0 legacy; 0 in-flight jobs containing keys |

The 26 regression tests cover syntax rejection, public-ingest rejection,
cross-tenant read/overwrite/delete attempts, foreign and malformed stored keys,
tenant-scoped deduplication, retry/reindex reuse, pre-job cleanup, legacy keys
via their document row, disabled/deleted sources and key non-disclosure.

### Residual and limitations

- Environments that already hold legacy non-namespaced keys keep read access
  through their document rows. No migration was required here because the live
  data set had none; operators with legacy data should re-ingest or migrate
  before removing the compatibility path.
- Source deletion and document replacement can leave orphaned objects behind.
  They are no longer reachable without a document row and are not a
  cross-tenant path, but lifecycle cleanup is still an operational gap.
- The S3 integration test uses the in-memory repository. There is no CI test
  combining real PostgreSQL and real object storage end to end.
- No real Kubernetes cluster was available; manifests were validated and
  rendered only.

Stage 7 remains gated (Section G). The next recommended tasks are SEC-12
(partial) and SEC-19/SEC-20 (open).

## M. Batch F - SEC-17 Fail-Closed Conversation Ownership

Status: **Fixed** (2026-10-23). No Stage 7 work was performed.

### Root cause

Both conversation services compared owner and caller only when both values
were non-null. Development identities had no actor ID, and `mine=true` passed
a null actor filter to the repository, which then listed every conversation in
the tenant. A caller with no actor ID could therefore read, ask in, update or
delete another actor's conversation.

### Implemented boundary

1. `require_actor_id` accepts only a positive integer that is not a boolean.
   Missing, empty, zero/negative, string and other malformed values raise 403
   before any conversation is fetched, so the error does not reveal existence.
2. Creation requires the validated actor and stores it. Read, update, delete,
   message listing/ask, cancel, streaming preparation, feedback and the legacy
   assistant path all call `_owned_conversation`, which requires an exact
   positive integer owner equal to the caller's actor within the tenant.
3. Owner mismatch, malformed stored owner and a missing conversation return the
   same 404 error body. Listings are actor-filtered; cross-actor tenant listing
   (`mine=false`) requires `Policy.is_superuser` and is unavailable to ordinary
   users.
4. Conversation create/update, message create and feedback request models use
   `extra="forbid"`, so caller-supplied `actor_id` or `owner_id` is rejected
   instead of being silently ignored.
5. The development identity now assigns explicit `AI_DEV_ACTOR_ID` (default 1).
   Enterprise identities already set `actor_id` from the verified user. No
   actorless service or background workflow was found using conversation
   ownership.

### Verification

| Check | Result |
|---|---|
| `pytest tests/test_conversation_ownership_security.py` | **20 passed** |
| Focused conversation/auth suites | **81 passed** (Stage 3 assistant, Stage 5 copilot/security, assistant search, API v1, e2e copilot, ownership) |
| Full AI API suite | **406 passed, 36 skipped** |
| `ruff check src tests scripts` | clean |
| `git diff --check` | clean |
| Read-only live PostgreSQL probe | 11 conversations: 11 actorless, 0 malformed |

Tests cover missing and malformed actor IDs, owner mismatch, cross-tenant
access, authorized owner read/update/delete, administrator-only cross-actor
listing, message read/write, streaming, cancel, both feedback routes, spoofed
actor/owner fields, identical error bodies for unauthorized existing and absent
conversations, and the development identity's explicit actor.

### Residual and limitations

- Ownership is enforced in the service layer after a tenant-scoped repository
  lookup; the repository ports still accept only `(tenant_id, conversation_id)`.
  A future caller that bypasses the services could omit the owner check.
- Platform administrators can list all conversations in their tenant by design.
  This is an explicit `Policy.is_superuser` path, not an actorless bypass.
- No live PostgreSQL-specific conversation ownership test exists; the behavior
  is exercised through the in-memory repository HTTP path.
- Existing actorless conversations are now inaccessible by design. The live
  development database contains 11 conversations, all with a NULL `actor_id`;
  there is no safe way to infer their owner, so no automatic reassignment was
  performed. Operators must explicitly re-home or delete such legacy rows.

## N. Batch G - SEC-18 Authenticated Metrics and Production Docs Gating

Status: **Fixed** (2026-10-23). No Stage 7 work was performed.

### Root cause

`/metrics` rendered the Prometheus registry without authentication, and the
FastAPI app always registered Swagger under `/api/v1/ai/docs` plus the OpenAPI
schema under `/api/v1/ai/openapi.json`. The only mitigation was topology: the
ingress exposed the web console and a NetworkPolicy limited AI API ingress to
the web pod. The docs routes still sat under the proxied `/api/` prefix, and
metrics protection was not enforced by the application.

### Implemented boundary

1. **API metrics auth**: a shared helper compares the presented bearer token
   with `AI_METRICS_AUTH_TOKEN` using `secrets.compare_digest`. `/metrics`
   returns 401 (with `WWW-Authenticate: Bearer`) for a missing/wrong token and
   503 when no token is configured, before any registry data is rendered.
2. **Worker metrics auth**: the worker health server applies the same check on
   port 9100. `/healthz` and `/readyz` remain anonymous so Kubernetes probes
   keep working; an unconfigured token makes worker `/metrics` return 503.
3. **Deployment provisioning**: the token is a `SecretStr`, is passed to the
   API and every worker, is listed in the secret example, and is used by the
   Compose Prometheus jobs through a mounted credentials file. Production and
   staging refuse to start unless the token is at least 32 characters.
4. **Docs gating**: `AI_DOCS_ENABLED` defaults to false and production disables
   both the Swagger UI and the OpenAPI schema. Development keeps both. API
   routes, `/healthz` and `/readyz` are unaffected. An explicit
   `AI_DOCS_ENABLED=true` is the documented override for a temporary need.
5. **Proxy edge**: the console nginx template now returns 404 for `/metrics`
   instead of the SPA fallback, and docs requests proxied under `/api/` reach an
   app that returns 404 in production.

### Verification

| Check | Result |
|---|---|
| Focused observability/production/worker suites | **41 passed, 2 skipped** |
| Full AI API suite | **413 passed, 35 skipped** |
| `ruff check src tests` | clean |
| `git diff --check` | clean |
| `docker compose config -q` | clean |
| Production app probe (TestClient) | docs 404, schema 404, `/healthz` 200, `/api/v1/ai/health` 200 |
| Metrics probes | API/worker: missing/wrong token 401, valid token 200, no token 503 |
| Deployment artifacts | nginx `/metrics` 404; Prometheus credential file wiring covered by a manifest test |

Tests cover the unauthorized and malformed-token paths, the valid scrape, worker
token enforcement, production rejection of missing/short tokens, production
docs/schema 404s with API routes intact, the explicit docs override, and the
Compose/Kubernetes/Prometheus/nginx wiring. `promtool` was not installed in this
environment, so the Prometheus file was validated structurally and by
`docker compose config`, not with `promtool check config`.

### Residual and limitations

- `AI_DOCS_ENABLED=true` deliberately re-exposes Swagger/OpenAPI in production;
  it is an audited operational override, not the default.
- The metrics token is a shared static bearer credential. Rotation requires
  updating the secret and the scrape configuration, then restarting the API,
  workers and Prometheus; there is no per-scraper identity or short-lived token.
- The repository has no Prometheus Operator `ServiceMonitor`; an operator must
  attach the token to the cluster scrape configuration. The NetworkPolicy and
  token are layered, but no live scrape was performed against a cluster.
- Proxy verification is configuration-level plus application-level (the real
  nginx image was not started in this environment).

Stage 7 remains gated (Section G). The next recommended tasks are SEC-12
(partial) and SEC-19/SEC-20 (open).

## O. Batch H - SEC-10 Fail-Closed Prompt-Injection Enforcement

Status: **Fixed** (2026-10-24). No Stage 7 work was performed.

### Root cause

`GovernancePolicy.block_prompt_injection` defaulted to false, `PromptGuard`
defaulted to detection-only, and the RAG path built a guard without blocking or
auditing. Retrieved evidence was never screened, so a poisoned document could
reach the model even when the tenant had enabled blocking. The legacy agent
screened only the query, not the evidence it retrieved.

### Implemented boundary

1. **Secure defaults**: `GovernancePolicy.block_prompt_injection` and
   `PromptGuard.block` now default to true. Missing policy rows and missing
   `block_prompt_injection` keys are therefore blocking, not audit-only.
2. **Operator floor**: `AI_PROMPT_INJECTION_BLOCKING` defaults to true and
   deployed environments refuse to start when it is false. Detection-only mode
   remains available for local development and testing.
3. **Consistent disposition**: suspicious user input is rejected with `403` on
   chat, streaming, summarize, Copilot, RAG and the legacy agent. Suspicious
   retrieved chunks are dropped before prompting; if nothing usable remains,
   RAG and the knowledge assistant return `INSUFFICIENT_EVIDENCE_TEXT` with no
   citations (`safe abstention`).
4. **Coverage**: the shared helper is wired into chat/stream/summarize, Copilot
   instruction and evidence handling, RAG query and evidence, and the knowledge
   assistant's synthesis node. The governed workflow execution path performs
   authorized tool calls only and does not construct a model prompt; tool
   authorization remains independent of injection detection.
5. **Audit**: every detection records `ai.security.prompt_injection` with the
   feature, model, finding count, disposition and filtered-chunk count. Prompt
   and document content are never persisted or logged.

### Verification

| Check | Result |
|---|---|
| Focused prompt/governance/production/chat/agents/evaluation suites | **67 passed** |
| Full AI API suite | **419 passed, 35 skipped** |
| `ruff check src tests` | clean |
| `git diff --check` | clean |
| `docker compose config -q` | clean |

New tests cover default-policy blocking, development detection-only auditing,
RAG query blocking, poisoned-evidence abstention with audit, agent evidence
abstention, and production rejection of disabled blocking. The existing
"documents are data" evaluation now explicitly opts into detection-only mode so
it still verifies prompt hardening separately from blocking.

### Residual and limitations

- Detection remains a conservative regex heuristic. Paraphrased, encoded or
  multilingual injection attempts may not match; prompt hardening and server-side
  authorization remain the primary controls.
- Abstention can be induced by deliberately poisoning a document, which is an
  availability tradeoff chosen to prevent poisoned context from reaching the
  model. Operators should monitor `ai.security.prompt_injection` events.
- A tenant can explicitly set `block_prompt_injection=false` in
  `ai.governance_policies`. That is a deliberate, auditable database change, not
  a silent default; the operator floor still requires `AI_PROMPT_INJECTION_BLOCKING=true`
  in deployed environments.
- The governed agent execution engine has no model synthesis step, so evidence
  screening there is limited to tool-level authorization; any future model step
  must reuse the shared screening helper.

Stage 7 remains gated (Section G). The next recommended tasks are SEC-19/SEC-20
(open).

## P. Batch I - SEC-12 Citation Diagnostics and Answer-Status Enforcement

Status: **Fixed** (2026-10-25). No Stage 7 work was performed.

### Root cause

Citation warnings were computed only in parts of the Copilot path and were
visible only in streaming `done` events. Non-stream Copilot and assistant paths
dropped them, nothing stored citation diagnostics, and `answer_status` stayed
`answered` even when required citations were absent or invalid. Assistant, RAG
and agent paths had no citation validation at all.

### Implemented boundary

1. **One validator**: `application/services/citation_validation.py` owns
   answer-status and citation-status semantics. It checks well-formed markers,
   in-range references, citation metadata, duplicates and evidence membership,
   and returns opaque warning codes only.
2. **Canonical statuses**: persisted `answer_status` values are `answered`,
   `insufficient_evidence`, `citation_warning`, `error` and `cancelled`;
   `citation_status` is `not_required`, `valid`, `missing` or `invalid`.
3. **Persisted diagnostics**: migration `0016_citation_validation.sql` adds
   `warnings`, `citations_required` and `citation_status` to
   `ai.assistant_messages`. Memory and PostgreSQL repositories read and write
   them, so diagnostics survive refresh and listing.
4. **Every grounded path**: RAG, assistant, Copilot stateless/conversation,
   extraction and the knowledge agent validate before reporting an answer.
   Insufficiency, cancellation and provider failure keep their own statuses
   rather than being mislabelled as citation warnings.
5. **Streaming parity**: SSE `done` events and the persisted message carry the
   same `answer_status`, `citation_status` and `warnings`.
6. **Agent persistence**: execution output now includes `answer_status`,
   `citations_required`, `citation_status` and `warnings`, and the agent audit
   entry records counts only.

### Verification

| Command | Result |
|---|---|
| `tests/test_citation_validation.py` | 12 passed |
| affected suites (copilot, assistant, agents, evaluation, retrieval, e2e, security) | 77 passed |
| full AI API suite | 429 passed, 37 skipped |
| `ruff check` on changed modules | clean |
| `git diff --check` | clean |

### Residual and limitations

- Validation is structural. It proves references are well-formed, in range and
  map to this request's evidence; it does not prove sentence-level entailment or
  answer correctness.
- Warning codes are intentionally opaque; operators see counts and statuses, not
  source text.
- `warnings` is a JSONB array with an empty-array default. Existing rows are
  preserved and are not backfilled because historical citation checks did not
  run.
- Generic chat/summarize endpoints remain `not_required` because their contract
  does not supply retrieved evidence.

Stage 7 remains gated (Section G). The next recommended tasks are SEC-19/SEC-20
(open).

## Q. Batch J - SEC-20 Encrypted Backup and Verified Restore Drill

Status: **Fixed** (2026-10-25), with the operational limitations below. No
Stage 7 work and no SEC-19 work were performed.

### Root cause

The repository documented backup intent but shipped no backup tool, no
schedule, no artifact integrity model, no restore verification, and no evidence
that a restore worked. A deployment could therefore lose authoritative
PostgreSQL metadata and object bytes with no tested recovery path.

### Implemented boundary

1. **Store inventory and strategy**: PostgreSQL `ai` schema and object bytes
   are authoritative and are backed up. Enterprise `public` schema is excluded
   by default. OpenSearch is reconstructed from authoritative rows, Kafka is a
   mirror of the database outbox, Redis is cache-only, and MLflow/Langfuse are
   optional and outside this recovery boundary.
2. **Standalone tool**: `scripts/backup_restore.py` implements `backup`,
   `verify`, `restore`, `drill`, and `cleanup`. It uses PostgreSQL client
   binaries plus the standard library (and `boto3` only for object storage), so
   it does not import the API or its dependencies.
3. **Artifacts and integrity**: each artifact is a self-describing directory
   with a manifest, custom-format dump, and object tar. SHA-256 covers every
   payload; verification checks the manifest, checksums, `pg_restore --list`,
   and safe object-tar extraction. GPG AES-256 encryption is mandatory in the
   deployed configuration.
4. **Safety**: advisory locking prevents overlap; artifacts are staged and
   atomically renamed only after verification; retention preserves the newest
   and a minimum count; restore refuses the source/system databases and
   requires an explicit target confirmation; object keys and document content
   never enter manifests or reports.
5. **Restore validation**: the drill checks schema and migration history,
   critical row and tenant counts, document-object-key count and hash, four
   cross-tenant boundary queries, event-delivery uniqueness, vector search,
   and document-to-object links, then starts the API and one cycle of each
   worker against the target.
6. **Schedule and deployment**: Compose adds a manual `backup` profile. The K8s
   base adds the daily `ai-backup` CronJob, a 20 GiB backup PVC, a token-less
   backup service account, `concurrencyPolicy: Forbid`, non-root/read-only
   hardening, and NetworkPolicy egress limited to PostgreSQL and S3. The
   dedicated backup image is `infrastructure/backup/Dockerfile`.
7. **Operations telemetry**: migration `0017_backup_runs.sql` stores metadata
   only. `/metrics` exposes `ai_backup_*` gauges refreshed from the table, and
   Prometheus loads backup alerts for failure, staleness, integrity failure,
   missing encryption, and stale drills.
8. **Runbook**: `docs/backup-recovery.md` now documents RPO/RTO targets,
   per-store strategy, encryption/key custody, restore order, migration policy,
   event/search recovery, validation checklist, report format, troubleshooting,
   and the limitations below.

### Verification

| Command / evidence | Result |
|---|---|
| `pytest tests/test_backup_restore.py` (offline) | 16 passed, 1 skipped |
| `AI_TEST_BACKUP=1 pytest tests/test_backup_restore.py -m integration` | 1 passed (real PostgreSQL and S3) |
| `python scripts/backup_restore.py backup` | artifact `20261025T080235Z-b5abbe`, 64,132 bytes, 8 objects, encrypted, recorded; dump and manifest shared an exported snapshot |
| `python scripts/backup_restore.py verify --artifact 20261025T080235Z-b5abbe` | manifest, checksums, dump list, object archive passed |
| `python scripts/backup_restore.py drill --artifact ... --start-app --run-workers` | **success, 22.446s**; 21/21 checks passed; restore 4.758s |
| Drill target | `ai_restore_drill_20261025_080325`; bucket `ai-knowledge-restore-drill-20261025080325`; isolated from source |
| Live backup gauges | backup and restore_drill status 1, integrity 1, encrypted 1; drill duration 22.447s |
| Full AI API suite | **445 passed, 38 skipped** |
| `ruff check` on changed Python files | clean |
| `git diff --check` | clean |
| `docker compose config -q` | clean |
| `python3 scripts/validate-k8s.py` | 32 documents in 20 files |
| Drill report | `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json` |

The drill restored the development dataset (86 MB database, 2 documents, 2
embeddings, 8 objects) into a separate database on the same PostgreSQL server.
The 21 checks included API readiness/liveness and the event consumer, indexer,
reconciler, and agent workers. No data beyond the backup point was observed in
the restored target. This is evidence that the procedure works, not a
production RTO measurement.

### Deviations and limitations

- The drill target was a separate database on the same PostgreSQL server, not
  a separate physical cluster.
- No live Kubernetes cluster was available; CronJob/PVC/NetworkPolicy and
  kustomize output were statically validated only. The backup image was not
  built or published in this environment.
- The backup PVC is not off-site, immutable, or proven to survive loss of the
  cluster. Off-cluster replication and snapshot policy remain operational work.
- Enterprise IAM is external and was not exercised; tenant checks ran directly
  against restored rows.
- OpenSearch, Kafka, Redis, MLflow, and Langfuse are not restored; their
  reconstruction strategy is documented and depends on their own deployments.
- Prometheus evaluates the new alerts, but no Alertmanager receiver exists, so
  delivery is unverified.
- The drill scratch database and bucket were intentionally left in place.
  Destructive cleanup requires an authorised operator and the explicit
  `cleanup` confirmation flags; non-drill names are refused.

### Residual actions

1. Run the drill against production-sized data and, ideally, a separate
   physical cluster; record RTO/RPO and update section 2 of the runbook.
2. Bind the backup PVC to a replicated/snapshot-capable StorageClass and copy
   encrypted artifacts off-cluster; test key recovery from escrow.
3. Build, scan, sign, and publish the pinned backup image; apply the K8s
   manifests to a live cluster and observe a scheduled Job.
4. Configure Alertmanager/receiver routing and fire a test notification.
5. Perform the deferred scratch cleanup under operator approval.

Stage 7 remains gated (Section G). SEC-19 is fixed at code and
development-database scale; the split-role and production-plan prerequisites
remain.

## R. Batch K - SEC-19 PostgreSQL Row-Level Security

### Implementation

- `migrations/0018_tenant_row_level_security.sql` defines
  `ai.current_tenant_id()`, `ai.system_access()` and
  `ai.tenant_isolation_allows(bigint)`; enables and forces RLS and creates a
  `FOR ALL` `tenant_isolation` policy on 36 direct-tenant tables; adds
  parent-derived policies for seven indirect child tables. The migration fails
  if existing relationships cross tenants.
- `infrastructure/db/tenant_context.py` provides `tenant_scope`,
  `system_scope` and context accessors; `database.py` installs the context at
  transaction start, validates coverage at startup, and emits bounded
  context-missing/denied metrics through `telemetry/rls_metrics.py`.
- API requests scope from the verified `Principal.tenant_id`; workers use
  system scope only for discovery/claim/backlog and per-tenant scope for work.
  Backup/migration paths set system access through `PGOPTIONS`.
- `docs/tenant-isolation.md` documents policy design, context, roles,
  deployment order, rollback, performance, monitoring, troubleshooting and
  residual risks.

### Verification

- `bash scripts/migrate.sh`: applied 0018 successfully; 43 policies, all
  protected tables RLS+FORCE enabled, two global tables excluded.
- Manual SQL: absent context returns zero rows; tenant 1 sees tenant 1; system
  scope sees all; cross-tenant insert/update raises SQLSTATE 42501.
- Focused tests: `tests/test_rls_tenant_isolation.py` 9 passed;
  `tests/test_backup_restore.py` 17 passed / 1 skipped;
  `AI_TEST_POSTGRES=1 tests/test_integration_services.py` 10 passed / 7
  skipped.
- Full suite with the live PostgreSQL integration flag: **465 passed, 28
  skipped**. Relevant enterprise server suites (`tenants`, `auth-me-api`,
  `session-token-hashing`, `security-authz-legacy`): **33 passed**. Ruff,
  `git diff --check`, `docker compose config -q` and `validate-k8s.py`
  (32 documents/20 files) all pass.
- A real backup (`20261026T043506Z-b17e1e`) required the new
  `pg_dump --enable-row-security` plus system context; the isolated restore
  drill `20261026T043531Z-53495d` passed 21/21 checks in 25.19s, including
  tenant counts, cross-tenant references, API readiness and all four workers.
- `EXPLAIN` on representative tenant queries shows the policy predicate inlined
  into the existing filter path; no indexes were added. Small development
  tables correctly use sequential scans.

### Limitations

- No superuser/CREATEROLE access: the deployment still uses the table-owner
  role. FORCE RLS applies to it, but app/worker/backup privilege separation is
  not yet provisioned.
- Plans are development-scale; production datasets must be measured before any
  index decision.
- Superuser and `BYPASSRLS` roles bypass RLS by design; they must remain
  DBA-only.

### Follow-up - least-privilege role separation (prepared, not provisioned)

Batch K reduced but did not close the role-split residual risk. The follow-up
artifacts are now implemented:

- `infrastructure/db/roles/provision_roles.sql` creates `ai_owner` (NOLOGIN),
  the `ai_system_access` marker, and the `ai_api`, `ai_worker`, `ai_backup`,
  `ai_restore`, and `ai_migrate` logins; transfers `ai` object ownership and
  grants only the paths each role uses.
- `migrations/0019_system_access_role_gate.sql` requires both the
  transaction-local system flag and `ai_system_access` membership, so the API
  role cannot enable system scope. It fails closed if provisioning is missing.
- `database.py` verifies the connected role at startup (`AI_DB_ROLE_PROFILE`,
  `AI_DB_EXPECTED_ROLE`) and rejects owner/superuser/`BYPASSRLS`/mismatched
  roles; staging/production validation requires the profile for PostgreSQL.
- Kubernetes and Compose workload manifests use distinct role credentials;
  migrations use `ai_migrate` + `ai_owner`, backup uses `ai_backup`, restore
  uses `ai_restore`. The backup tool verifies source and target roles.
- `apps/ai-api/tests/test_db_roles.py` and `scripts/verify-db-roles.sh` cover
  the role boundary without connecting as the owner.

Status: **OPEN operationally**. The development environment has no superuser or
`CREATEROLE` (the `helix` login has `CREATEDB` only), so the roles have not been
provisioned and the role suite is skipped. Close this residual item only after
an authorized operator runs the provisioning script, sets the secrets, applies
0019, and records a passing `scripts/verify-db-roles.sh` result. Do not claim
role separation from static manifests alone.

## Appendix - Evidence Index

- SEC-01: `infrastructure/events/memory_event_store.py:97`, `postgres_event_store.py:143`, `api/v1/routes/events.py:34`
- SEC-02: `application/services/knowledge_service.py` (`list_documents`, `_document_classification`, `get_document_content`); `infrastructure/repositories/{memory,postgres}_ai_repository.py` (`list_documents`); `security/access_control.py` (`allows`); `tests/test_document_listing_security.py`
- SEC-03: `ingestion_service.py` `_resolve_labels`
- SEC-04: `postgres_ai_repository.py:1034` `get_authoritative_chunks`; `knowledge_service.py:758` delete ordering
- SEC-05: `agent_execution_service.py` lease/fence/heartbeat; `workers/agent.py`
- SEC-06: `agent_approval_service.py`; migration `0013_stage6_execution_governance.sql`
- SEC-07: `agent_execution_service.py` `_runtime_tool`; `agent_tool_service.py`
- SEC-08: `agent_service.py:123,138`
- SEC-09: `server/app.js:4535` (`parseAuthorizationSubjectId`), `:4542` (`assertAuthorizationSubjectInScope`), `:4557` (`scopeAuthorizationContext`); routes at `:4575,4605`; `server/tests/security-authz-legacy.test.js`
- SEC-10: `domain/models/governance.py` (secure default); `security/prompt_safety.py`; `application/services/prompt_security.py`; `chat_service.py`; `copilot_service.py`; `retrieval_service.py`; `agent_service.py`; `agents/knowledge_assistant.py`; `config/settings.py`; `tests/test_prompt_injection_security.py`; `tests/test_production_config.py`
- SEC-11: `config/settings.py` `_validate_deployed_posture`; `telemetry/otel.py`; `infrastructure/kubernetes/overlays/production/configmap-patch.yaml`; `tests/test_production_config.py`
- SEC-12: `application/services/citation_validation.py`; `retrieval_service.py`; `assistant_service.py`; `copilot_service.py`; `agents/knowledge_assistant.py`; `agents/runtime.py`; `agent_service.py`; `infrastructure/repositories/{memory,postgres}_ai_repository.py`; `migrations/0016_citation_validation.sql`; `tests/test_citation_validation.py`
- SEC-13: `server/schema.sql` (`sessions.token_hash`); `server/session-tokens.js`; `server/services/sessions.js`; `server/services/tenants.js`; `server/db.js`; `server/tests/session-token-hashing.test.js`
- SEC-14: `config/settings.py:224,257`; `main.py:55-58`; `infrastructure/kubernetes/base/ingress.yaml:18-20`; `apps/web-ai/deploy/nginx.conf.template`; `tests/test_request_body_limits.py`
- SEC-15: `infrastructure/storage/__init__.py` (`validate_object_key`, `validate_tenant_object_key`, `validate_document_object_key`, `build_object_key`); `schemas/knowledge.py` (`KnowledgeDocumentIn`, `StoredKnowledgeDocumentIn`, `KnowledgeIngestExecution`); `ingestion_service.py` (`enqueue_stored`, `_extract_segments`); `knowledge_service.py` (`store_upload`, `_stored_object_key`, `get_document_content`, `delete_document`); `indexing_service.py`; `api/v1/routes/knowledge.py`; `tests/test_object_key_security.py`; `tests/test_object_storage_integration.py`
- SEC-16: `security/access_control.py` `validate_acl`/`allows`
- SEC-17: `application/services/context.py` (`require_actor_id`); `copilot_service.py` and `assistant_service.py` (`_owned_conversation`, create/list); `schemas/assistant.py`; `security/identity.py`; `tests/test_conversation_ownership_security.py`
- SEC-18: `main.py` (`/metrics`, docs/schema URLs); `telemetry/metrics_auth.py`; `config/settings.py` (`ai_metrics_auth_token`, `ai_docs_enabled`, deployed validation); `workers/health.py` and worker entrypoints; `secret.example.yaml`; `compose.yaml`; `prometheus/prometheus.yml`; `apps/web-ai/deploy/nginx.conf.template`; `tests/test_observability.py`; `tests/test_production_config.py`; `tests/test_worker_runtime.py`; `tests/test_worker_deployment.py`
- SEC-19 role separation follow-up: `infrastructure/db/roles/provision_roles.sql`; `infrastructure/db/roles/README.md`; `migrations/0019_system_access_role_gate.sql`; `tests/test_db_roles.py`; `scripts/verify-db-roles.sh`; `docs/tenant-isolation.md`
- SEC-19: `migrations/0018_tenant_row_level_security.sql`; `infrastructure/db/tenant_context.py`; `infrastructure/db/database.py`; `telemetry/rls_metrics.py`; `api/deps.py`; `application/services/{context,indexing_service,event_service,knowledge_service}.py`; `workers/{event_consumer,reconciler,agent}.py`; `scripts/{backup_restore.py,migrate.sh}`; `tests/test_rls_tenant_isolation.py`; `docs/tenant-isolation.md`; `docs/database.md`; `docs/security.md`; `docs/observability.md`
- SEC-20: `scripts/backup_restore.py`; `migrations/0017_backup_runs.sql`; `telemetry/backup_metrics.py`; `main.py` (`/metrics`); `infrastructure/backup/Dockerfile`; `infrastructure/kubernetes/base/{backup-cronjob,backup-pvc,serviceaccount,configmap,secret.example,kustomization,networkpolicy}.yaml`; `infrastructure/monitoring/prometheus/{backup-alerts,prometheus}.yml`; `compose.yaml`; `scripts/validate-k8s.py`; `tests/test_backup_restore.py`; `docs/backup-recovery.md`; `docs/observability.md`; `docs/database.md`; `docs/audit/evidence/SEC-20_restore_drill_2026-10-25.json`
- Worker deployment (Batch C): `infrastructure/kubernetes/base/worker-deployments.yaml`; `infrastructure/kubernetes/base/{serviceaccount,configmap,networkpolicy,kustomization}.yaml`; `compose.yaml`; `workers/health.py`; `workers/{event_consumer,reconciler,indexer,agent}.py`; `telemetry/metrics.py`; `tests/test_worker_runtime.py`; `tests/test_worker_deployment.py`; `docs/WORKER_DEPLOYMENT.md`
- Phase 6: `workers/event_consumer.py`, `workers/reconciler.py`, `application/services/event_service.py:257`, `application/services/indexing_service.py:148`
