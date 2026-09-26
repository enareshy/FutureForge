# PDM Domain - Design

The PDM domain (`pdm`) is the platform's **product data management capability**.
It owns items and revisions, parts/products, datasets and content links,
representations, design data, CAD associations, revision rules, configuration
rules, baselines, relationships/references, product structure resolution,
where-used and where-referenced analysis, and configurable validation. It is a
**domain layer over the platform engines**, not a replacement for the generic
Object Model: PDM composes Object & Relationship, Lifecycle, Versioning,
Metadata, Search, Security, Workflow, Events, Files, Audit, Notifications and the
Job Scheduling & Execution Engine.

Source of truth: `server/services/pdm/`. Tables: `pdm_*` in `server/schema.sql`,
marker `035_pdm`. REST surface: `/api/pdm` and `/api/v1/pdm`.

## Why a domain layer

The platform ships a generic **Object & Relationship** framework, but a generic
object is not a PDM system: it does not model items with an item/revision
identity, part/product semantics, datasets and CAD associations, revision and
configuration rules, controlled baselines, or engineering structure resolution.
The PDM domain fills that gap once and exposes it everywhere by **composing**
existing engines rather than copying them.

| Concern | Object & Relationship (`objects`) | PDM domain (`pdm`) |
| --- | --- | --- |
| Purpose | Generic typed objects and links | Item/revision product data semantics |
| Identity | Object ids | Item numbers + item/revision refs |
| Lifecycle | Configurable states | Item and revision lifecycle with immutability |
| Content | Associations | Datasets, representations, design data, CAD links |
| Selection | Free-form queries | Revision rules + configuration rules |
| Controlled state | No | Immutable baselines and snapshots |
| Analysis | Network traversal | Structure resolve, where-used, where-referenced |

## Architectural rules

- **Compose, never duplicate.** PDM reuses the object & relationship framework,
  lifecycle/effectivity, versioning, classification, reference data, IAM, audit,
  domain events, the Job engine, Search and File/Content storage. It registers
  into those seams and adds no parallel platform engine.
- **Everything is data.** Item/revision statuses, dataset/representation/design
  data/CAD types, revision-rule and configuration-rule types, rule statuses,
  operators, baseline statuses, relationship types, validation rule types and
  severities, job types, event types, search object types, security actions,
  configuration defaults/bounds and IAM resources are declared in
  `constants.js`.
- **Deterministic identity.** An item is unique by `(tenant_id, item_number)`
  within a tenant; a revision is unique by `(item_id, revision_number)`. Refs are
  human-readable (`PDM-ITEM-*`, `PDM-REV-*`, `PDM-DS-*`, `PDM-BL-*`, ...).
- **Immutable artifacts.** Released revisions and released/frozen baselines are
  immutable in place; change means a new revision (`reviseRevision` clones
  metadata and re-points content).
- **Bounded traversal.** Structure resolution and where-used/where-referenced are
  depth-limited, node-capped and cycle-safe so a malformed graph cannot exhaust
  the process.
- **Versioned and auditable.** Every meaningful change writes to
  `pdm_change_history` (plus audit) and emits a domain event.

## Layering

| Layer | Files | Responsibility |
| --- | --- | --- |
| Contracts | `constants.js`, `errors.js`, `refs.js`, `sql.js`, `cache.js` | Vocabulary, standardized errors `{error, code?, details?}`, refs, SQL/cache helpers |
| Validation | `validation.js` | DTO normalization, vocabulary assertions, pagination |
| Persistence | `repository.js`, `configuration.js` | Public DTO mappers, per-tenant configuration |
| Cross-cutting | `events.js`, `history.js`, `security.js`, `bridge.js` | Domain events, change history/lineage, security decisions, object bridge |
| Domain | `items.js`, `revisions.js`, `datasets.js`, `representations.js`, `design-data.js`, `cad.js` | Core product data records |
| Rules & controlled state | `revision-rules.js`, `configuration-rules.js`, `baselines.js`, `relationships.js`, `references.js` | Revision/configuration selection, baselines, typed links |
| Analysis | `structure.js`, `where-used.js`, `where-referenced.js`, `validator.js` | Structure resolution, analysis, validation rules |
| Discovery & ops | `search.js`, `metrics.js`, `jobs.js` | Search registration, metrics/health, background handlers |
| Bootstrap | `foundation.js`, `seed.js` | Idempotent foundation, demo seed |
| HTTP | `router-pdm.js`, `index.js` | REST router and public facade/SDK |

## Data model

| Table | Purpose |
| --- | --- |
| `pdm_items` | Items (parts, products, assemblies, documents) with type, lifecycle, ownership |
| `pdm_item_revisions` | Item revisions with sequence, status, effectivity and configuration context |
| `pdm_datasets` | Datasets attached to items/revisions with type, status and content reference |
| `pdm_representations` | Derived representations (3D, 2D, thumbnail, lightweight, ...) |
| `pdm_design_data` | Design data records (CAD model, drawing, specification, ...) |
| `pdm_cad_associations` | CAD links between revisions and datasets with association type and primary flag |
| `pdm_revision_rules` / `pdm_revision_rule_versions` | Revision selection rules and immutable versions |
| `pdm_configuration_rules` / `pdm_configuration_rule_versions` | Configuration selection rules and immutable versions |
| `pdm_baselines` / `pdm_baseline_members` | Controlled baselines and their frozen members |
| `pdm_relationships` | Typed PDM relationships between items/revisions/objects |
| `pdm_references` | Reverse reference index for where-referenced |
| `pdm_validation_rules` | Per-tenant configurable rule definitions |
| `pdm_validation_results` / `pdm_validation_issues` | Validation runs and their issues |
| `pdm_change_history` | Audit trail and lineage |
| `pdm_configuration` | Per-tenant tuning |

Key uniqueness: `pdm_items` unique `(tenant_id, item_number)` when
`enforce_unique_item_number`; `pdm_item_revisions` unique
`(item_id, revision_number)` when `enforce_unique_revision_number`;
`pdm_datasets` unique `(tenant_id, dataset_number)`; `pdm_revision_rules` and
`pdm_configuration_rules` unique `(tenant_id, code)`; `pdm_baselines` unique
`(tenant_id, baseline_number)`; `pdm_validation_rules` unique
`(tenant_id, code)`.

## Items, revisions and immutability

Item status is `DRAFT → IN_WORK → RELEASED → OBSOLETE` (data-driven
`DEFAULT_ITEM_TRANSITIONS`). Revision status is
`DRAFT → IN_WORK → IN_REVIEW → RELEASED → OBSOLETE`
(`DEFAULT_REVISION_TRANSITIONS`). Releasing a revision promotes its parent item
to `RELEASED` and sets `current_revision_id`. `assertRevisionEditable` blocks
edits to released/obsolete revisions; `reviseRevision` creates a new draft with
the next suggested number and clones metadata, then re-points datasets and CAD
links.

## Rules, baselines and references

- **Revision rules** (`revision-rules.js`) resolve a revision for an item from a
  rule type (`LATEST_RELEASED`, `LATEST_WORKING`, `RELEASED_AS_OF`,
  `SPECIFIC_REVISION`, `HIGHEST_REVISION`, `BY_LIFECYCLE`, `CUSTOM`), an optional
  as-of date and configuration context. Versions are published immutably.
- **Configuration rules** (`configuration-rules.js`) evaluate declarative
  conditions (`EQUALS`, `NOT_EQUALS`, `IN`, `NOT_IN`, `EXISTS`, `GREATER_THAN`,
  `LESS_THAN`) combined with `ALL`/`ANY`, against a context, with immutable
  versions.
- **Baselines** (`baselines.js`) freeze members (`ITEM`, `REVISION`, `DATASET`,
  `OBJECT`) with level/path; release/freeze transitions are data-driven and
  released/frozen baselines reject mutation (`PDM_BASELINE_IMMUTABLE`).
- **Relationships and references** (`relationships.js`, `references.js`) store
  typed links and maintain the reverse reference index used by where-referenced.

## Analysis

- **Structure** (`structure.js`) resolves a product/assembly by walking
  `PRODUCT_HAS_PART` relationships, applying revision rules at every level, with
  quantity from link attributes. It returns nodes, edges, counts, depth and a
  `truncated` flag, and detects cycles.
- **Where-used** (`where-used.js`) walks parent relationships upward
  (`PRODUCT_HAS_PART`, `ITEM_DERIVED_FROM`, `PART_SUBSTITUTE`), reports
  immediate parents, top-level assemblies and external consumers from the
  reference index.
- **Where-referenced** (`where-referenced.js`) reads and groups the reverse
  reference index by category and can rebuild it from the relationship graph.
- **Validation** (`validator.js`) evaluates data-driven rules over ITEM,
  REVISION, DATASET and TENANT scopes, persists a result plus issues, and is
  configurable per tenant.

## Search, metrics, jobs, events, IAM and configuration

The domain registers search object types `pdm_item`, `pdm_revision`,
`pdm_dataset`, `pdm_representation`, `pdm_cad_association` and `pdm_baseline`.
`metrics.js` produces adoption totals, health checks and rule-usage statistics.

Handlers `pdm.structure.resolve|whereUsed|whereReferenced|baseline.create|validate|reindex|maintenance`
run on the shared Job Scheduling & Execution Engine under job types
`PDM_STRUCTURE_RESOLVE|PDM_WHERE_USED|PDM_WHERE_REFERENCED|PDM_BASELINE_CREATE|PDM_VALIDATE|PDM_REINDEX|PDM_MAINTENANCE`
on the `pdm`/`default` queues. Domain events (`PdmItemCreated`, `PdmItemUpdated`,
`PdmRevisionCreated`, `PdmRevisionReleased`, `PdmDatasetCreated`,
`PdmValidationCompleted`, `PdmWhereUsedRun`, ...) flow through the event
backbone.

IAM resources:
`iam.pdm.{overview,items,revisions,parts,products,datasets,representations,design-data,cad,revision-rules,configuration-rules,baselines,whereused,wherereferenced,structure,validation,search,audit,metrics,admin}`
with actions `read`, `create`, `update`, `delete`, `execute`.

Per-tenant configuration (`CONFIG_DEFAULTS`): `default_item_status`,
`default_revision_status`, `enforce_unique_item_number`,
`enforce_unique_revision_number`, `allow_manual_numbers`,
`auto_create_initial_revision`, `immutable_released_revisions`,
`baseline_immutable`, `allow_duplicate_cad_associations`,
`default_representation_type`, `revision_rule_default`,
`configuration_rule_default`, `max_structure_depth`, `max_traversal_nodes`,
`bulk_batch_size`, `max_bulk_objects`, `cache_ttl_seconds`,
`history_retention_days`, `search_page_size`.

## Demo seed

`seed.js` installs an idempotent demonstration: a product `DEMO-PUMP-ASSY`, four
parts with released `A1` revisions, `PRODUCT_HAS_PART` relationships, a CAD
dataset with content link, a representation, design data, a CAD association, an
active `DEMO-LATEST-RELEASED` revision rule, an active `DEMO-VARIANT`
configuration rule, a released baseline `DEMO-PUMP-BL-A` with members, and a
tenant validation run. `ensurePdmSeed` skips when it already exists.
