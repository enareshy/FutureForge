# BOM Engine - Design

The BOM Engine (`bom`) is the platform's **single, reusable bill-of-materials
capability**. It owns BOM headers, revisions, structure lines, quantity/UOM and
find numbers, substitutes, baselines, comparison, where-used, rollup,
transformation, validation and adoption metrics. PDM, Manufacturing, Quality and
Service modules **consume** the engine through this service; they never embed
their own BOM logic and never store a second copy of BOM data.

Source of truth: `server/services/bom/`. Tables: `bom_*` in `server/schema.sql`,
marker `034_bom_engine`. REST surface: `/api/bom` and `/api/v1/bom`.

## Why a platform service

The platform already ships a generic **Object & Relationship** framework and a
`bom`-ish generic object, but a generic object is not a BOM engine: it does not
model revisions with lifecycle, parent/child structure lines with explode
semantics, find numbers, substitutes, baselines, rollup, where-used or
engineering-to-manufacturing transformation. The BOM Engine fills that gap once
and exposes it everywhere by **composing** existing engines rather than copying
them.

| Concern | Object & Relationship (`objects`) | BOM Engine (`bom`) |
| --- | --- | --- |
| Purpose | Generic typed objects and links | Product structure semantics |
| Revisions | Versioning framework snapshots | BOM revisions with lifecycle + effectivity |
| Structure | Free-form relationships | Exploded tree with quantities/UOM/find numbers |
| Comparison | Object diff | BOM-aware line/recursive diff |
| Analysis | Network traversal | Rollup, where-used, uses |
| Baselines | No | Frozen, immutable structure snapshots |

## Architectural rules

- **Compose, never duplicate.** The engine reuses the object & relationship
  framework, lifecycles/effectivity, versioning, the classification and
  Reference Data `UNIT_OF_MEASURE` domain, IAM, audit, domain events, the Job
  Scheduling & Execution Engine, the Search & Discovery framework and File
  Storage. It registers into those seams and adds no parallel platform engine.
- **Everything is data.** BOM types, statuses, revision transitions, line
  statuses, usages, baseline statuses, transformation mapping types, validation
  rule types/severities, job types, event types, search object types, security
  actions, configuration defaults/bounds and IAM resources are declared in
  `constants.js`. No rule, mapping or transition is hard-coded.
- **Deterministic structure.** A line is uniquely identified within a revision by
  `(parent_object_id, child_object_id)` when duplicate children are disallowed;
  find numbers and sequences are data. The tree builder is cycle-safe and
  depth-bounded by `max_structure_depth`.
- **One quantity contract.** Quantity is always paired with a valid UOM from the
  shared `UNIT_OF_MEASURE` domain; `auto_normalize_units` normalizes to the
  tenant's `default_uom` when units are convertible and leaves incompatible
  quantities untouched while reporting them.
- **Immutable artifacts.** Released revisions and frozen baselines are immutable
  in place; change means a new revision (`REVISE` copies lines, substitutes and
  attributes into a fresh draft).
- **Versioned and auditable.** Every meaningful change writes to
  `bom_change_history` and emits a domain event.

## Layering

| Layer | Files | Responsibility |
| --- | --- | --- |
| Contracts | `constants.js`, `errors.js`, `refs.js`, `sql.js`, `cache.js` | Vocabulary, standardized errors `{error, code?, details?}`, refs, SQL/cache helpers |
| Validation & units | `validation.js`, `units.js` | DTO normalization/coercion/coercion guards, UOM integration |
| Persistence | `repository.js`, `configuration.js` | Public DTO mappers, per-tenant configuration |
| Cross-cutting | `events.js`, `history.js`, `security.js` | Domain events, change history/lineage, security decisions |
| Domain | `definitions.js`, `revisions.js`, `lines.js`, `structure.js`, `substitutes.js` | Headers, revisions, lines, tree, substitutes |
| Semantics | `effectivity.js`, `variants.js` | Date/serial/lot/change effectivity and variant/config applicability |
| Analysis | `where-used.js`, `rollup.js`, `compare.js`, `validator.js`, `baseline.js`, `transformation.js` | Where-used, rollup, comparison, validation rules, baselines, EBOM→MBOM |
| Discovery & ops | `search.js`, `metrics.js`, `jobs.js` | Search registration, metrics/health, background handlers |
| Bootstrap | `foundation.js`, `seed.js` | Idempotent foundation, demo seed |
| HTTP | `router-bom.js`, `index.js` | REST router and public facade/SDK |

## Data model

| Table | Purpose |
| --- | --- |
| `bom_headers` | BOM definition (type, status, owner object, organization) |
| `bom_revisions` | Lifecycle-aware revisions with effectivity and configuration context |
| `bom_lines` | Structure edges: parent/child, quantity/UOM, find number, sequence, designator, usage, optional, effectivity, variant |
| `bom_line_attributes` | Typed per-line attributes |
| `bom_substitutes` | Alternate parts per line/revision with priority and ratio |
| `bom_baselines` / `bom_baseline_lines` | Frozen immutable structure snapshots |
| `bom_transformation_definitions` / `bom_transformation_mappings` | Declarative transformation definitions and mappings |
| `bom_transformation_runs` | Transformation execution history and summary |
| `bom_validation_rules` | Per-tenant configurable rule definitions |
| `bom_validation_results` / `bom_validation_issues` | Validation runs and their issues |
| `bom_comparisons` / `bom_comparison_results` | Comparison runs and per-line diffs |
| `bom_change_history` | Audit trail and lineage |
| `bom_configuration` | Per-tenant tuning |

Key uniqueness: `bom_headers` unique `(tenant_id, bom_number)`;
`bom_revisions` unique `(bom_id, revision_number)`; `bom_baselines` unique
`(tenant_id, baseline_number)`; `bom_transformation_definitions` unique
`(tenant_id, code)`; `bom_validation_rules` unique `(tenant_id, code)`.

## Revisions and immutability

Revision status is `DRAFT → IN_REVIEW → RELEASED → SUPERSEDED → OBSOLETE` with
the data-driven `DEFAULT_REVISION_TRANSITIONS` map. `assertRevisionEditable`
blocks edits to released/superseded/obsolete revisions;
`assertRevisionOpenForLines` blocks line changes. `reviseRevision` creates a new
draft and deep-copies lines, substitutes and attributes. `setRevisionStatus`
validates the transition and emits `BomRevisionStatusChanged`/`...Released`.

Lines are validated on write: mandatory child (`require_child_object`), positive
quantity, UOM existence (`enforce_uom`), duplicate-child policy
(`allow_duplicate_children`), cycle blocking (`block_cycle`) and per-revision
line capacity (`max_lines_per_revision`).

## Structure, effectivity and variants

`structure.js` builds an adjacency map, resolves roots (owner-object scoped when
provided), produces a nested tree and a flattened list, detects cycles
(`BOM_CIRCULAR_STRUCTURE`) and enforces `max_structure_depth`
(`BOM_DEPTH_EXCEEDED`).

`effectivity.js` resolves date ranges, serial ranges, lot ranges and change
numbers as pure functions; `variants.js` resolves variant codes/options and
configuration context. Both are reused by structure filtering, rollup,
where-used, comparison and validation so meaning is identical everywhere.

## Analysis

- **Rollup** (`rollup.js`) walks the tree multiplying quantities, aggregates by
  object and usage, and supports optional/inactive/context filtering.
- **Where-used** (`where-used.js`) answers which revisions consume a component,
  with a cycle-safe multi-level walk and a component usage summary.
- **Compare** (`compare.js`) loads comparable lines for revisions or baselines,
  matches them by stable keys, diffs case-sensitively on request and persists a
  comparison with an added/removed/modified/unchanged summary.
- **Validation** (`validator.js`) evaluates configurable rules — `MISSING_CHILD`,
  `INVALID_QUANTITY`, `MISSING_UOM`, `INVALID_UOM`, `DUPLICATE_LINE`,
  `DUPLICATE_FIND_NUMBER`, `INVALID_SEQUENCE`, `CIRCULAR_STRUCTURE`,
  `INVALID_SUBSTITUTE`, `INVALID_EFFECTIVITY`, `INVALID_VARIANT`,
  `UNAUTHORIZED_CHILD`, `LIFECYCLE_INCOMPATIBILITY`,
  `MISSING_MANDATORY_ATTRIBUTE`, `CUSTOM` — with `PASS`/`WARNING`/`ERROR`
  severities, persists results/issues, and exposes `assertRevisionValid`.
- **Baselines** (`baseline.js`) freeze an immutable line snapshot; frozen
  baselines reject deletion (`BOM_BASELINE_IMMUTABLE`).
- **Transformation** (`transformation.js`) applies declarative mappings
  (`OBJECT`, `LINE`, `QUANTITY`, `ATTRIBUTE`, `CLASSIFICATION`, `RELATIONSHIP`,
  `CONSTANT`) either as `DRY_RUN` preview or as an `EXECUTE` that creates a target
  BOM/revision, persists a run and records warnings for unmapped lines.

## Search, metrics, jobs, events, IAM and configuration

The engine registers search object types `bom`, `bom_revision` and `bom_line`.
`metrics.js` produces adoption totals, quality signals (missing UOM/child, empty
revisions, duplicate find numbers, obsolete revisions with active lines), health
checks and a comparison summary.

Handlers `bom.rollup|whereUsed|transform|validate|compare|maintenance` run on the
shared Job Scheduling & Execution Engine under job types
`BOM_ROLLUP|BOM_WHERE_USED|BOM_TRANSFORM|BOM_VALIDATE|BOM_COMPARE|BOM_MAINTENANCE`
on the `bom`/`default` queues. Domain events (`BomCreated`, `BomUpdated`,
`BomRevisionCreated`, `BomRevisionRevised`, `BomRevisionReleased`,
`BomRevisionStatusChanged`, `BomLineAdded`, `BomLineUpdated`, ...,
`BomBulkCompleted`) flow through the event backbone.

IAM resources:
`iam.bom.{overview,boms,revisions,lines,structure,compare,whereused,rollup,
transformation,validation,baseline,search,audit,metrics,admin}` with actions
`read`, `create`, `update`, `delete`, `execute`.

Per-tenant configuration (`CONFIG_DEFAULTS`): `default_revision_status`,
`default_uom`, `enforce_uom`, `auto_normalize_units`, `require_child_object`,
`allow_duplicate_children`, `allow_optional_lines`, `allow_substitutes`,
`enforce_single_default_revision`, `block_cycle`, `max_structure_depth`,
`max_lines_per_revision`, `default_rollup_mode`, `rollup_include_optional`,
`compare_case_sensitive`, `bulk_batch_size`, `max_bulk_objects`,
`cache_ttl_seconds`, `history_retention_days`, `baseline_immutable`.

## Demo seed

`seed.js` installs an idempotent `DEMO-EBOM-PUMP` demonstration: a header, a
released revision `A1`, six design lines, a substitute, a frozen baseline, an
`EBOM_TO_MBOM_DEMO` transformation definition with mappings, and a validation
run. `ensureBomSeed` skips when it already exists.
