# Search & Discovery Framework Design

The Search & Discovery Framework is a shared platform service that centralises
search across every business module. Modules register a searchable **object
type** and a **source resolver**; the framework owns indexing, query execution,
filtering, facets, suggestions, saved searches, history, permission filtering,
tenant isolation, index administration and exports. Business modules never build
their own search engines.

Related documents: `docs/OBJECT_FRAMEWORK_DESIGN.md`,
`docs/METADATA_DESIGN.md`, `docs/FILE_MANAGEMENT_DESIGN.md`,
`docs/AUTHORIZATION_DESIGN.md`, `docs/AUDIT_DESIGN.md`,
`docs/JOB_EXECUTION_DESIGN.md` and the day-2 guide
`docs/SEARCH_DISCOVERY_OPERATIONS.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| Index schema, indexing pipeline, query execution, ranking, facets, suggestions | Search & Discovery |
| Saved searches, search history, result exports | Search & Discovery |
| Object types, attributes, relationships | Metadata & Object Framework |
| File metadata and documents | Document & File Management |
| Identity, roles and permission evaluation | IAM / Authorization |
| Tenant scoping and platform administration | Tenants / Organizations |
| Audit trail | Audit |
| Durable/async index and export execution | Job Scheduling & Execution Engine |

Search does not duplicate IAM, tenant, object, relationship, file, audit or job
functionality. It consumes those modules through their public service facades
and emits events back into the platform.

## 2. Data model

Defined in `server/schema.sql` (migration marker `018_search`):

| Table | Purpose |
| --- | --- |
| `search_object_types` | Registered searchable types per tenant (source, key, title/body attributes, permission resource, sensitivity, status) |
| `search_index` | Denormalised, tenant-scoped search documents (one row per object) |
| `search_index_status` | Durable index change queue (upsert/delete with retries and backoff) |
| `search_saved_searches` | Named, reusable queries with sharing scope |
| `search_history` | Per-user executed queries with result counts and durations |
| `search_exports` | Requested result exports (JSON/CSV) with retention |
| `search_configuration` | Per-tenant feature configuration |
| `search_relationships` | Edge projections used for relationship-aware search |

Key invariants:

- `search_index` is unique on `(tenant_id, object_type, object_id)`; upserts
  coalesce, so repeated change events never create duplicates.
- Every document carries `tenant_id` and an optional `organization_id`; queries
  never cross tenant boundaries.
- The queue is durable: enqueue happens inside the business write, draining
  happens elsewhere, and failures are retried with exponential backoff
  (`15s, 60s, 300s, 900s, 3600s`) up to `max_attempts`, then dead-lettered.
- Indexing is a projection. `search_index` can always be rebuilt from the
  system-of-record tables via reindex.

## 3. Service layout

```
server/services/search/
  validation.js     vocabulary, filter/condition operators, scopes, validation
  repository.js     row -> DTO mapping, tenant-safe lookups
  state.js          per-tenant enabled state
  queue.js          enqueueIndexChange (durable queue writer)
  sources.js        source resolvers (object, file) + registry
  indexing.js       build/upsert/delete, applyIndexChange, drain, reindex, prune
  config.js         per-tenant configuration
  registry.js       object-type registration + initialization
  authorization.js  per-type permission checks and result filtering
  provider.js       search provider abstraction + relational (SQLite) provider
  query.js          runSearch, advanced, by-type, by-attributes, by-relationship, facets
  suggestions.js    autocomplete from history, titles and tags
  history.js        search history recording and clearing
  saved.js          saved search CRUD and execution
  exports.js        export requests, materialisation, retention
  metrics.js        search metrics and health
  hooks.js          index change emitters used by other modules
  jobs.js           background job handlers
server/services/search.js   facade
```

`server/platform.js` re-exports the stable in-process surface for other modules.

## 4. Indexing pipeline

1. A business write (create/update/status/delete/restore of an object,
   relationship or file) calls a hook such as `emitObjectIndexChange`.
2. The hook validates the tenant is search-enabled and writes a row into
   `search_index_status` (`upsert` or `delete`) via `enqueueIndexChange`. This is
   best-effort and never fails the business transaction.
3. The queue is drained by any of:
   - inline after the write (small, bounded batches),
   - the worker maintenance loop (`SEARCH_MAINTENANCE_MS`, default 30s),
   - a `SEARCH_INDEX` job,
   - an explicit admin drain.
4. For each change, the matching **source resolver** loads the system-of-record
   row and normalises it into a document. The indexer never reads module tables
   directly.
5. The document is upserted into `search_index`; deletes remove the row.

Full rebuilds use `reindexObject`, `reindexType`, `reindexTenant` or the
`SEARCH_REINDEX` job. Reindexing is idempotent.

## 5. Query model

`normalizeSearchQuery` accepts a uniform shape across GET and POST:

- `text` (alias `q`, `query`) — free-text query.
- `object_types`, `statuses`, `lifecycle_states`, `tags` — list filters.
- `owner_id`, `organization_id`, `date_from`, `date_to` — scoping filters.
- `filters[]` / `filters{}` — field/operator/value filters, including
  `attribute.<name>` for JSON attributes.
- `condition` — nested boolean condition tree (`and`/`or`/`not`) up to
  `CONDITION_DEPTH_MAX`.
- `relationship` / `related_to` — relationship-aware search.
- `sort` (`relevance`, `modified`, `created`, `title`, `type`, `owner`),
  `page`, `page_size`, `scope`, `highlight`, `include_facets`.

`runSearch` executes the configured provider, applies permission filtering,
scores and highlights results, records history and audit, and returns items with
`total`, `pages`, `took_ms`, applied `object_types` and optional `facets`.

Scores combine exact/prefix/substring title and code matches, tag matches, body
term frequency and recency.

## 6. Provider abstraction

The default `relationalProvider` compiles queries into SQLite SQL over
`search_index`. `registerSearchProvider` lets a deployment swap in an external
engine (for example a dedicated full-text service) without changing any caller:
the query service always resolves a provider by name.

`node:sqlite` ships JSON1 and FTS5, so attribute filters and full-text matching
work without extra services.

## 7. Permission-aware and tenant-aware search

- All queries are filtered by `tenant_id`.
- Each registered object type declares a `permission_resource` and
  `permission_action`. Before returning results, the framework re-checks that
  permission per result using the Object/Authorization services; unauthorized
  documents are dropped. Platform administrators bypass the per-type check.
- Scope (`tenant`, `organization`, `global`) further narrows results; the
  organization scope expands through descendant organizations, and the global
  scope requires platform administration.
- Cross-tenant references resolve as not found.

## 8. Events, jobs and audit

- Job types `SEARCH_INDEX`, `SEARCH_REINDEX` and `SEARCH_EXPORT` are registered
  in `server/services/jobs/types.js`; handlers live in `server/services/search/jobs.js`.
- The worker (`scripts/job-worker.js`) registers the search handlers and runs a
  maintenance interval that drains the index queue and expires exports.
- Indexing, reindexing, configuration changes, export requests and
  object-type registration are written to the platform audit trail.

## 9. REST surface

- `/api/search` — `GET`/`POST` global search; `GET /meta`
- `/api/search/advanced` — condition-tree advanced search
- `/api/search/by-type/:objectType` — search restricted to one type
- `/api/search/by-attributes` — attribute-driven search
- `/api/search/by-relationship` — relationship-aware search
- `/api/search/facets` — facet counts for a query
- `/api/search/suggestions` — autocomplete
- `/api/search/saved` — saved search CRUD and `/:reference/run`
- `/api/search/history` — list, clear, delete entries
- `/api/search/exports` — list/request exports, `/:reference/download`
- `/api/search/object-types` — registration and administration
- `/api/search/indexes` — `status`, `failures`, `retry`, `drain`, `reindex`,
  `reindex/:objectType/:objectId`, `prune`, `jobs`
- `/api/search/configuration` — per-tenant configuration
- `/api/search/metrics`, `/api/search/health` — telemetry

## 10. Console

- `/search` — search & discovery: query box with suggestions, type/tag filters,
  sort and scope, faceted results with highlights, saved searches, recent
  searches and exports.
- `/search/admin` — administration: index health and queue, object-type
  registration, configuration and telemetry.

Client code lives in `web/src/pages/SearchPage.jsx`,
`web/src/pages/SearchAdminPage.jsx` and the `search` namespace in
`web/src/api.js`.
