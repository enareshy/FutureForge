# Enterprise Search Foundation Design

The Enterprise Search Foundation is the canonical, provider-independent search
contract that every business module programs against. It extends the existing
Search & Discovery service (`docs/SEARCH_DISCOVERY_DESIGN.md`) with a stable
public query/result model, an explicit field catalogue, tenancy- and
effectivity-aware execution, pluggable ranking/semantic/effectivity extension
points and an event-driven index projection. Swapping the relational provider
for Elasticsearch, OpenSearch, Solr or Azure AI Search must not change a single
business module.

Related documents: `docs/SEARCH_DISCOVERY_DESIGN.md`,
`docs/SEARCH_DISCOVERY_OPERATIONS.md`, `docs/CONTENT_MANAGEMENT_DESIGN.md`,
`docs/VERSIONING_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`,
`docs/AUDIT_DESIGN.md`, `docs/JOB_EXECUTION_DESIGN.md` and the HTTP reference
`docs/SEARCH_FOUNDATION_API.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| Canonical query/result model, operators, parser | Search Foundation |
| Field catalogue, operator metadata, facets, suggestions | Search Foundation |
| Index projection, indexing queue, rebuild scopes | Search Foundation |
| Provider abstraction (relational / search engine) | Search Foundation |
| Ranking strategies, semantic providers, effectivity resolvers | Search Foundation extension points |
| Object types, relationships, lifecycle state | Metadata & Object Framework |
| Extracted document text | Content & File Management |
| Identity, permissions, tenant scoping | IAM / Authorization / Tenants |
| Async rebuild execution | Job Scheduling & Execution Engine |

Business modules register a searchable object type and a source resolver; they
never build a query language, call a provider directly or duplicate security
filtering.

## 2. Canonical model

A canonical `SearchQuery` is the only shape callers submit:

```
text            free text (parsed for field:value, wildcards, phrases, AND/OR/NOT)
objectTypes     restrict to registered object types
filters         [{ field, operator, value }]
condition       nested { operator: and|or|not, filters[], conditions[] }
facets          field names to aggregate
sort            [{ field, direction: ASC|DESC }]
page / pageSize 1-based page, clamped by PAGE_LIMITS (default 25, max 200)
scope           tenant | organization | site | global
highlight       include highlight fragments
effectivity     { asOfDate, serialNumber, plant, unit, model, variant, ... }
relationship    relationship-aware constraint
```

Supported operators (initially executable): `EQ`, `NE`, `GT`, `GTE`, `LT`,
`LTE`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `WILDCARD`, `IN`, `NOT_IN`,
`IS_NULL`, `IS_NOT_NULL`, `BETWEEN`. The architecture-ready operators `AND`,
`OR`, `NOT`, `EXISTS`, `RANGE`, `RELATIONSHIP` and `FULL_TEXT` are represented
in the model so the execution engine can adopt them without a public contract
change.

A canonical `SearchResult` always carries `results`, `facets`, `total`,
`page`, `pageSize`, `pages`, `tookMs`, `objectTypes`, `sort`, `strategy`,
`scope`, `disabled` and `provider`. Each result item exposes a stable shape
(`objectType`, `objectId`, `title`, `code`, `description`, `status`,
`lifecycleState`, `classification`, `tags`, `attributes`, `highlight`,
`score`, `matchedFields`, timestamps).

The model is defined in `server/services/search/canonical.js`. Internal engine
vocabulary (snake_case columns, lowercase operators) is never exposed; the
adapter translates canonical → internal in `toInternalQuery`.

## 3. Field catalogue

`server/services/search/fields.js` derives a per-tenant, per-object-type field
catalogue from the object-type registration when explicit definitions are
absent, and merges `search_field_definitions` rows when present. Each field
declares `dataType`, `searchable`, `filterable`, `sortable`, `facetable`,
`fullText`, `exactMatch`, `wildcard` and the operators allowed for its data
type. `validateCanonicalQuery` rejects unknown fields, unsupported operators
and predicates against non-filterable fields before execution, returning the
matching `SEARCH_*` code.

## 4. Security and effectivity

Filtering order is fixed and non-negotiable:

1. Resolve the tenant and available object types.
2. Validate the canonical query against the field catalogue.
3. Apply tenant / organization / site / scope / lifecycle / owner / role /
   group / object-permission predicates.
4. Apply the effectivity resolver (as-of date, plant, model, serial number).
5. Rank the authorised rows.
6. Aggregate facets, counts and suggestions **from the authorised result set**
   so counts never leak the existence of records a caller cannot see.

No caller may request an object type outside its tenant. `search.objects`,
`search.facets`, `search.suggestions` and `search.count` all run through the
same authorisation filter.

## 5. Indexing

Indexing is a projection, never a system of record. Business writes call
`emitObjectIndexChange`, which enqueues a durable change into
`search_index_status`; the worker drains the queue into `search_index`.
Documents move through `Pending`, `Indexed`, `Failed`, `Retrying` and `Dead
Letter` states with exponential backoff. Deletes purge the projection row and
any extracted text.

Rebuild scopes: `full` (tenant), `object_type`, `organization`, `object` and
incremental. Synchronous rebuilds return counts; asynchronous rebuilds submit a
`SEARCH_REINDEX` job through the Job Execution Engine and return `202`.

## 6. Provider abstraction

`server/services/search/provider.js` owns a provider registry. The built-in
`relational` provider (also registered as `sqlite`) translates canonical
queries into parameterised SQL. A provider must implement the lifecycle
methods (`assertSearchProvider`): `search`, `count`, `upsertDocument`,
`deleteDocument`, `reindex`, plus health/status. Provider selection is a
configuration concern (`search_provider_configuration`); no module branches on
provider name, and no SQLite syntax appears in the canonical contract.

## 7. Extension points

`server/services/search/extensions.js` defines three pluggable registries:

- **Ranking strategies** — `registerRankingStrategy`, default `text` and
  `recency`; `rankRows` runs after effectivity.
- **Semantic providers** — `registerSemanticSearchProvider` for a future
  vector/neural backend; the default installation reports none rather than
  fabricating AI results.
- **Effectivity resolvers** — `registerEffectivityResolver`; the default
  resolver reads effectivity attributes from the index document and delegates
  to the shared versioning contract. Search never re-implements effectivity.

## 8. Full-text contract

Binary payloads are never indexed. Content & File Management extracts text and
calls `putExtractedText`; the foundation stores it in `search_extracted_text`
and merges it into the search document as the `_text` body field. This keeps
document search provider-independent and keeps extraction concerns in the
content module.

## 9. Data model

Schema additions (migration marker `026_search_foundation`, after
`025_content_management`):

| Table | Purpose |
| --- | --- |
| `search_field_definitions` | Explicit canonical field definitions per tenant/object type |
| `search_provider_configuration` | Active provider and provider options per tenant |
| `search_extracted_text` | Extracted document text keyed by object and content id |

`search_object_types` gains `index_name`, `identifier_field`, `searchable_fields_json`,
`sortable_fields_json`, `facetable_fields_json`, `display_fields_json`,
`relationship_fields_json`, `security_policy` and `indexing_strategy`;
`search_index` gains `site_id` and `external_reference`. All additions are
additive so pre-existing registrations keep working.

## 10. Error codes

Every failure surfaces one of the stable codes in
`server/services/search/errors.js`: `SEARCH_INVALID_QUERY`,
`SEARCH_INVALID_FIELD`, `SEARCH_INVALID_OPERATOR`,
`SEARCH_UNSUPPORTED_OPERATOR`, `SEARCH_OBJECT_TYPE_NOT_FOUND`,
`SEARCH_FIELD_NOT_SEARCHABLE`, `SEARCH_FIELD_NOT_FILTERABLE`,
`SEARCH_FIELD_NOT_SORTABLE`, `SEARCH_FIELD_NOT_FACETABLE`,
`SEARCH_QUERY_TOO_COMPLEX`, `SEARCH_WILDCARD_TOO_BROAD`, `SEARCH_TIMEOUT`,
`SEARCH_PROVIDER_UNAVAILABLE`, `SEARCH_INDEX_NOT_FOUND`,
`SEARCH_INDEXING_FAILED`, `SEARCH_REBUILD_IN_PROGRESS`,
`SEARCH_SAVED_SEARCH_NOT_FOUND`, `SEARCH_SAVED_SEARCH_ACCESS_DENIED`,
`SEARCH_UNAUTHORIZED` and `SEARCH_TENANT_ACCESS_DENIED`. The platform error
handler serialises `{ error, code, details }`.

## 11. Console

The canonical surface is exercised by the **Enterprise search** console at
`/search/foundation` (component `web/src/pages/SearchFoundationPage.jsx`):
keyword search with suggestions, structured filters with explicit operators,
AND/OR grouping, effectivity context, facets, saved searches, recent searches
and an index-administration drawer (status, rebuild scopes, retry failures and
extracted-text ingestion).
