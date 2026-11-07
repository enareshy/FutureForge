# Testing

Test strategy and coverage. Full detail — markers, opt-in flags, what each suite
asserts — is in `PHASE13_TESTING.md`.

## Layers

| Layer | Command | Default | Requires |
| --- | --- | --- | --- |
| Unit + application + API + AI evaluation | `PYTHONPATH=src python3 -m pytest` | yes | nothing (hermetic) |
| End-to-end copilot | included above (`-m e2e`) | yes | nothing |
| Integration | `AI_TEST_POSTGRES=1 … pytest -m integration` | no | opted-in services |
| Live smoke | `AI_E2E=1 … pytest -m live` | no | a running deployment |
| Frontend | `npm run test:web` (repo root) | yes | node |

## Backend

From `ai-platform/apps/ai-api`:

```bash
# Lint.
ruff check src tests scripts

# Hermetic suite (unit + e2e + deterministic AI evaluation).
PYTHONPATH=src python3 -m pytest

# Integration, per service (each `AI_TEST_*` opts one in).
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest -m integration

# Real OpenSearch lifecycle/security integration (disposable cluster).
AI_TEST_OPENSEARCH=1 OPENSEARCH_URL=http://127.0.0.1:9201 \
  PYTHONPATH=src python3 -m pytest -m integration tests/test_opensearch_integration.py

# RLS cross-tenant/context/worker tests (real PostgreSQL; use a fixture role
# with system scope + DML, such as ai_worker after role provisioning).
AI_TEST_POSTGRES=1 PYTHONPATH=src python3 -m pytest tests/test_rls_tenant_isolation.py

# Split-role verification (after provisioning; connects as each real role).
AI_TEST_ROLE_DB=1 \
AI_ROLE_API_DSN='postgresql://ai_api:...@host/helix' \
AI_ROLE_WORKER_DSN='postgresql://ai_worker:...@host/helix' \
AI_ROLE_BACKUP_DSN='postgresql://ai_backup:...@host/helix' \
AI_ROLE_RESTORE_DSN='postgresql://ai_restore:...@host/helix' \
AI_ROLE_MIGRATE_DSN='postgresql://ai_migrate:...@host/helix' \
  bash scripts/verify-db-roles.sh
```

`test_db_roles.py` is skipped unless `AI_TEST_ROLE_DB=1` and all five role
DSNs are set; it must not be counted as passing role evidence until
`infrastructure/db/roles/provision_roles.sql` and migration 0019 have been
applied. See `infrastructure/db/roles/README.md`.

`AI_TEST_OPENSEARCH=1` fails the run if OpenSearch or `opensearch-py` is
unavailable; it never silently skips once explicitly enabled. Tests use a
unique `ai-itest-*` index prefix, verify raw index state with a synchronous
client, and remove only the indices they created. See
`docs/configuration.md` for the disposable container command.

The default suite runs against an in-memory repository and the deterministic
mock provider — no database, network or containers.

### AI evaluation

`tests/test_ai_evaluation.py` asserts held properties on the mock provider:
retrieval relevance (recall@k, MRR), citation correctness, groundedness,
insufficient-evidence handling, prompt-injection resistance, no unauthorized
data leakage, and provider-failure recovery. It does not claim real-model
quality; that requires the opt-in `AI_TEST_LIVE_LLM` path.

`tests/test_search_evaluation.py` adds a Stage 4 labeled relevance set
(nDCG@3), a filter-cannot-widen-authorization check, and a bounded search
latency regression. Stage 4 behaviour is also covered by
`test_search_stage4.py`, `test_search_duplicates.py` and
`test_assistant_search_integration.py`.

`tests/test_stage5_copilot.py` covers the copilot tasks (summarize, explain,
compare, extract), bounded history/summary handling, prompt-version persistence,
cite-or-abstain validation and streaming lifecycle. `tests/test_stage5_security.py`
covers the copilot trust boundary: context refs are re-authorized server-side,
unauthorized or cross-tenant refs are dropped, client-supplied content and
classification are ignored, injection attempts do not widen retrieval, and
comparison/extraction cannot claim evidence that was not retrieved.

### Live smoke

```bash
AI_E2E=1 AI_E2E_BASE_URL=http://127.0.0.1:8000 AI_E2E_TOKEN=<token> \
  AI_METRICS_AUTH_TOKEN=<metrics-token> \
  PYTHONPATH=src python3 -m pytest -m live
```

Checks liveness, readiness, that `/metrics` rejects anonymous requests and
accepts the bearer token, that protected endpoints require auth, and
authenticated chat/search roundtrips.

## Frontend

From the repository root (vitest + Testing Library):

```bash
npm run test:web
```

Covers the API client (request building, error mapping, SSE parsing, timeouts,
uploads/downloads), the agent platform admin page (registry, tools, execution
monitor, approval inbox), the AI chat page (citations, insufficient evidence, errors,
auth state, streaming, assistant conversations), the federated AI search page
(independent AI/Helix groups, index health), the safe Markdown renderer
(injection safety, links) and the error boundary.

## Results (current)

Revalidated 2026-10-26 (`docs/audit/evidence/STAGES_1-6_EVIDENCE_2026-10-26.md`):

- Backend (Python): **470 passed, 42 skipped** (skips are opt-in integration/live
  and per-role database tests).
- Enterprise Node suite: **1,932 passed, 0 failed, 0 skipped** across 156 files
  (five serial batches).
- Frontend: **30 passed** (6 files).
- `ruff check apps/ai-api/src apps/ai-api/tests scripts`: clean.
- Vite production build succeeds.

Stage 6 coverage (`tests/test_agent_registry.py`,
`tests/test_agent_executions.py`, `web/src/pages/AiAgentAdminPage.test.jsx`):
immutable version publication, tool risk validation, credential rejection,
optimistic locking, rollback, ownership, idempotency, lease reclaim/cancellation,
tenant isolation, exact-operation approvals (self-approval denied), rejection
cancellation, platform-owned draft artifact, Copilot-initiated execution and the
admin/monitor/approval UI.

## Live verification

The opt-in integration tests were run against real backing services to confirm
the integration paths (not just mocks). Passed:

```bash
AI_TEST_POSTGRES=1 AI_TEST_REDIS=1 AI_TEST_MLFLOW=1 AI_TEST_OBJECTSTORAGE=1 \
  pytest -m integration tests/test_integration_services.py
```

- PostgreSQL + pgvector roundtrip
- Redis reachability
- Object storage reachability
- MLflow tracking backend reachable (`available=True`)

Additionally, Prometheus was previously run against the live API and scraped
`/metrics` successfully (target `up`, 32 `ai_*` series). The endpoint now
requires `AI_METRICS_AUTH_TOKEN`; set it to reproduce the scrape. OpenSearch 2.19.6 was run as a
disposable single-node cluster for the Phase 4 lifecycle suite (8 passed).
Kafka, the OTLP collector and a real LLM provider were not enabled in this
environment.

## CI

`.github/workflows/ai-platform-ci.yml` runs the backend suite, both frontend
suites + builds, manifest validation, image builds with Trivy scanning + SBOM,
and dependency scanning.

The 156-file enterprise Node suite is enforced by two jobs: a coverage guard that
fails when the file count no longer equals 12 × 13, and a 12-shard matrix that
runs 13 sorted files per shard on `postgres:16`. Shard 0 (151 tests) passed
locally in 1,181s. Shard boundaries are contiguous sorted slices, not balanced by
test count; shard 2 declares 322 tests and projects to roughly 42 minutes against
the 75-minute per-shard timeout. That projection is an estimate, so the first run
must measure shard 2; split the range if it exceeds about 60 minutes. The gate has
not yet run in GitHub Actions. See
`docs/audit/evidence/STAGES_1-6_GATE_CLOSURE_2026-10-27.md` Section 6.
The live-cluster and alerting procedure is in `docs/kubernetes-rollout.md`.
