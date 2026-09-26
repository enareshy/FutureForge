# Data Catalog & Business Glossary API

All routes require a bearer token and the permission listed against them. The
catalog is available under both `/api/data-catalog` and `/api/v1/data-catalog`;
the glossary under both `/api/glossary` and `/api/v1/glossary`. Responses are
JSON; list endpoints return `{ items, total, page, page_size }`. Errors use
`{ error, code?, details? }`.

Permission resource codes are `iam.data_catalog.*` (overview, objects,
attributes, glossary, terms, sources, consumers, mappings, lineage,
relationships, classifications, ownership, import_export, admin, jobs, metrics)
and are granted through IAM roles.

## Vocabulary, metrics and health

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/data-catalog/meta` | `iam.data_catalog.overview:read` | Catalog vocabs: statuses, entry types, source/consumer/mapping/lineage/ownership types, classifications, importable resources |
| GET | `/api/v1/data-catalog/health` | `iam.data_catalog.metrics:read` | Tenant-scoped counts (entries, terms, objects, attributes, sources, consumers, lineage, classifications) |
| GET | `/api/v1/data-catalog/metrics` | `iam.data_catalog.metrics:read` | Catalog counters, governance rollup and per-type breakdown |
| GET | `/api/v1/glossary/meta` | `iam.data_catalog.glossary:read` | Glossary vocabs (term statuses, approval statuses, definition/synonym/relationship/target types) and approval workflow code |
| GET | `/api/v1/glossary/metrics` | `iam.data_catalog.metrics:read` | Shared catalog counters |

## Unified registry

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/entries` | `iam.data_catalog.overview:read` |
| GET | `/api/v1/data-catalog/entries/:ref` | `iam.data_catalog.overview:read` |
| GET | `/api/v1/data-catalog/entries/:ref/versions` | `iam.data_catalog.overview:read` |
| POST | `/api/v1/data-catalog/entries/:ref/status` | `iam.data_catalog.admin:execute` |

`/entries` filters with `entry_type`, `status`, `classification`, `domain_id`,
`q`, `page` and `page_size`. Every cataloged item is one entry with an
`entry_ref` (for example `DC-OBJECT-CUSTOMER`, `DC-TERM-CUSTOMER_ORDER`).

## Data objects and attributes

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/objects` | `iam.data_catalog.objects:read` |
| GET | `/api/v1/data-catalog/objects/:ref` | `iam.data_catalog.objects:read` |
| POST | `/api/v1/data-catalog/objects` | `iam.data_catalog.objects:create` |
| PUT/PATCH | `/api/v1/data-catalog/objects/:ref` | `iam.data_catalog.objects:update` |
| POST | `/api/v1/data-catalog/objects/:ref/status` | `iam.data_catalog.objects:execute` |
| GET | `/api/v1/data-catalog/objects/:ref/attributes` | `iam.data_catalog.attributes:read` |
| POST | `/api/v1/data-catalog/objects/:ref/attributes` | `iam.data_catalog.attributes:create` |
| GET | `/api/v1/data-catalog/attributes/:ref` | `iam.data_catalog.attributes:read` |
| PUT/PATCH | `/api/v1/data-catalog/attributes/:ref` | `iam.data_catalog.attributes:update` |
| POST | `/api/v1/data-catalog/attributes/:ref/status` | `iam.data_catalog.attributes:execute` |

Object create body: `{ object_type, display_name?, description?, domain_id?, source_id?, classification?, status?, owner_user_id?, steward_user_id? }`.
Attribute create body: `{ attribute_name, display_name?, data_type?, mandatory?, business_definition?, classification? }`.

## Data sources

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/sources` | `iam.data_catalog.sources:read` |
| GET | `/api/v1/data-catalog/sources/:ref` | `iam.data_catalog.sources:read` |
| POST | `/api/v1/data-catalog/sources` | `iam.data_catalog.sources:create` |
| PUT/PATCH | `/api/v1/data-catalog/sources/:ref` | `iam.data_catalog.sources:update` |
| POST | `/api/v1/data-catalog/sources/:ref/status` | `iam.data_catalog.sources:execute` |
| GET | `/api/v1/data-catalog/sources/:ref/mappings` | `iam.data_catalog.mappings:read` |
| POST | `/api/v1/data-catalog/sources/:ref/mappings` | `iam.data_catalog.mappings:create` |
| PUT/PATCH | `/api/v1/data-catalog/source-mappings/:id` | `iam.data_catalog.mappings:update` |
| DELETE | `/api/v1/data-catalog/source-mappings/:id` | `iam.data_catalog.mappings:delete` |

Source create body: `{ code, name, source_type, connection_reference?, system_ref?, description? }`.
`connection_reference` is metadata only: URLs and connection strings are rejected.

## Data consumers

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/consumers` | `iam.data_catalog.consumers:read` |
| GET | `/api/v1/data-catalog/consumers/:ref` | `iam.data_catalog.consumers:read` |
| POST | `/api/v1/data-catalog/consumers` | `iam.data_catalog.consumers:create` |
| PUT/PATCH | `/api/v1/data-catalog/consumers/:ref` | `iam.data_catalog.consumers:update` |
| POST | `/api/v1/data-catalog/consumers/:ref/status` | `iam.data_catalog.consumers:execute` |
| GET | `/api/v1/data-catalog/consumers/:ref/mappings` | `iam.data_catalog.mappings:read` |
| POST | `/api/v1/data-catalog/consumers/:ref/mappings` | `iam.data_catalog.mappings:create` |
| PUT/PATCH | `/api/v1/data-catalog/consumer-mappings/:id` | `iam.data_catalog.mappings:update` |
| DELETE | `/api/v1/data-catalog/consumer-mappings/:id` | `iam.data_catalog.mappings:delete` |

Consumer create body: `{ code, name, consumer_type, description?, owner? }`.
Mapping body: `{ object_id | object_ref, attribute_id? | attribute_ref?, purpose?, frequency?, status? }`.

## Lineage

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/lineage` | `iam.data_catalog.lineage:read` |
| GET | `/api/v1/data-catalog/lineage/graph` | `iam.data_catalog.lineage:read` |
| GET | `/api/v1/data-catalog/lineage/impact` | `iam.data_catalog.lineage:read` |
| GET | `/api/v1/data-catalog/lineage/:id` | `iam.data_catalog.lineage:read` |
| POST | `/api/v1/data-catalog/lineage` | `iam.data_catalog.lineage:create` |
| PUT/PATCH | `/api/v1/data-catalog/lineage/:id` | `iam.data_catalog.lineage:update` |
| DELETE | `/api/v1/data-catalog/lineage/:id` | `iam.data_catalog.lineage:delete` |
| POST | `/api/v1/data-catalog/lineage/maintenance` | `iam.data_catalog.jobs:execute` |

Create body: `{ from_type, from_id, to_type, to_id, relationship_type?, transformation_reference?, job_ref? }`.
`/lineage/graph?root_type=&root_id=&direction=upstream|downstream|both&max_depth=&max_nodes=`
returns a bounded node/edge sub-graph; `/lineage/impact` walks downstream within
the same bounds.

## Relationships

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/relationship-types` | `iam.data_catalog.relationships:read` |
| POST | `/api/v1/data-catalog/relationship-types` | `iam.data_catalog.relationships:create` |
| PUT/PATCH | `/api/v1/data-catalog/relationship-types/:ref` | `iam.data_catalog.relationships:update` |
| GET | `/api/v1/data-catalog/relationships` | `iam.data_catalog.relationships:read` |
| POST | `/api/v1/data-catalog/relationships` | `iam.data_catalog.relationships:create` |
| PUT/PATCH | `/api/v1/data-catalog/relationships/:id` | `iam.data_catalog.relationships:update` |
| DELETE | `/api/v1/data-catalog/relationships/:id` | `iam.data_catalog.relationships:delete` |

## Classifications

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/classifications` | `iam.data_catalog.classifications:read` |
| POST | `/api/v1/data-catalog/classifications` | `iam.data_catalog.classifications:create` |
| PUT/PATCH | `/api/v1/data-catalog/classifications/:ref` | `iam.data_catalog.classifications:update` |
| POST | `/api/v1/data-catalog/classifications/:ref/status` | `iam.data_catalog.classifications:execute` |
| GET | `/api/v1/data-catalog/classification-assignments` | `iam.data_catalog.classifications:read` |

Create body: `{ code, name?, category?, security_classification?, rank?, description? }`.
Assigning a classification sets the entry's effective classification to the
highest-ranked assignment.

## Ownership & stewardship

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/ownership` | `iam.data_catalog.ownership:read` |
| GET | `/api/v1/data-catalog/ownership/gaps` | `iam.data_catalog.ownership:read` |
| GET | `/api/v1/data-catalog/ownership/resolve` | `iam.data_catalog.ownership:read` |
| POST | `/api/v1/data-catalog/ownership` | `iam.data_catalog.ownership:create` |
| PUT/PATCH | `/api/v1/data-catalog/ownership/:id` | `iam.data_catalog.ownership:update` |
| DELETE | `/api/v1/data-catalog/ownership/:id` | `iam.data_catalog.ownership:delete` |

Create body: `{ entry_ref | entry_id, relationship, ownership_kind, subject_type, subject_id, scope?, priority? }`.
`/ownership/gaps` lists entries without an accountable owner;
`/ownership/resolve?entry_id=&relationship=` returns the effective assignment.

## Business glossary

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/glossary/terms` | `iam.data_catalog.terms:read` |
| GET | `/api/v1/glossary/terms/export` | `iam.data_catalog.terms:read` |
| GET | `/api/v1/glossary/terms/:ref` | `iam.data_catalog.terms:read` |
| POST | `/api/v1/glossary/terms` | `iam.data_catalog.terms:create` |
| PUT/PATCH | `/api/v1/glossary/terms/:ref` | `iam.data_catalog.terms:update` |
| POST | `/api/v1/glossary/terms/:ref/submit` | `iam.data_catalog.terms:execute` |
| POST | `/api/v1/glossary/terms/:ref/approve` | `iam.data_catalog.terms:execute` |
| POST | `/api/v1/glossary/terms/:ref/reject` | `iam.data_catalog.terms:execute` |
| POST | `/api/v1/glossary/terms/:ref/status` | `iam.data_catalog.terms:execute` |
| GET | `/api/v1/glossary/terms/:ref/definitions` | `iam.data_catalog.terms:read` |
| PUT | `/api/v1/glossary/terms/:ref/definitions/:type` | `iam.data_catalog.terms:update` |
| DELETE | `/api/v1/glossary/terms/:ref/definitions/:type` | `iam.data_catalog.terms:delete` |
| GET | `/api/v1/glossary/terms/:ref/synonyms` | `iam.data_catalog.terms:read` |
| POST | `/api/v1/glossary/terms/:ref/synonyms` | `iam.data_catalog.terms:update` |
| DELETE | `/api/v1/glossary/terms/:ref/synonyms/:synonym` | `iam.data_catalog.terms:delete` |
| GET | `/api/v1/glossary/terms/:ref/relations` | `iam.data_catalog.terms:read` |
| POST | `/api/v1/glossary/terms/:ref/relations` | `iam.data_catalog.terms:update` |
| DELETE | `/api/v1/glossary/term-relations/:id` | `iam.data_catalog.terms:delete` |
| GET | `/api/v1/glossary/terms/:ref/mappings` | `iam.data_catalog.terms:read` |
| POST | `/api/v1/glossary/terms/:ref/mappings` | `iam.data_catalog.terms:update` |
| DELETE | `/api/v1/glossary/term-mappings/:id` | `iam.data_catalog.terms:delete` |
| GET | `/api/v1/glossary/term-mappings?target_type=&target_id=` | `iam.data_catalog.terms:read` |

Term create body: `{ code, name, definition?, domain_id?, owner_user_id?, steward_user_id? }`.
Lifecycle: `draft → in_review → approved → active → deprecated → retired`
(guarded by the service state machine; review/approval starts a platform workflow
instance). Mapping body: `{ target_type, target_id | target_ref }` where the
target type is one of `OBJECT`, `ATTRIBUTE`, `DOMAIN`, `SOURCE`, `CONSUMER`.

## Configuration

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/configuration` | `iam.data_catalog.admin:read` |
| PUT | `/api/v1/data-catalog/configuration/:key` | `iam.data_catalog.admin:update` |

Keys: `lineage_max_depth`, `lineage_max_nodes`, `import_batch_size`,
`require_definition_for_approval`, `auto_publish_terms`.

## Import, export and jobs

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-catalog/import-runs` | `iam.data_catalog.import_export:read` |
| GET | `/api/v1/data-catalog/import-runs/:id` | `iam.data_catalog.import_export:read` |
| POST | `/api/v1/data-catalog/import` | `iam.data_catalog.import_export:create` |
| POST | `/api/v1/data-catalog/import/submit` | `iam.data_catalog.jobs:execute` |
| GET | `/api/v1/data-catalog/export` | `iam.data_catalog.import_export:read` |
| POST | `/api/v1/data-catalog/export/submit` | `iam.data_catalog.jobs:execute` |
| POST | `/api/v1/data-catalog/reindex` | `iam.data_catalog.jobs:execute` |

Import body: `{ resource_type, records? | content?, format?, dry_run?, transfer_ref? }`.
Resource types: `terms`, `objects`, `attributes`, `sources`, `consumers`,
`classifications`, `term_mappings`, `source_mappings`, `consumer_mappings`,
`lineage`. `/export?resources=sources,objects&format=json|csv` returns
`{ format, data, content, record_count, resources }`. Long-running imports,
exports, lineage maintenance and search reindexing run as platform background
jobs (`DATA_CATALOG_IMPORT`, `DATA_CATALOG_EXPORT`,
`DATA_CATALOG_LINEAGE_MAINTENANCE`, `DATA_CATALOG_REINDEX`).
