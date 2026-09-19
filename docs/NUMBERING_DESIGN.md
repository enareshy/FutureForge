# Enterprise Numbering & Identifier Service — Design

The Numbering & Identifier Service is the platform's single source of truth for
business identifiers. Parts, products, documents, BOMs, drawings, specifications,
engineering changes, suppliers, customers, materials, manufacturing and quality
records all request their identifiers from this one capability; no business module
owns sequence state or invents its own numbering rules. It reuses the platform
foundations rather than re-implementing them: the Background Job engine drives
housekeeping, the Audit service records every mutation, the Event & Messaging
Framework publishes domain events through the transactional outbox, and Search &
Discovery indexes allocations so identifiers are findable.

## Goals

- Configurable, versioned numbering schemes per object type (pattern, prefix/suffix,
  padding, start/increment, reset policy, reuse policy, manual policy).
- A token/pattern engine with a registry of system and custom tokens.
- Deterministic scope resolution (tenant, organization, plant, site, classification,
  object type, scheme override) that refuses ambiguity instead of guessing.
- Concurrency-safe sequence allocation with compare-and-swap updates and a database
  uniqueness guarantee on the rendered identifier.
- Reservation lifecycle (`reserved` -> `consumed` / `released` / `expired` /
  `cancelled`) with automatic expiry.
- Non-mutating preview, idempotent generation, and mandatory manual-number
  validation.
- Immutable scheme versions with effective dates.
- Full audit trail, domain events, metrics and health endpoints.

## Architecture

```
                    ┌──────────────────────────── UI (React) ───────────────────────────┐
                    │  Numbering console: overview · schemes · generate · allocations    │
                    │  sequences                                                         │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │ /api/numbering, /api/v1/numbering
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │ Express router (server/app.js) — auth + can("iam.numbering.*")     │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │
        ┌───────────────┬───────────────┬───────────┼───────────┬───────────────┐
        ▼               ▼               ▼           ▼           ▼               ▼
   Schemes         Sequences       Allocations   Tokens      Foundation     Metrics
   versions        CAS counter     lifecycle     pattern     object types   health
        │               │               │           │           │               │
        └───────────────┴───────┬───────┴───────────┴───────────┴───────────────┘
                                ▼
        Audit · Event outbox · Search index · Background jobs (SQLite, shared)

Business modules depend on the flat SDK in `server/services/numbering.js`
(`generateIdentifier`, `reserveIdentifier`, `previewIdentifier`,
`validateIdentifier`, `consumeIdentifier`, `releaseIdentifier`, `cancelIdentifier`,
`nextNumber`) and never touch the tables directly.
```

## Module layout

- `server/services/numbering.js` — public facade and flat SDK.
- `server/services/numbering/errors.js` — `NumberingError` and stable error codes.
- `server/services/numbering/validation.js` — enums, input normalisation, vocabulary.
- `server/services/numbering/tokens.js` — pattern parser, resolver registry, tokens.
- `server/services/numbering/scopes.js` — scheme resolution, scope/period keys.
- `server/services/numbering/sequences.js` — sequence rows and CAS allocation.
- `server/services/numbering/schemes.js` — scheme CRUD, immutable versions, status.
- `server/services/numbering/allocations.js` — generation, reservations, lifecycle,
  idempotency, reuse, manual validation, metrics.
- `server/services/numbering/foundation.js` — default object types, scopes, tokens.
- `server/services/numbering/events.js` — numbering event types and emitters.
- `server/services/numbering/search.js` — search source resolver and indexing.
- `server/services/numbering/metrics.js` — health and dashboard summaries.
- `server/services/numbering/jobs.js` — background handlers and maintenance.

## Data model

- `numbering_object_types` — the objects that can own identifiers (`PART`,
  `DOCUMENT`, ...) with status.
- `numbering_tokens` — resolvable pattern tokens (system and custom).
- `numbering_scopes` — the scope dimensions supported (tenant, organization, plant,
  site, classification).
- `numbering_schemes` — the active scheme header (mutable administrative metadata).
- `numbering_scheme_versions` — immutable configuration snapshots; changing a
  versioned field creates a new version.
- `numbering_sequences` — the counters, keyed by scheme + scope key + period key,
  updated with `UPDATE ... WHERE current_value = ?` (compare-and-swap).
- `numbering_allocations` — every identifier ever issued, with a unique
  `uniqueness_key` so the same value can never be issued twice in a scope.
- `numbering_idempotency` — request hashes for safe retries.

## Pattern and token engine

Patterns are literal text interleaved with `{TOKEN}` placeholders. The default token
set is `{SEQ}`, `{YYYY}`, `{YY}`, `{MM}`, `{DD}`, `{WW}`, `{ORG}`, `{PLANT}`,
`{SITE}`, `{CLASS}`, `{TYPE}` and `{USER}`. `{SEQ}` is the only token that advances
the counter; every other token is resolved from the request context. Example:

```
PART-{YYYY}-{SEQ}  ->  PART-2026-000001
```

## Sequence and uniqueness guarantees

A sequence is identified by `(scheme, scope_key, period_key)`. Allocation is a
compare-and-swap: read the row, compute the next value, then
`UPDATE numbering_sequences SET current_value = ? WHERE id = ? AND current_value = ?`.
If the update does not affect exactly one row the operation retries; if the maximum
value is exceeded the sequence is marked `exhausted`. Reset policies (`never`,
`daily`, `monthly`, `yearly`, `fiscal_year`) are expressed through the period key, so
a new period transparently starts a fresh counter. The rendered identifier is
inserted with a unique `uniqueness_key` (`scope|value`) inside the same transaction,
which is the final backstop against duplicate numbers.

## Scope resolution and ambiguity

When a caller does not pass an explicit scheme code the resolver scores every active,
effective scheme for the object type. Higher scores win (tenant 100, organization 10,
plant 5, site 4, classification 2). Ties are broken by priority and then the default
flag; if two candidates remain indistinguishable the request is rejected with
`ambiguousScheme` rather than issuing an unpredictable identifier. An explicit scheme
code still has to match the request scope.

## Reservation lifecycle

```
reserve ──consume──▶ consumed
   │
   ├──release──▶ released
   ├──cancel───▶ cancelled
   └──timeout──▶ expired
```

Reservations carry an `expires_at`; the background maintenance sweep moves overdue
rows to `expired`. Reuse policies (`never_reuse`, `reuse_after_release`,
`reuse_after_expiration`, `custom`) decide whether released or expired values become
available again.

## Idempotency

Callers may pass an `Idempotency-Key` header (or `idempotencyKey` field). The service
stores the request hash; a repeat with the same key and payload returns the original
allocation instead of issuing a new number. A repeat with a different payload is
rejected. Idempotency records are pruned by the maintenance job.

## Events, audit and search

Every scheme change and allocation transition writes an audit record and emits a
domain event (`NumberingSchemeCreated`, `NumberingSchemeActivated`,
`NumberAllocated`, `NumberReserved`, `NumberConsumed`, `NumberReleased`,
`NumberCancelled`, `NumberExpired`) through the transactional outbox. Allocations are
registered as a search source (`numbering_allocation`) so identifiers can be found
from Search & Discovery.

## Related documents

- `docs/NUMBERING_API.md` — HTTP reference.
- `docs/NUMBERING_OPERATIONS.md` — day-2 operations and troubleshooting.
