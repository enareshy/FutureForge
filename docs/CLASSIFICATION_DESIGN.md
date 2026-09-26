# Enterprise Classification Framework — Design

The Enterprise Classification Framework (`classification`) is the platform's
**single, centralized classification engine**. It owns classification
hierarchies, classes, characteristics, characteristic groups, allowed values,
units, inheritance, object assignment, validation, search facets, duplicate
signals and adoption metrics. PDM, BOM, Documents, Manufacturing, Quality,
Supplier and Product modules **consume** classification through this service;
they never embed their own classification logic and never store a second copy of
classification data.

Source of truth: `server/services/classification/`. Tables: `cla_*` in
`server/schema.sql`, marker `033_classification_framework`. REST surface:
`/api/classification` and `/api/v1/classification`.

## Why a platform service

The platform already has Metadata (attribute definitions and LOVs) and Reference
Data (governed lists and units), but neither is a classification engine: neither
models a class hierarchy, inheritance, an effective characteristic contract per
class, or assigns a semantic class to an arbitrary object. Classification fills
that gap once and exposes it everywhere.

| Concern | Metadata (`metadata`) | Reference Data (`reference`) | Classification (`classification`) |
| --- | --- | --- | --- |
| Purpose | Attribute & LOV definitions | Governed master lists | Semantic class hierarchy |
| Hierarchy | No | No | Classes with materialized path/level |
| Inheritance | No | No | Effective characteristic contract |
| Assignment | No | No | Class assigned to any object |
| Validation | Shape only | Domain only | Full value contract per class |
| Units | No | Owns `UNIT_OF_MEASURE` | Consumes it, never duplicates it |

Classification reuses IAM, Data Security, audit, domain events, the Job
Scheduling & Execution Engine, Search & Discovery, File Storage, the object &
relationship framework, the metadata engine, Reference Data/UOM and the Data
Governance duplicate engine.

## Architectural rules

- **Everything is data.** Statuses, data types, origins, allowed-value modes,
  rule types, assignment statuses, job types, event types, search object types,
  configuration defaults/bounds and IAM resources are declared in
  `constants.js`. No tree, characteristic or allowed value is hard-coded.
- **One validation contract.** Every consumer calls the same
  `validateClassValues` / `validateAssignmentValues` / `validateObject` before
  save, release, import or migration, so meaning is identical everywhere.
- **Deterministic single-parent inheritance.** A class inherits its ancestors'
  characteristics; a local definition of the same characteristic overrides the
  inherited one. Every resolved entry records `origin`
  (`INHERITED` / `LOCAL` / `OVERRIDDEN`) and its source class.
- **Multiple classification, optional single-class policy.** An object may be
  classified against several classes simultaneously unless the tenant config
  `allow_multiple_classification` is false.
- **No unit master of its own.** Units live solely in the Reference Data
  `UNIT_OF_MEASURE` domain; classification registers the catalogue idempotently
  and converts using the unit metadata stored on those governed items.
- **Never trust the client.** The server always resolves the effective
  definition; bounds, type, allowed values, units and reference integrity are
  re-checked server-side.
- **Versioned and auditable.** Definitions are versioned; every meaningful change
  writes to `cla_change_history` and emits a domain event.

## Layering

| Layer | Files | Responsibility |
| --- | --- | --- |
| Contracts | `constants.js`, `errors.js`, `refs.js`, `validation.js` | Vocabulary, standardized errors `{error, code?, details?}`, refs, normalization, coercion, `orderClause` |
| Persistence | `repository.js`, `sql.js`, `cache.js`, `configuration.js` | Public DTO mappers, query helpers, per-tenant cache and configuration |
| Cross-cutting | `events.js`, `history.js`, `security.js` | Domain events, change history/lineage, security decisions |
| Domain | `definitions.js`, `hierarchy.js`, `characteristics.js`, `inheritance.js` | Classifications, classes, characteristics/groups/allowed values, effective contracts |
| Application | `assignments.js`, `rules.js`, `validation-service.js` | Object assignment, class rules, the reusable validation contract |
| Discovery & ops | `search.js`, `duplicates.js`, `metrics.js`, `units.js` | Search registration, duplicate signals, metrics/health/coverage, UOM integration |
| Jobs & bootstrap | `jobs.js`, `foundation.js`, `seed.js` | Background handlers, job types, idempotent foundation, demo seed |
| HTTP | `router-classification.js`, `index.js` | REST router and public facade/SDK |

## Data model

| Table | Purpose |
| --- | --- |
| `cla_classifications` / `cla_classification_versions` | Classification definitions and immutable version snapshots |
| `cla_classes` / `cla_class_versions` | Class hierarchy nodes with materialized `path` and `level`, plus versions |
| `cla_characteristics` / `cla_characteristic_versions` | Reusable characteristic definitions (type, unit, bounds, precision) |
| `cla_characteristic_groups` / `cla_characteristic_group_members` | Reusable sets of characteristics |
| `cla_class_characteristics` | The contract of a class: which characteristics, required, sequence, allowed-value mode |
| `cla_allowed_values` | Enumerated values per characteristic |
| `cla_assignments` / `cla_assignment_values` | Object → class assignment and its characteristic values |
| `cla_rules` | Class-scoped rules (`REQUIRED`, `RANGE`, `ENUM`, `REGEX`, `MULTI_VALUE`, `UNIT`, `REFERENCE`) |
| `cla_change_history` | Audit trail and lineage for every entity |
| `cla_configuration` | Per-tenant tuning |

Key uniqueness: `cla_classes` unique `(tenant_id, classification_id, code)`;
`cla_assignments` unique `(tenant_id, object_type, object_id, class_id)`.

## Hierarchy & inheritance

`hierarchy.js` maintains a single-parent hierarchy with materialized `path`
(e.g. `MECH/ROTATING/PUMP`) and integer `level`. It supports create/read/update,
`moveClass` (cycle-safe), `reorderClasses`, `copyClass`, `deleteClass` (only when
empty), `classTree`, `classChildren`, `classAncestors` and `classDescendants`.
Depth is bounded by the tenant's `max_hierarchy_depth`.

`inheritance.js` walks the ancestor chain root-first and merges each
characteristic with a deterministic precedence: the local definition wins over
the inherited one, and the resolved entry records where it came from. Allowed
value modes are `INHERIT`, `EXTEND` and `RESTRICT`;
`validateAllowedValueModes` ensures a local restriction is a subset of the
inherited set so meaning can never drift silently.

## Characteristics, units and validation

A characteristic declares a `data_type` — `STRING`, `INTEGER`, `DECIMAL`,
`BOOLEAN`, `DATE`, `DATETIME`, `ENUMERATION`, `REFERENCE` or `UNIT_NUMERIC` —
plus optional bounds, precision/scale, multi-valued flag, default and unit.
`UNIT_NUMERIC` and `REFERENCE` carry their own requirements (a unit and a
`reference_type` respectively). New types are added as data in `constants.js`
plus a validator in `validation.js`; the model never changes.

Units come from the shared Reference Data `UNIT_OF_MEASURE` domain. Values are
coerced to the canonical representation and, for unit numerics, normalized to the
characteristic's base unit for search and duplicate comparison. Unit conversion
rejects incompatible unit classes.

`validateClassValues` produces one result with `valid`, `errors`, `warnings`,
`missing_required`, `invalid_values`, `unit_errors` and per-characteristic
`items`, and folds in class rules. It never throws for validation issues; the
assignment layer turns a non-valid result into a `422` with stable codes.

## Assignment

`assignments.js` links a class to any platform object
(`object_type` + `object_id` — part, document, supplier, process, product, ...).
It supports assign, list, read, set values, set status (`ACTIVE` / `INACTIVE` /
`OBSOLETE`), reclassify and unassign. A duplicate `(object, class)` is a `409`;
inactive definitions cannot be assigned; the single-class policy is enforced per
object type. Other modules read `objectClassifications`, `resolveObjectValues`
and `effectiveCharacteristicsForObject`.

## Rules

Rules are data (`rule_type` + `config`) evaluated by the validation service:
`REQUIRED`, `RANGE`, `ENUM`, `REGEX`, `MULTI_VALUE`, `UNIT`, `REFERENCE`, with
severities `ERROR` / `WARNING` / `INFO`. `EXPRESSION` is intentionally
unsupported and surfaced as informational rather than executed.

## Search, duplicates, metrics

Classification registers three search object types — `classification`,
`classification_class`, `classification_assignment` — through the registered
Search & Discovery sources and exposes facets derived from the vocabulary.

The deterministic `classification_signature` strategy is registered into the
shared Data Governance duplicate engine; `detectClassificationDuplicates` also
offers a classification-scoped scan that needs no data catalog, grouping exact
signatures and scoring near matches above `duplicate_similarity_threshold`.

`metrics.js` produces an adoption snapshot (totals, per-status counts,
classified objects, coverage, assignments missing required values) plus health
checks and a coverage report.

## Jobs, events, IAM and configuration

Handlers `classification.bulkAssign|bulkValidate|duplicateScan|maintenance` run
on the shared engine under job types
`CLASSIFICATION_BULK_ASSIGN|BULK_VALIDATE|DUPLICATE_SCAN|MAINTENANCE`. Domain
events (`ClassificationCreated`, `ClassCreated`, `CharacteristicCreated`,
`ClassificationAssigned`, `ClassificationUnassigned`,
`ClassificationValuesUpdated`, `ClassificationValidated`,
`ClassificationDuplicateDetected`, `ClassificationBulkCompleted`, ...) flow
through the event backbone.

IAM resources:
`iam.classification.{overview,classifications,classes,characteristics,groups,values,
assignments,validation,search,governance,migration,audit,metrics,admin}` with
actions `read`, `create`, `update`, `delete`, `execute`.

Per-tenant configuration (defaults in `CONFIG_DEFAULTS`, bounds in
`CONFIG_BOUNDS`): `default_class_status`, `allow_obsolete_assignment`,
`require_effective_date`, `enforce_reference_integrity`,
`allow_multiple_classification`, `allow_multi_value`, `enforce_units`,
`auto_normalize_units`, `max_hierarchy_depth`, `max_allowed_values`,
`bulk_batch_size`, `max_bulk_objects`, `duplicate_similarity_threshold`,
`duplicate_scan_limit`, `cache_ttl_seconds`, `history_retention_days`.

## Demo seed

`seed.js` installs an idempotent `MECH_COMPONENTS` demonstration: the
`MECH → ROTATING → PUMP` hierarchy, eight characteristics (including
`MATERIAL`, `FLOW_RATE`, `PRESSURE`), allowed material values, an inherited
required contract, a pressure `RANGE` rule and a classified `product`
`DEMO-PUMP-001`. `ensureClassificationSeed` skips when it already exists.
