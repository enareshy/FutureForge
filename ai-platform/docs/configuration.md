# Configuration

All configuration is supplied through environment variables. Copy
`.env.example` to `.env` (`make env`) and adjust. `.env` is git-ignored;
never commit real secrets. Deployed environments use a secret manager and
store only references in source control.

## Variables

### Deployment
| Variable | Default | Description |
|---|---|---|
| `AI_ENV` | `development` | `development` / `testing` / `staging` / `production` |
| `AI_PROMPT_INJECTION_BLOCKING` | `true` | Block suspicious input and filter poisoned evidence. Staging/production refuse to start when false; detection-only is for local work |

### Prompt safety policy
`AI_PROMPT_INJECTION_BLOCKING` is an operator floor. A tenant policy can opt out
explicitly with `block_prompt_injection=false`, but the platform still audits
every detection. With the default policy and floor, suspicious user input is
rejected with `403`, and suspicious retrieved chunks are excluded so the request
abstains with `insufficient_evidence` instead of forwarding poisoned context to
the model. Audit events use `ai.security.prompt_injection` with only finding
counts and dispositions, never prompt or document content.

### Enterprise backend (authoritative IAM)
| Variable | Default | Description |
|---|---|---|
| `ENTERPRISE_API_BASE_URL` | `http://127.0.0.1:3001` | Node/Express backend the AI API authorizes against |
| `ENTERPRISE_API_TIMEOUT_SECONDS` | `10` | outbound timeout |

### PostgreSQL (shared, with pgvector)
| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | `127.0.0.1` | |
| `POSTGRES_PORT` | `5432` | |
| `POSTGRES_DB` | `helix` | |
| `POSTGRES_USER` | `helix` | legacy/development login; production should use the per-workload role below |
| `POSTGRES_PASSWORD` | `change-me` | secret for `POSTGRES_USER` |
| `AI_DB_SCHEMA` | `ai` | schema holding AI metadata |
| `AI_RLS_VERIFY` | `true` | fail startup/readiness if any protected table is missing RLS, `FORCE`, or its tenant policy; emergency diagnostic only |
| `AI_DB_ROLE_PROFILE` | empty | `api`, `worker` (also accepted by the backup tool: `backup`, `migrate`); required in staging/production with PostgreSQL |
| `AI_DB_EXPECTED_ROLE` | empty | exact non-owner `current_user`, e.g. `ai_api`; required with the profile |

Least-privilege provisioning and the `ai_system_access` boundary are described
in `infrastructure/db/roles/README.md` and `docs/tenant-isolation.md`. API and
worker deployments must not share the owner login. Compose uses
`WORKER_POSTGRES_USER`/`WORKER_POSTGRES_PASSWORD` for workers and
`BACKUP_POSTGRES_USER`/`BACKUP_POSTGRES_PASSWORD` for the backup profile.
Restore/drill uses `RESTORE_TARGET_USER`, `RESTORE_TARGET_PASSWORD`,
`RESTORE_TARGET_ROLE_PROFILE`, and `RESTORE_TARGET_EXPECTED_ROLE`.
Migrations use `AI_MIGRATION_DB_USER`, `AI_MIGRATION_DB_PASSWORD`, and
`AI_MIGRATION_ROLE=ai_owner`. `AI_MIGRATION_STOP_AFTER` is a fresh-install-only
guard for stopping after 0018 so roles can be provisioned before 0019.

### Cache
| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | cache/state only, never authoritative |

### Object storage (S3-compatible)
| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | `http://127.0.0.1:8333` | SeaweedFS in local dev |
| `S3_REGION` | `us-east-1` | |
| `S3_BUCKET` | `ai-knowledge` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | empty | secrets |
| `S3_FORCE_PATH_STYLE` | `true` | required for most S3-compatible stores |

### LLM gateway
| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` when no credentials are present |
| `LLM_API_KEY` | empty | secret, never sent to the browser |
| `LLM_BASE_URL` / `LLM_CHAT_MODEL` / `LLM_EMBEDDING_MODEL` | empty | provider config |
| `LLM_EMBEDDING_DIMENSIONS` | `1536` | must match the embedding model and the vector column |

### Search
| Variable | Default | Description |
|---|---|---|
| `SEARCH_PROVIDER` | `postgres` | `postgres` (default) or `opensearch` |
| `OPENSEARCH_URL` | `http://127.0.0.1:9200` | |
| `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` | empty | secrets |
| `OPENSEARCH_INSECURE` | `false` | disable TLS verification (dev only) |

### Events
| Variable | Default | Description |
|---|---|---|
| `EVENT_BUS_PROVIDER` | `database` | `database` (enterprise outbox) / `kafka` / `memory` |
| `KAFKA_BOOTSTRAP_SERVERS` | `127.0.0.1:9092` | |
| `AI_EVENT_TOPIC` | `ai.platform.events` | |
| `AI_EVENT_CONSUMER_GROUP` | `ai-api-events` | |
| `AI_EVENT_MAX_ATTEMPTS` | `5` | retries before dead-lettering |
| `AI_EVENT_BATCH_SIZE` | `20` | events per consumer poll |
| `AI_EVENT_POLL_SECONDS` | `5` | consumer poll interval |
| `AI_EVENT_RETRY_BASE_SECONDS` | `2` | first retry delay (exponential backoff) |
| `AI_EVENT_RETRY_MAX_SECONDS` | `60` | retry delay cap |
| `AI_EVENT_RETRY_JITTER` | `0.1` | fractional retry jitter (0-1) |
| `AI_EVENT_REPLAY_MAX_AGE_DAYS` | `7` | replay window |

### Agents (Phase 9)
| Variable | Default | Description |
|---|---|---|
| `AI_AGENT_DEFAULT_CODE` | `knowledge-assistant` | built-in agent code |
| `AI_AGENT_DEFAULT_VERSION` | `1` | active definition version |
| `AI_AGENT_TIMEOUT_SECONDS` | `30` | wall-clock execution timeout |
| `AI_AGENT_MAX_ITERATIONS` | `6` | bounded graph iteration |
| `AI_AGENT_MAX_TOOL_CALLS` | `6` | tool-call budget per run |
| `AI_AGENT_TRACE_MAX_EVENTS` | `40` | max trace events retained |
| `AI_AGENT_REQUIRE_APPROVAL` | `false` | require approval for all tools |

### Knowledge assistant (Stage 3)
| Variable | Default | Description |
|---|---|---|
| `AI_UPLOAD_MAX_BYTES` | `26214400` | Max upload size (25 MiB) |
| `AI_UPLOAD_REQUIRE_SIGNATURE` | `true` | Enforce content-signature sniffing on upload |
| `AI_MAX_JOB_ATTEMPTS` | `5` | Retries before an indexing job fails |
| `AI_JOB_TIMEOUT_SECONDS` | `120` | Per-attempt indexing timeout |
| `AI_JOB_LEASE_SECONDS` | `300` | Advisory lease for a processing job |
| `AI_JOB_RETRY_BASE_SECONDS` | `5` | First index-job retry delay |
| `AI_JOB_RETRY_MAX_SECONDS` | `300` | Index-job retry delay cap |
| `AI_JOB_RETRY_JITTER` | `0.1` | Fractional index-job retry jitter |
| `AI_INGEST_INLINE` | `true` | Run index jobs in the API; set `false` in the cluster where the indexer owns the queue |

Upload size is enforced in layers: `AI_MAX_REQUEST_BYTES` (32 MiB) caps every
request at the ASGI boundary before routing or parsing, while
`AI_UPLOAD_MAX_BYTES` (25 MiB) remains the document limit applied by the upload
handler. `AI_MAX_REQUEST_BYTES` must be greater than or equal to
`AI_UPLOAD_MAX_BYTES`; settings validation rejects configurations that would
block uploads the application claims to accept. Keep the ingress annotation
`nginx.ingress.kubernetes.io/proxy-body-size` and the web proxy's
`client_max_body_size` at or above the transport cap (both are `32m`).

### Knowledge reconciliation
| Variable | Default | Description |
|---|---|---|
| `AI_RECONCILE_ENABLED` | `true` | Enable the reconciliation worker |
| `AI_RECONCILE_INTERVAL_SECONDS` | `300` | Watch-mode pass interval |
| `AI_RECONCILE_MAX_TENANTS` | `50` | Tenants processed per pass |
| `AI_RECONCILE_LIMIT` | `100` | Sources/documents processed per tenant |
| `AI_RECONCILE_SCAN_ORPHANS` | `true` | Compare index identities with the database |
| `AI_RECONCILE_PURGE_ORPHANS` | `false` | Delete tenant-scoped index orphans |
| `AI_RECONCILE_DRY_RUN` | `false` | Report only; never enqueue or delete |
| `AI_SECURITY_REFRESH_STALE_SECONDS` | `900` | Age at which security refresh is reported overdue |

The event consumer, reconciler, indexer and agent worker are separate processes,
not API lifespan tasks. Their commands, replicas, health endpoints, metrics and
scaling limits are documented in `WORKER_DEPLOYMENT.md`. Keep
`AI_INGEST_INLINE=false` whenever the indexer Deployment is running, otherwise
both the API and the worker can process the same queue.
| `AI_HYBRID_SEARCH_ENABLED` | `true` | Fuse vector + lexical candidates (RRF) |
| `AI_RRF_K` | `60` | Reciprocal rank fusion constant |
| `AI_RETRIEVAL_CANDIDATE_MULTIPLIER` | `4` | Per-list candidate oversampling |

### Enterprise search (Stage 4)
| Variable | Default | Description |
|---|---|---|
| `AI_SEARCH_DEFAULT_LIMIT` | `10` | Default page size for search |
| `AI_SEARCH_CONSOLIDATE_DOCUMENTS` | `true` | Merge chunk hits into document-level results (`hit_count`/`matched_chunks`) |
| `AI_SEARCH_EXACT_BOOST` | `0.5` | Multiplicative boost when a query token matches title/external ID |
| `AI_SEARCH_PHRASE_BOOST` | `0.3` | Multiplicative boost when the full query appears verbatim |
| `AI_SEARCH_TITLE_BOOST` | `0.2` | Multiplicative boost for title matches |
| `AI_SEARCH_FRESHNESS_HALF_LIFE_DAYS` | `0` | Recency half-life; `0` disables freshness ranking |
| `AI_SEARCH_FRESHNESS_WEIGHT` | `0` | Weight of the freshness factor when enabled |
| `AI_DEDUP_SCAN_LIMIT` | `5000` | Max documents inspected per duplicate/conflict scan |

### Enterprise AI Copilot (Stage 5)
| Variable | Default | Description |
|---|---|---|
| `AI_COPILOT_HISTORY_MAX_MESSAGES` | `12` | Most recent turns included in the prompt window |
| `AI_COPILOT_HISTORY_MAX_CHARS` | `12000` | Character budget for the bounded history |
| `AI_COPILOT_SUMMARY_MAX_CHARS` | `2000` | Max size of the derived conversation summary |
| `AI_COPILOT_SUMMARY_THRESHOLD_MESSAGES` | `20` | Transcript size before older turns are summarized |
| `AI_COPILOT_CONTEXT_MAX_ITEMS` | `8` | Authorized context references per request |
| `AI_COPILOT_CONTEXT_MAX_CHARS` | `16000` | Character budget for assembled context |
| `AI_COPILOT_CONTEXT_CHUNK_LIMIT` | `6` | Chunks read per referenced document |
| `AI_COPILOT_COMPARE_MAX_ITEMS` | `5` | Sources accepted by the compare task |
| `AI_COPILOT_EXTRACT_MAX_ITEMS` | `5` | Sources accepted by the extract task |
| `AI_COPILOT_MAX_FIELDS` | `25` | Requested extraction fields per call |
| `AI_COPILOT_MAX_QUESTION_CHARS` | `8000` | Hard bound on instruction/question length |
| `AI_COPILOT_TASK_TIMEOUT_SECONDS` | `60` | Wall-clock bound for a stateless task |
| `AI_COPILOT_STREAM_ENABLED` | `true` | Allow SSE streaming for `ask`/`explain` |
| `AI_COPILOT_SUMMARY_ENABLED` | `true` | Derive summaries; failures never block answers |

File uploads require the object-storage settings (`S3_*`) above; when external
search is selected, `SEARCH_PROVIDER=opensearch` uses the `OPENSEARCH_*` settings
and falls back to PostgreSQL FTS if the index is unavailable.

The external search index is a retrieval accelerator, not an authorization
authority. Every candidate is re-checked against the current document, source and
chunk state before content is returned, cited or sent to a model, so deleted
documents, disabled sources, tightened ACLs and raised classifications take
effect immediately even if the index is stale. Deleting a document or source
removes its search entries first (by stable `source_id`+`external_id` identity)
and fails closed with `503` if the search backend cannot be reached; reindex
jobs also replace prior chunks by that identity. Index and delete operations
request an immediate refresh, so a successful response means the change is
visible to subsequent searches; a failed database delete after a successful
search delete returns `409` when the row was not committed and re-raises
(otherwise retryable) errors after logging, so retries are safe and idempotent.

Source ACLs and classifications are updated through
`PUT /knowledge/sources/{id}/acl` and
`PUT /knowledge/sources/{id}/classification` (permission
`ai.knowledge:update`). Both require the source `version` returned by
`GET /knowledge/sources/{id}` as `expected_version`; a stale version returns
`409` so concurrent or out-of-order writers cannot overwrite newer policy.
Authoritative rows are committed before any index refresh is requested, and a
source ACL update propagates to its documents and chunks in the same
transaction. Non-administrators can tighten ACLs but cannot grant roles,
permissions or user access beyond their own authority; lowering a
classification or removing `deny_all` requires a platform administrator.
Queued refresh is idempotent (`source-security-{id}-v{version}`) and is created
in the same database transaction as the policy update; event publication is a
separate invalidation signal. If either background step fails, the policy stays
applied, the failure is logged/counted, and reconciliation repairs the index.
Failed index jobs and event deliveries retry with persisted exponential backoff
(`next_attempt_at`) and jitter up to `AI_JOB_RETRY_MAX_SECONDS` /
`AI_EVENT_RETRY_MAX_SECONDS`; retries survive worker restarts.

Use `POST /knowledge/reconcile` to enqueue reindex work for documents whose
search sync failed or is stale. The endpoint accepts an optional
`ReconcileRequest`:

```json
{"limit": 100, "scan_orphans": true, "purge_orphans": false}
```

`limit` bounds the tenant-scoped work. `scan_orphans` compares indexed document
identities with authoritative rows and reports orphans, missing sources and
disabled sources. `purge_orphans` (implies scanning) deletes only orphaned
document ids for the caller's tenant and is idempotent; it is off by default.
Disabled sources are reported, never auto-purged, because live revalidation
already excludes them.

Run the automated reconciler with:
`python -m ai_api.workers.reconciler --watch` (or `--once`). It processes a
bounded, stable tenant/page window, skips sources with active index jobs,
reports before repairing, and is idempotent across repeated passes. Dry-run mode
is controlled by `AI_RECONCILE_DRY_RUN`. Reconciliation never reads ACL or
classification values from the index and never deletes authoritative rows.
The security-updated event consumer re-reads the source, ignores stale events
(older `version`), deleted/disabled sources, and enqueues only the authoritative
refresh; malformed or unsupported events dead-letter and remain visible.

### OpenSearch integration tests

Cluster-dependent tests are opt-in and skipped by default. With a disposable
local OpenSearch instance:

```bash
# Start a throwaway single-node cluster on port 9201 (test only).
docker run -d --name ai-opensearch-itest --memory=900m -p 127.0.0.1:9201:9200 \
  -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true \
  -e DISABLE_INSTALL_DEMO_CONFIG=true \
  -e 'OPENSEARCH_JAVA_OPTS=-Xms256m -Xmx256m' \
  opensearchproject/opensearch:2.19.6

# Run the integration suite against it.
AI_TEST_OPENSEARCH=1 OPENSEARCH_URL=http://127.0.0.1:9201 \
  PYTHONPATH=src python3 -m pytest -m integration tests/test_opensearch_integration.py
```

The suite creates indices with a unique `ai-itest-*` prefix and deletes only
those indices. If `AI_TEST_OPENSEARCH=1` is set but the cluster or
`opensearch-py` is unavailable, the tests fail instead of skipping. The
security plugin is disabled only for this disposable test cluster; do not use
that configuration for shared or production deployments.

### Model lifecycle (Phase 11)
| Variable | Default | Description |
|---|---|---|
| `MLFLOW_TRACKING_URI` | `http://127.0.0.1:5000` | External MLflow tracking server |
| `ML_TRACKING_BACKEND` | `auto` | `auto` \| `mlflow` \| `local` |
| `ML_ENABLE_REGISTRATION` | `true` | Register versions with the MLflow model registry |
| `ML_REQUEST_TIMEOUT_SECONDS` | `10` | Per-request timeout for MLflow calls |
| `ML_DEFAULT_FRAMEWORK` | `scikit-learn` | Default framework label |
| `ML_SAMPLE_SEED` | `1729` | Seed for the reference pipeline |

### Durable agent execution (Stage 6)
| Variable | Default | Description |
|---|---|---|
| `AI_AGENT_WORKER_BATCH_SIZE` | `5` | Executions claimed per worker drain |
| `AI_AGENT_EXECUTION_LEASE_SECONDS` | `120` | Lease duration before a stalled worker's execution is reclaimable (10–3600) |
| `AI_AGENT_REQUIRE_APPROVAL` | `false` | Legacy read-only agent approval flag; controlled-mutation tools always require approval |

Each claimed execution carries a monotonic `lease_generation` fencing token in
addition to `lease_owner`. Every execution-owned write (execution row, step,
tool invocation, checkpoint) is guarded by `owner + generation`, so a worker
that loses its lease cannot commit late results. The worker renews the lease in
a background heartbeat every `AI_AGENT_EXECUTION_LEASE_SECONDS / 3` and again
immediately before each tool call; the per-call renewal uses
`max(lease, tool_timeout_seconds + 15)` so a tool that is still running does not
inadvertently become reclaimable.

Hard execution ceilings are enforced regardless of agent definition or caller
input: `max_steps` 25, `max_tool_calls` 30, `max_elapsed_seconds` 600. Requested
budgets are clamped to these values, and invalid budgets are rejected. Tool
input/output JSON Schemas, capability/risk mapping and published tool
availability are re-checked at runtime, not just at creation time.

Approvals are bound to one execution, step, tool version, target and canonical
`operation_hash`, and are single-use: the worker consumes the approval
atomically immediately before executing the side effect. A crash between
consumption and completion leaves an invocation with uncertain outcome, which
fails closed with `reconciliation_required` instead of re-running the effect.
Disabling an agent is durable across publish and rollback.

The Stage 6 worker runs as a separate process:

```bash
# Drain queued executions once, or poll continuously.
python -m ai_api.workers.agent --once
python -m ai_api.workers.agent --watch
```

### Observability
| Variable | Default | Description |
|---|---|---|
| `OTEL_ENABLED` | `false` | Export OpenTelemetry traces to the collector |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:4317` | collector |
| `OTEL_SERVICE_NAME` | `ai-api` | |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | empty | LLM tracing; off unless host and both keys are set |
| `AI_METRICS_AUTH_TOKEN` | empty | Bearer token for API/worker `GET /metrics`; empty fails closed. Deployed environments require >= 32 characters |
| `AI_DOCS_ENABLED` | `false` | Serve Swagger/OpenAPI in production; docs are on in development regardless |
| `PROMETHEUS_URL` / `GRAFANA_URL` | — | dashboards |

`GET /metrics` requires `Authorization: Bearer <AI_METRICS_AUTH_TOKEN>` and is
never anonymous. See `docs/PHASE12_OBSERVABILITY.md`.

### AI API
| Variable | Default | Description |
|---|---|---|
| `AI_API_HOST` | `0.0.0.0` | |
| `AI_API_PORT` | `8000` | |
| `AI_API_LOG_LEVEL` | `info` | |
| `AI_RATE_LIMIT_PER_MINUTE` | `60` | |
| `AI_MAX_REQUEST_BYTES` | `33554432` | ASGI request-body cap (32 MiB), enforced before routing; must be >= `AI_UPLOAD_MAX_BYTES` |

## Secret-handling rules

- Provider keys, database passwords and JWT/session secrets are never
  committed, logged, or returned to the browser.
- If no LLM credentials are configured the platform uses a clearly labelled
  mock provider and never presents mock output as real AI output.
- The AI service derives identity from the enterprise session token and
  re-validates authorization server-side; the browser is never trusted.
