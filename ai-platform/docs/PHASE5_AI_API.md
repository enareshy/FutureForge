# Phase 5 - AI API application services

Phase 5 turns the layered skeleton from Phase 2 and the provider gateway from
Phase 4 into a usable, tenant-scoped HTTP API: capabilities, chat, summarize,
knowledge registry, usage, audit, and gated retrieval/agents routes. Every request
is authenticated and authorized server-side before any work is attempted.

## What was added

| Area | Path |
| --- | --- |
| Persistence port | `src/ai_api/application/ports.py` (`AiRepository`) |
| Postgres adapter | `src/ai_api/infrastructure/db/database.py`, `infrastructure/repositories/postgres_ai_repository.py` |
| In-memory adapter | `src/ai_api/infrastructure/repositories/memory_ai_repository.py` |
| Services | `src/ai_api/application/services/*` |
| Schemas | `src/ai_api/schemas/*` |
| Routes | `src/ai_api/api/v1/routes/*` |
| Identity | `src/ai_api/security/identity.py` |

The `AiRepository` port is deliberately narrow: services depend on it, never on
asyncpg. This keeps the HTTP paths testable in-memory and lets the Postgres SQL be
verified in isolation.

## Request pipeline

```
request -> x-request-id -> identity (Principal) -> authorization policy
        -> rate limit -> service -> repository/gateway -> audit + usage
```

- **Identity** (`security/identity.py`): verifies the enterprise session token.
  In non-production a `DevelopmentIdentityProvider` (tenant from
  `AI_DEV_TENANT_ID`, permissions from `AI_DEV_PERMISSIONS`) is used; in production
  an `UnavailableIdentityProvider` fails closed so no anonymous access is possible.
- **Authorization**: the `Principal` carries tenant id and permissions; retrieval
  and tool actions check permissions before doing anything.
- **Rate limiting**: per-principal limiter bounded by `AI_RATE_LIMIT_PER_MINUTE`
  plus the gateway's own `LLM_REQUESTS_PER_MINUTE`.
- **Pagination**: list endpoints use `AI_DEFAULT_PAGE_LIMIT` / `AI_MAX_PAGE_LIMIT`
  and return `{ items, meta: { total, limit, offset } }`.

## Feature gating

Capabilities reports each feature's state. Unimplemented features fail closed with
`503 feature_unavailable` (never a partial or insecure result):

| Feature | State |
| --- | --- |
| `chat` | available |
| `summarize` | available |
| `models` | available |
| `embeddings` | available |
| `search` | `planned:phase7` |
| `rag_query` | `planned:phase7` |
| `knowledge_index` | `planned:phase7` |
| `agents_execute` | `planned:phase9` |

## Configuration

New settings (see `ai-platform/.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_REPOSITORY` | `postgres` | Persistence backend (`postgres` or `memory`) |
| `AI_DEFAULT_PAGE_LIMIT` | `50` | Default page size |
| `AI_MAX_PAGE_LIMIT` | `200` | Maximum page size |
| `AI_DEV_TENANT_ID` | `1` | Tenant used by the development identity |
| `AI_DEV_PERMISSIONS` | `*:*` | Permissions used by the development identity |

The settings loader discovers `.env` from the current directory, its parent, or its
grandparent, so running `uvicorn` from `apps/ai-api` still picks up
`ai-platform/.env`.

## Security invariants

- ACL/permission checks happen **before** retrieval and before tool actions.
- pgvector similarity is a ranking signal only - never an authorization decision.
- Retrieved documents are treated as untrusted input.
- Secrets are never logged, returned in responses, or sent to the browser.

## Verification (Phase 5)

- `ruff check src tests` clean.
- `python3 -m pytest` -> 41 passed.
- Repository verification against the real PostgreSQL `ai` schema, executed inside a
  transaction that is rolled back (no persistent rows): knowledge source create +
  duplicate rejection, job create + idempotency, execution + usage summary, audit
  write/list, agents list.
- Live HTTP smoke (development identity): `401` without a token; `200` for
  `capabilities`, `models`, `knowledge/sources`, `usage`, `audit`, `agents`;
  `503 feature_unavailable` for `search`; `/healthz` ok.

Run the quality gates:

```bash
cd apps/ai-api
ruff check src tests
python3 -m pytest
```
