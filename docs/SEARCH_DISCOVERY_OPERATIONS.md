# Search & Discovery Operations

Day-2 guide for running the Search & Discovery Framework: configuration, worker
maintenance, indexing and reindexing, saved searches, exports, access control,
telemetry and troubleshooting. Design and internals are in
`docs/SEARCH_DISCOVERY_DESIGN.md`.

## 1. Where to find it

| Page | Route | Audience |
| --- | --- | --- |
| Search & Discovery | `/search` | all users |
| Search administration | `/search/admin` | administrators |

Required permissions are grouped under the `iam.search.*` resources: `global`,
`advanced`, `saved`, `history`, `indexes`, `configuration` and `export`. Seeded
reader and administrator roles receive the appropriate grants on first start.

## 2. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARCH_MAINTENANCE_MS` | `30000` | Worker search maintenance interval (drain queue, expire exports) |
| `SEARCH_EXPORT_RETENTION_DAYS` | `7` | How long completed exports remain downloadable |

Runtime behaviour is configured per tenant through
`/api/search/configuration` (or the administration console):

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the tenant |
| `default_scope` | `tenant` | `tenant`, `organization` or `global` |
| `page_size` | `20` | Default page size |
| `max_results` | `500` | Maximum candidates considered per query |
| `min_query_length` | `2` | Minimum query text length |
| `max_query_length` | `400` | Maximum query text length |
| `highlight` | `true` | Return `<mark>` highlights |
| `fuzzy` | `true` | Enable fuzzy matching |
| `index_files` | `true` | Index file documents |
| `history_retention_days` | `90` | Search history retention |
| `default_sort` | `relevance` | Default sort order |

Only enabled tenants are indexed and searchable. A tenant is enabled on
registration/seeding; disable a tenant to pause indexing without deleting data.

## 3. Running the worker

Index draining and export materialisation run in the job worker. The search
handlers are registered automatically; run at least one worker per environment:

```bash
# Start a worker (registers search handlers + maintenance interval)
npm run worker
```

On the `SEARCH_MAINTENANCE_MS` interval the worker:

- drains pending `search_index_status` changes with backoff for failures;
- expires search exports past their retention window.

Pull the queue manually when needed:

```bash
curl -s -X POST http://localhost:3001/api/search/indexes/drain \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

## 4. Indexing and reindexing

Object, relationship and file writes enqueue changes automatically through the
`search_index_status` queue. Useful administrative operations (all under
`/api/search/indexes`):

```bash
# Queue + index status and per-type counts
curl -s http://localhost:3001/api/search/indexes/status -H "Authorization: Bearer $TOKEN"

# List permanent or retryable failures
curl -s http://localhost:3001/api/search/indexes/failures -H "Authorization: Bearer $TOKEN"

# Retry failed changes (include dead-letter with include_dead_letter=true)
curl -s -X POST http://localhost:3001/api/search/indexes/retry \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'

# Rebuild everything for the tenant
curl -s -X POST http://localhost:3001/api/search/indexes/reindex \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'

# Rebuild one type, or run asynchronously through the job engine
curl -s -X POST http://localhost:3001/api/search/indexes/reindex \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"object_type":"object","async":true}'

# Prune rows for objects that no longer exist
curl -s -X POST http://localhost:3001/api/search/indexes/prune \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

Reindexing is idempotent and safe to run during business hours; it reads from the
source resolvers, never mutating system-of-record data.

## 5. Registering a searchable type

Business modules register an object type and a source resolver in code. Operators
can also register or adjust types through `/api/search/object-types` (or the
administration console):

```bash
curl -s -X POST http://localhost:3001/api/search/object-types \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"object","name":"Business objects","source_module":"objects",
       "permission_resource":"iam.objects","permission_action":"read",
       "sensitivity":"internal"}'
```

Key fields: `code`, `name`, `source_module`, `source_table`, `key_column`,
`title_attribute`, `body_attributes`, `facet_attributes`, `filter_attributes`,
`permission_resource`, `permission_action`, `sensitivity` and `status`
(`active`/`disabled`). Disabling a type removes its results without deleting the
index rows; deleting it also removes its documents.

## 6. Searching

The console at `/search` provides the query box (with suggestions), type and tag
filters, sort, scope, facets, saved searches, recent searches and exports.
Programmatically:

```bash
# Global search
curl -s "http://localhost:3001/api/search?q=compressor&page_size=20" \
  -H "Authorization: Bearer $TOKEN"

# Advanced condition tree
curl -s -X POST http://localhost:3001/api/search/advanced \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"condition":{"operator":"and","filters":[
        {"field":"object_type","operator":"eq","value":"object"},
        {"field":"attribute.part.number","operator":"contains","value":"PC-"}]}}'
```

Filter on JSON attributes with the `attribute.` prefix; filter on indexed columns
(`object_type`, `status`, `owner_id`, `tags`, …) directly.

## 7. Saved searches, history and exports

- **Saved searches** (`/api/search/saved`) store a named query with a sharing
  scope (`private`, `organization`, `tenant`). Run one with
  `POST /api/search/saved/:reference/run`.
- **History** (`/api/search/history`) records each user's queries with result
  counts and durations. Clear all with `DELETE /api/search/history?all=true` or a
  single entry with `DELETE /api/search/history/:id`.
- **Exports** (`/api/search/exports`) run through the job engine. Request one
  with a format of `json` or `csv`, then download it once completed:

```bash
curl -s -X POST http://localhost:3001/api/search/exports \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Compressor report","format":"csv","query":{"text":"compressor"}}'

# After the worker completes the job
curl -s -o search.csv \
  "http://localhost:3001/api/search/exports/<uuid>/download" \
  -H "Authorization: Bearer $TOKEN"
```

Exports are retained for `SEARCH_EXPORT_RETENTION_DAYS` (default 7) and then
expire.

## 8. Monitoring

- **`/api/search/health`** — documents indexed, registered types, source
  resolvers, queue depth (pending/processing/failed/dead-letter/stale) and the
  last index time.
- **`/api/search/metrics`** — search volume and users, average duration,
  zero-result rate, top queries, strategy breakdown, saved-search counts and
  export status counts, plus the current index status.
- The administration console (`/search/admin`) surfaces the same data with
  queue operations and failure tables.

Watch these signals:

- **failed / dead_letter rising** — a source resolver or schema drift; inspect
  `/indexes/failures` and retry after the fix.
- **stale_pending > 0** — the queue is not being drained; check that a worker is
  running.
- **zero-result rate climbing** — check `min_query_length`, excluded types and
  whether recent writes are being indexed.

## 9. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Search returns nothing for new records | Queue not drained | Run a worker or `POST /indexes/drain`, then re-check status |
| A user cannot search at all | Missing `iam.search.global:read` grant (or an explicit deny) | Review role grants in `/authorization` |
| Results missing for one type | Type disabled, `sensitivity` too high, or no permission | Check `/api/search/object-types` and the type's `permission_resource` |
| Facets empty | `include_facets` not set, or all candidate rows filtered by permissions | Request facets explicitly and confirm the query |
| Export stuck `pending` | No worker running | Start a worker or execute the `SEARCH_EXPORT` job |
| Download returns 409/410 | Export not finished, or expired | Wait for the job, or request a new export |

## 10. Routine maintenance

- Run at least one `npm run worker` per environment at all times.
- After schema or source-resolver changes, run a full reindex for affected types.
- Periodically review `/api/search/indexes/failures` and dead letters.
- Adjust `max_results`, `page_size` and `history_retention_days` per tenant to
  match usage; keep `history_retention_days` aligned with your privacy policy.
