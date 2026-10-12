# Phase 7 - Knowledge ingestion and RAG

Phase 7 turns the AI layer into a functional retrieval-augmented generation
pipeline: register an authorized source, ingest documents (extract -> normalize
-> chunk -> embed), store vectors in PostgreSQL/pgvector, retrieve **only
authorized** content, and answer with citations or an explicit
"insufficient evidence" result.

## Pipeline

```text
register source -> POST .../ingest (job) -> indexer: extract -> normalize
  -> chunk -> embed (provider) -> store documents/chunks/embeddings (pgvector)
  -> source status ready
query -> embed query -> vector_search (tenant-scoped) -> ACL + classification
  filter (server-side) -> rank -> bounded context -> generate -> citations
```

Indexing runs as an **asynchronous job**. In development the API processes the
job inline (`AI_INGEST_INLINE=true`); in any other setup run the worker:

```bash
# Process the current backlog once (safe, idempotent)
python -m ai_api.workers.indexer --once

# Poll continuously
python -m ai_api.workers.indexer --watch
```

## Supported formats

`text/plain`, `text/markdown`, `application/json` and `application/pdf`
(via `pypdf`). PDF extraction fails closed with a validation error if the
dependency is missing. DOCX and other formats are rejected until extraction
and security tests exist for them.

Documents can be supplied as inline `text`, or as `content_base64` with a
`mime_type`/filename. Chunking is deterministic (character budget +
overlap, preferring paragraph/sentence boundaries) and each chunk carries a
checksum for change detection.

## Endpoints

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/ai/knowledge/sources/{id}/ingest` | `ai.knowledge:execute` | Ingest documents (enqueues an index job) |
| `GET` | `/api/v1/ai/knowledge/sources/{id}/documents` | `ai.knowledge:read` | List indexed documents |
| `DELETE` | `/api/v1/ai/knowledge/sources/{id}` | `ai.knowledge:create` | Delete a source (cascades documents/chunks/embeddings) |
| `POST` | `/api/v1/ai/knowledge/index` | `ai.knowledge:execute` | Re-index a source (rebuild chunks/embeddings) |
| `GET` | `/api/v1/ai/knowledge/jobs/{job_id}` | `ai.knowledge:read` | Job status/failure reporting |
| `POST` | `/api/v1/ai/search` | `ai.retrieval:execute` | Authorized vector search |
| `POST` | `/api/v1/ai/rag/query` | `ai.retrieval:execute` | Evidence-based answer with citations |

## Access control (critical rule)

Similarity is **never** authorization. Every candidate chunk is filtered
server-side, before any content is used, against:

- **tenant scoping** (enforced in the SQL/query layer), and
- **classification ceiling** (per-tenant governance; default `internal`), and
- **object ACL** (`deny_all`, `roles`, `permissions`, `users`).

A wrong or partial ACL yields `0` results, never a leak. Superusers (platform
wildcard or `AI_ADMIN_PERMISSIONS`) bypass ACLs but still respect tenant
scoping. Retrieved content is treated as untrusted data and wrapped with
prompt-injection guardrails (`security/prompt_safety.py`).

## Evidence and citations

RAG answers are grounded in retrieved context. If the best candidate scores
below `AI_RAG_MIN_SCORE` (or nothing is authorized), the service returns the
fixed `INSUFFICIENT_EVIDENCE_TEXT` message with `insufficient_evidence: true`
and no citations. Citations are constructed from the actual retrieved chunks
(rank, source, document, chunk, score, snippet); the platform never invents
citations.

> Note: with the default **mock** provider, embeddings are deterministic
> hashing-trick vectors, so retrieval quality is illustrative, not semantic.
> Configure a real `LLM_PROVIDER` for production-quality RAG.

## Storage

Vectors and metadata are stored in the shared enterprise PostgreSQL under the
`ai` schema (`ai.documents`, `ai.document_chunks`, `ai.embeddings`). Embedding
dimensions are fixed at 1536 with a `CHECK` constraint; changing the embedding
model dimension is a deliberate migration, not a runtime option. Cosine
distance (`<=>`) with an HNSW index is used for ANN search; a lexical
`to_tsvector`/`plainto_tsquery` path is used for keyword search.

OpenSearch (`SEARCH_PROVIDER=opensearch`, the `search` Compose profile) is the
optional secondary text index for larger deployments; the default
`SEARCH_PROVIDER=postgres` keeps the lean profile self-contained.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_CHUNK_SIZE` | `800` | Target chunk size (characters) |
| `AI_CHUNK_OVERLAP` | `120` | Chunk overlap (characters) |
| `AI_INGEST_MAX_DOCUMENTS` | `100` | Max documents per ingest request |
| `AI_RAG_MIN_SCORE` | `0.2` | Minimum similarity to answer |
| `AI_RAG_MAX_CONTEXT_CHARS` | `6000` | Bounded prompt context |
| `AI_RAG_DEFAULT_LIMIT` | `5` | Default RAG citations |
| `AI_SEARCH_DEFAULT_LIMIT` | `10` | Default search results |
| `AI_INGEST_INLINE` | `true` | Process index jobs in-process (dev) |
| `AI_WORKER_BATCH_SIZE` | `10` | Worker jobs per batch |
| `AI_WORKER_POLL_SECONDS` | `5` | Worker idle poll interval |

## Evaluation

Retrieval-quality and safety are covered by tests:

- `tests/test_ingestion.py` - extraction, normalization, deterministic chunking.
- `tests/test_access_control.py` - ACL and classification-ceiling semantics.
- `tests/test_retrieval.py` - ACL filtering, classification ceiling, RAG
  grounding with citations, and the insufficient-evidence path.
- `tests/test_api_v1.py` - ingest/list/delete/search/RAG over HTTP.
