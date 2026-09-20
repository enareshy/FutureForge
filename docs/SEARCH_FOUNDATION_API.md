# Enterprise Search Foundation HTTP API

Canonical, provider-independent search across every registered object type. All
routes are under `/api/v1/search` and require a bearer token; each route lists
the permission it enforces. Errors are returned as
`{ "error": "<message>", "code": "SEARCH_*", "details": <object|null> }`.

Design notes: `docs/SEARCH_FOUNDATION_DESIGN.md`.

## Canonical query

Request bodies accept camelCase (and the equivalent snake_case) keys:

| Field | Type | Notes |
| --- | --- | --- |
| `text` | string | Free text. Parsed for `field:value`, `*`/`?` wildcards, `"phrases"`, `AND`/`OR`/`NOT` and parentheses. |
| `objectTypes` | string[] | Restrict to registered object types. |
| `filters` | array | `{ field, operator, value }` predicates, combined with `AND` by default. |
| `condition` | object | Nested `{ operator: "and"\|"or"\|"not", filters: [], conditions: [] }`. |
| `facets` | string[] | Fields to aggregate; counts are computed from authorised rows only. |
| `sort` | array | `[{ field, direction: "ASC"\|"DESC" }]`; omitted means relevance. |
| `page` | integer | 1-based. Default `1`. |
| `pageSize` | integer | Default `25`, maximum `200`. |
| `scope` | string | `tenant` (default), `organization`, `site`, `global`. |
| `highlight` | boolean | Default `true`. |
| `effectivity` | object | `{ asOfDate, serialNumber, plant, unit, model, variant, configuration, revision }`. |

Operators: `EQ`, `NE`, `GT`, `GTE`, `LT`, `LTE`, `CONTAINS`, `STARTS_WITH`,
`ENDS_WITH`, `WILDCARD`, `IN`, `NOT_IN`, `IS_NULL`, `IS_NOT_NULL`, `BETWEEN`.
`IN`/`NOT_IN` take an array; `BETWEEN` takes a two-element array.

## Query

### `POST /api/v1/search`

Permission: `iam.search.global:read`.

```json
{
  "text": "compressor AND classification:internal",
  "objectTypes": ["product", "part"],
  "filters": [{ "field": "status", "operator": "EQ", "value": "RELEASED" }],
  "facets": ["object_type", "status", "classification"],
  "sort": [{ "field": "updated_at", "direction": "DESC" }],
  "page": 1,
  "pageSize": 25,
  "highlight": true,
  "effectivity": { "asOfDate": "2026-01-01", "plant": "DE01" }
}
```

Returns the canonical `SearchResult`: `results`, `facets`, `total`, `page`,
`pageSize`, `pages`, `tookMs`, `objectTypes`, `sort`, `strategy`, `scope`,
`provider`, `disabled`.

### `POST /api/v1/search/count`

Permission: `iam.search.global:read`. Same body as search; returns
`{ total, objectTypes, tookMs, query, disabled }`.

### `POST /api/v1/search/parse`

Permission: `iam.search.global:read`. Body `{ "query": "name:Brake* AND status:RELEASED" }`;
returns the parsed query, the canonical operators and the extended operators.

### `POST /api/v1/search/bulk`

Permission: `iam.search.advanced:read`. Body `{ "queries": [ ...SearchQuery ] }`,
at most 10 queries; returns `{ results: [ SearchResult ] }`.

### `GET /api/v1/search/facets`

Permission: `iam.search.global:read`. Query params mirror the canonical query
(`q`, `object_types`, `facets` comma-separated). Returns `{ facets, total }`.

### `GET /api/v1/search/suggestions`

Permission: `iam.search.global:read`. Query params `q`, `limit`. Returns
`{ suggestions, ranking, semanticProviders }`; suggestion items carry
`text`, `type` (`recent` | `tag` | `title` | `object_type`), `count`,
`object_type` and `highlighted`.

## Objects and fields

### `GET /api/v1/search/objects`

Permission: `iam.search.global:read`. Returns `{ objects, pageLimits, operators }`
where each object is the registered searchable type. Add
`?include_disabled=true` to include disabled types.

### `GET /api/v1/search/objects/:objectType`

Permission: `iam.search.global:read`. Returns `{ objectType, fields }`; each
field declares `dataType`, `searchable`, `filterable`, `sortable`, `facetable`,
`fullText`, `exactMatch`, `wildcard` and `allowedOperators`.

### `GET /api/v1/search/fields`

Permission: `iam.search.configuration:read`. Optional `?object_type=`. Returns
`{ fields, dataTypes, operators }`.

### `POST /api/v1/search/fields`

Permission: `iam.search.configuration:update`. Registers or updates an explicit
canonical field definition (data type and capability flags). Returns the field.

### `DELETE /api/v1/search/fields/:objectType/:field`

Permission: `iam.search.configuration:update`. Removes an explicit field
definition; the derived default is used afterwards.

## Saved searches and history

### `GET /api/v1/search/saved`

Permission: `iam.search.saved:read`. Returns `{ savedSearches }` (owned plus
shared). `?include_shared=false` restricts to owned.

### `POST /api/v1/search/saved`

Permission: `iam.search.saved:create`. Body:

```json
{
  "name": "Released products in DE01",
  "description": "optional",
  "sharing_scope": "private",
  "query": { "text": "", "filters": [{ "field": "status", "operator": "EQ", "value": "RELEASED" }] }
}
```

Returns the saved search (including `uuid`). `sharing_scope` is `private` or
`tenant`.

### `GET|PUT|DELETE /api/v1/search/saved/:reference`

Permissions: `iam.search.saved:read` / `:update` / `:delete`. `:reference` is
the saved-search `uuid` or numeric id. Only the owner (or a tenant admin for
shared searches) may mutate it.

### `POST /api/v1/search/saved/:reference/execute`

Permission: `iam.search.saved:read`. Optional body overrides for the stored
query; returns `{ savedSearch, ...SearchResult }` and increments usage.

### `GET /api/v1/search/history`

Permission: `iam.search.history:read`. Query params `limit`, `q`. Returns
`{ history }` with `id`, `query`, `filters`, `result_count`, `duration_ms`,
`executed_at`.

### `DELETE /api/v1/search/history` and `/api/v1/search/history/:id`

Permission: `iam.search.history:delete`. `?all=true` clears the caller's whole
history; the `:id` form removes one entry.

## Index administration

### `POST /api/v1/search/index`

Permission: `iam.search.indexes:execute`. Upserts/deletes one or many documents:

```json
{ "documents": [
  { "objectType": "product", "objectId": "42", "operation": "upsert" },
  { "objectType": "product", "objectId": "41", "operation": "delete" }
] }
```

Returns per-document status plus `indexed` and `failed` counts.

### `POST /api/v1/search/index/rebuild`

Permission: `iam.search.indexes:execute`. Body `{ scope, objectType?, objectId?, organizationId?, limit? }`
where `scope` is `full` (default), `object_type`, `organization` or `object`.
Set `async: true` to submit a `SEARCH_REINDEX` job and receive `202`
`{ queued, job_ref, job }`. Synchronous rebuild returns `{ scope, result }`.

### `GET /api/v1/search/index/status`

Permission: `iam.search.indexes:read`. Returns `{ status, failures }` with
document totals, queue depth by state and the current dead-letter count.

### `GET /api/v1/search/index/jobs`

Permission: `iam.search.indexes:read`. Lists `SEARCH_REINDEX` jobs; optional
`status`, `limit`.

### `POST /api/v1/search/index/retry-failed`

Permission: `iam.search.indexes:execute`. Re-drives failed and (optionally)
dead-lettered indexing entries. Body `{ include_dead_letter?: boolean }`.

## Extracted text (content integration)

### `POST /api/v1/search/content-text`

Permission: `iam.search.indexes:execute`.

```json
{ "objectType": "document", "objectId": "42", "contentId": "c1", "language": "en", "text": "..." }
```

Stores extracted text and immediately reindexes the object. Binary payloads must
never be indexed; only extracted text is accepted.

### `GET /api/v1/search/content-text`

Permission: `iam.search.global:read`. Query params `object_type`, `object_id`,
`limit`; returns `{ items }`.

### `DELETE /api/v1/search/content-text`

Permission: `iam.search.indexes:execute`. Body
`{ objectType, objectId, contentId? }`; deletes stored text and reindexes.

## Observability

### `GET /api/v1/search/health`

Permission: `iam.search.indexes:read`. Provider and index readiness.

### `GET /api/v1/search/metrics`

Permission: `iam.search.indexes:read`. Query volume, latency, indexing status
and failure counts for the tenant.

### `GET /api/v1/search/meta`

Permission: `iam.search.global:read`. Operators, extended operators, data
types, effectivity context fields, ranking strategies, semantic providers,
effectivity resolvers, page limits and the tenant's object types.
