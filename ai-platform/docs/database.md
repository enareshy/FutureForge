# Database

The AI platform stores its metadata and vectors in the **existing shared
enterprise PostgreSQL** instance, under a dedicated `ai` schema. It does not
introduce a second database. Vectors are stored with the `pgvector` extension;
no additional vector database is used in V1.

- Host/port: `POSTGRES_HOST` / `POSTGRES_PORT` (default `127.0.0.1:5432`).
- Database/user: `POSTGRES_DB` / `POSTGRES_USER` (default `helix`).
- Schema: `AI_DB_SCHEMA` (default `ai`).
- Migrations: `ai-platform/migrations/`, applied by `scripts/migrate.sh`
  (`make migrate`). Each file runs in a single transaction and is recorded in
  `ai.schema_migrations`.

## Data model

All tables carry `tenant_id bigint NOT NULL`. Tenant scoping aligns with the
enterprise `organizations.id` value, but the `ai` schema does **not** declare a
cross-schema foreign key to `organizations`; this keeps the AI schema portable.
The application enforces tenant isolation. Timestamps are `timestamptz`
(stored UTC).

### Configuration (0002)

| Table | Purpose |
|---|---|
| `platform_settings` | Per-tenant typed key/value configuration (`jsonb`) |
| `providers` | LLM/embedding/rerank providers. `credential_ref` points at the secret manager; never a secret value |
| `models` | Models under a provider, with `capabilities` and `embedding_dimensions` |
| `model_versions` | Immutable model configuration versions |
| `prompt_templates` / `prompt_versions` | Prompt bodies and versions (`draft`/`active`/`archived`) |
| `agents` / `agent_versions` | Agent definitions and versioned configs |

### Knowledge & vectors (0003)

| Table | Purpose |
|---|---|
| `knowledge_sources` | Registered sources (file/url/object/manual) with classification, `acl` and status |
| `documents` | Document metadata + object-store pointer (`object_key`); natural key `(source_id, external_id)` |
| `document_chunks` | Chunk content with classification and `acl` stored alongside the indexed text |
| `embeddings` | `vector(1536)` per chunk/model; `HNSW` `vector_cosine_ops` index |

Deleting a source cascades to documents, chunks, and embeddings, so stale
vectors never remain after deletion or re-indexing.

### Runtime (0004)

| Table | Purpose |
|---|---|
| `executions` | One row per AI operation (`chat`/`embed`/`rag`/`agent`), with `request_id` correlation |
| `usage_records` | Token/request quantities and cost metadata |
| `evaluations` / `evaluation_results` | Evaluation definitions and per-case results |
| `feedback` | User feedback on an execution |
| `audit_events` | Local audit mirror referencing the enterprise audit service |
| `jobs` | Background job / indexing status, with `(tenant_id, idempotency_key)` uniqueness |

### Events (0006)

| Table | Purpose |
|---|---|
| `ai.events` | Durable, versioned event log (AI + reserved enterprise types) |
| `ai.event_deliveries` | Per-consumer-group status/attempts for each event |
| `ai.event_dead_letters` | Events that exhausted `AI_EVENT_MAX_ATTEMPTS` |

### Agents (existing 0002 / 0004 tables)

Phase 9 introduces no new migration: agent definitions reuse `ai.agents` plus
`ai.agent_versions` (configuration, 0002) and agent runs are recorded in
`ai.executions` with `operation = 'agent'` and the `agent_id` foreign key
(runtime, 0004).

| Table | Purpose |
|---|---|
| `ai.agents` | Registered agents (unique per tenant by `code`) |
| `ai.agent_versions` | Immutable versioned `definition` JSON with `status` (`draft`/`active`/`archived`) |
| `ai.executions` | Agent runs (`operation='agent'`) with status, latency, token usage and trace in `output` |

### Experiment tracking & model registry (0007)

Phase 11 adds the machine-learning tables. All are tenant-scoped; the `ai`
schema is the authorization-metadata authority and an external tracker (MLflow)
is only an optional mirror referenced by `external_*` columns.

| Table | Purpose |
|---|---|
| `ai.experiments` | Experiment definitions (unique per tenant by `code`) |
| `ai.experiment_runs` | Runs with `run_uuid`, `status`, params/metrics, dataset ref and tracker refs |
| `ai.ml_models` | Registered classical-ML models with `stage` |
| `ai.ml_model_versions` | Immutable versions (unique `(ml_model_id, version)`) tied to a run |

Evaluation definitions (`ai.evaluations`) and per-case results
(`ai.evaluation_results`) already exist from 0004 and are reused as-is.

### Knowledge assistant (0008)

Stage 3 adds the assistant conversation tables and enriches existing ones. All
are tenant-scoped and reuse the existing knowledge/feedback/jobs tables rather
than duplicating them.

| Table | Purpose |
|---|---|
| `ai.assistant_conversations` | Conversation scoped to tenant + actor, with `title`, `status` and `metadata` |
| `ai.assistant_messages` | Ordered user/assistant/system messages with answer status, confidence, model/provider and token usage |
| `ai.assistant_message_sources` | Citation **snapshots** (rank, source/document/chunk, page/section, score, snippet) captured at answer time |

Column additions:

- `ai.documents`: `search_indexed_at`, `error_class` and a
  `documents_tenant_checksum_idx` for upload deduplication.
- `ai.document_chunks`: `page`, `section`.
- `ai.jobs`: `stage`, `max_attempts`, `error_class`, `lease_expires_at`.
- `ai.feedback`: `message_id` (references the answered assistant message).

Conversation deletion cascades to its messages and message sources.

## Embedding dimensions and similarity

- Embedding models in V1 are the 1536-dimension class
  (e.g. `text-embedding-3-small`). pgvector requires a fixed dimension for both
  the column and the ANN index, so the column is `vector(1536)` and a
  `CHECK (dimensions = 1536)` constraint documents the invariant. Inserting a
  vector of another dimension is rejected by PostgreSQL.
- Changing the embedding dimension is a deliberate migration (new column or
  new table plus re-embedding), not a runtime setting.
- Similarity metric is **cosine distance** (`<=>`), matching normalized
  embedding outputs. Exact vs approximate search is controlled at query time
  (an ordered scan ignores the index; forcing the index uses HNSW).

## Authorization

`tenant_id`, `classification`, and `acl` are stored with the indexed content.
The application must apply these filters **before** retrieval results are
returned or used, and again before any action. **Vector similarity is never
authorization** and must never be the sole gate for access.

## Idempotency and retries

- `documents (source_id, external_id)` prevents duplicate documents on retry.
- `document_chunks (document_id, chunk_index)` prevents duplicate chunks.
- `embeddings (chunk_id, model_code)` prevents duplicate embeddings.
- `jobs (tenant_id, idempotency_key)` prevents duplicate job submission.

## Retention and deletion

- Deleting a `knowledge_source` cascades to `documents` -> `document_chunks` ->
  `embeddings`.
- Deleting an `execution` cascades to its `usage_records` and `feedback`;
  `audit_events.execution_id` is set to `NULL` so audit history is retained.
- Business retention windows are enforced by the application/job layer.

## Rollback

Migrations are forward-only (matching the existing platform's approach). To
roll back a version, author a new forward migration that reverses it, or, for a
destructive reset in a non-production environment only:

```sql
DROP SCHEMA ai CASCADE;  -- development resets only; destroys all AI data
```

Never run destructive resets against a shared or production database.

## Verifying

```bash
make migrate   # applies pending migrations (idempotent)
make health    # checks connectivity and the presence of the ai schema
```
