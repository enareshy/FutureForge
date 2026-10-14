# RAG — ingestion and retrieval

Retrieval-augmented generation grounds answers in the caller's **authorized**
knowledge and returns citations. The design and implementation details are in
`PHASE7_KNOWLEDGE_RAG.md`; this is the operational summary. Stage 3 extends the
pipeline with real file uploads, hybrid retrieval and a grounded assistant.

## Ingestion pipeline

```mermaid
graph LR
    Upload["Upload file"] --> Validate["Validate (size, signature, MIME)"]
    Validate --> Store["Object storage (S3/SeaweedFS)"]
    Store --> Enqueue["Indexing job (ai.indexing_jobs)"]
    Enqueue --> Extract["Extract segments (pypdf, text/markdown)"]
    Extract --> Chunk["Chunk segments (page/section aware)"]
    Chunk --> Embed["Embed (provider gateway)"]
    Embed --> Write["Upsert chunks + vectors (pgvector)"]
    Write --> Index["Sync external search index"]
    Index --> Audit["Audit + event"]
```

- **Sources** group documents (`/knowledge/sources`). Documents are stored in
  object storage; metadata and chunks live in PostgreSQL (`ai` schema).
- **Upload validation** (`/knowledge/sources/{source_id}/upload`) enforces
  `AI_UPLOAD_MAX_BYTES`, sniffs the content signature (never trusts the file
  extension or declared MIME) and rejects unsupported/empty payloads with
  `422`. Documents are deduplicated by content checksum within a tenant.
- **Object storage** returns a tenant-scoped `object_key`
  (`ai.documents.object_key`); the platform never exposes a public object URL.
  Downloads stream through the authorization-gated API
  (`/knowledge/documents/{document_id}/download`).
- **Chunking** uses `AI_CHUNK_SIZE` / `AI_CHUNK_OVERLAP` and preserves each
  segment's page (PDF) and section (markdown), surfaced on citations.
- **Embeddings** are produced by the provider gateway; dimensions are fixed at
  1536 (enforced by a `CHECK` constraint). The mock provider is deterministic.
- **Indexing** is a durable job: it can run inline (`AI_INGEST_INLINE=true`, dev)
  or in the indexer worker (`python -m ai_api.workers.indexer --watch`). Each
  run takes an advisory **lease** (`AI_JOB_LEASE_SECONDS`) and is bounded by
  `AI_JOB_TIMEOUT_SECONDS`; failures are classified and retried up to
  `AI_MAX_JOB_ATTEMPTS` before failing with a safe `error_class`.

## Retrieval

- Query embeddings are compared with stored vectors using **pgvector cosine
  distance** (`<=>`), with an HNSW index.
- When `AI_HYBRID_SEARCH_ENABLED=true`, a lexical candidate list (PostgreSQL
  full-text by default, or OpenSearch when `SEARCH_PROVIDER=opensearch`) is
  fused with the vector list using **reciprocal rank fusion** (`AI_RRF_K`).
  Each list is oversampled by `AI_RETRIEVAL_CANDIDATE_MULTIPLIER`.
- The query is filtered by tenant and the caller's ACL **before** ranking,
  independently for each candidate list, and results are re-checked. Ranking
  never grants access.
- `AI_RAG_MIN_SCORE` is the minimum similarity for a chunk to count as
  evidence. `AI_RAG_DEFAULT_LIMIT` / `limit` bound the number of chunks.
- If external search is unavailable the platform falls back to PostgreSQL FTS;
  `/readyz` reports the configured provider honestly.

## Answering and citations

- Relevant authorized chunks form the context (bounded by
  `AI_RAG_MAX_CONTEXT_CHARS`).
- If no chunk clears the threshold, the platform returns
  `insufficient_evidence: true` with **no citations** — it does not fabricate
  sources.
- Otherwise the answer carries `citations[]` (source, document, chunk index,
  page, section, score, snippet) rendered by the console as links back to the
  source.

## Assistant conversations

- `POST /assistant/conversations` creates a conversation scoped to the tenant
  and actor; `POST /assistant/conversations/{id}/messages` runs a grounded
  answer and persists both messages and the citation **snapshots**
  (`ai.assistant_message_sources`).
- Authorization is re-validated on every request: a conversation stored earlier
  never widens access to documents the caller can no longer see.
- Feedback (`POST /assistant/feedback`) references the answered message
  (`ai.feedback.message_id`).

## Reindex and retry

- `POST /knowledge/sources/{source_id}/reindex` rebuilds chunks and embeddings
  from stored bytes/chunk text without re-uploading.
- `POST /knowledge/jobs/{job_id}/retry` requeues a `failed`/`queued` job after
  clearing its error; succeeded jobs are a no-op. Stale `running` jobs whose
  lease expired are reclaimed back to `queued`.

## Untrusted content

Retrieved text is treated as data, not instructions. Prompt-injection payloads
inside documents are passed through as text and cannot invoke tools or broaden
access (see `security.md`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_CHUNK_SIZE` | 800 | Chunk size (characters). |
| `AI_CHUNK_OVERLAP` | 120 | Chunk overlap. |
| `AI_INGEST_INLINE` | true | Process indexing inline (dev). |
| `AI_INGEST_MAX_DOCUMENTS` | 100 | Max documents per ingest call. |
| `AI_UPLOAD_MAX_BYTES` | 26214400 | Max upload size (25 MiB). |
| `AI_UPLOAD_REQUIRE_SIGNATURE` | true | Enforce content-signature sniffing. |
| `AI_MAX_JOB_ATTEMPTS` | 5 | Retries before a job fails. |
| `AI_JOB_TIMEOUT_SECONDS` | 120 | Per-attempt processing timeout. |
| `AI_JOB_LEASE_SECONDS` | 300 | Advisory lease for a processing job. |
| `AI_HYBRID_SEARCH_ENABLED` | true | Fuse vector + lexical candidates. |
| `AI_RRF_K` | 60 | Reciprocal rank fusion constant. |
| `AI_RETRIEVAL_CANDIDATE_MULTIPLIER` | 4 | Per-list oversampling. |
| `SEARCH_PROVIDER` | postgres | `postgres` (FTS) or `opensearch`. |
| `AI_RAG_MIN_SCORE` | 0.2 | Minimum similarity for evidence. |
| `AI_RAG_MAX_CONTEXT_CHARS` | 6000 | Context budget. |
| `AI_RAG_DEFAULT_LIMIT` | 5 | Default chunks. |
| `LLM_EMBEDDING_DIMENSIONS` | 1536 | Embedding size (fixed). |

## Troubleshooting

Stuck or dead-lettered jobs, and "insufficient evidence" for known content, are
covered in `troubleshooting.md`.
