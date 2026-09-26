# Migration & Onboarding Framework — Design

The Migration & Onboarding Framework (`migration`) is the platform's capability
for **one-time, controlled onboarding of large historical datasets** from legacy
systems (Teamcenter, legacy PLM, PDM, ERP, MES, databases and file
repositories) into the platform. It is deliberately separate from the general
Import & Export Framework, which stays the home for routine, recurring data
exchange.

Source of truth: `server/services/migration/`. Tables: `mig_*` in
`server/schema.sql`, migration marker `032_migration_onboarding`.

## Why a separate capability

| Concern | Import & Export (`data-exchange`) | Migration & Onboarding (`migration`) |
| --- | --- | --- |
| Shape of work | Recurring, small-to-medium batches | One-time, very large historical datasets |
| Unit of work | An import/export definition run | A **package** inside a **project** |
| Ordering | Independent runs | Dependency-aware, phased, topologically ordered |
| Recovery | Re-run the job | Checkpoints, pause/resume, retry failed records, replan |
| Assurance | Reconciliation | Full reconciliation + exception reports + lineage/audit |
| Scope | Routine exchange | Legacy onboarding with source adapters and identifier mapping |

Migration reuses the Import & Export **engines** (mapping, transformation,
lookup, validation, duplicate decision, merge), the object & relationship
framework, IAM, Data Security, audit, events, jobs, search, File Storage and the
Lifecycle/Data Quality/Catalog modules. It never re-implements them and never
stores a second copy of business data.

## Architectural rules

- **Pipeline, not a script.** Every run flows through the stages
  `PACKAGE → EXTRACT → MAP → TRANSFORM → VALIDATE → DEPENDENCY → EXECUTE →
  RECONCILE → AUDIT` (spec §2).
- **Everything is data.** Adapter types, statuses, duplicate/error/dependency
  strategies, reconciliation strategies, job types, event types and IAM resources
  are declared in `constants.js`. No source system, object type or endpoint is
  hard-coded into the engine.
- **No copy of business data.** Records flow straight through to the owning
  module via the object framework; only results, errors, checkpoints,
  identifier/relationship mappings and audit entries are stored.
- **No raw credentials.** Source configurations reference an opaque
  `credential_ref`; secrets are never persisted.
- **Immutable once active.** Definitions are versioned; a definition that is
  `ACTIVE` is changed by creating a new version, never edited in place.
- **Safe evaluation.** Expressions and templates use the shared safe evaluator
  (no `eval`, no `Function`).
- **Durable and resumable.** Long onboardings run as jobs on the shared Job
  Scheduling & Execution Engine, so they survive restarts and can be paused,
  resumed, retried and reconciled.

## Layering

| Layer | Files | Responsibility |
| --- | --- | --- |
| Contracts | `constants.js`, `errors.js`, `refs.js`, `validation.js` | Vocabulary, standardized errors `{error, code?, details?}`, refs, input guards |
| Persistence | `repository.js`, `configuration.js`, `sql.js` | Public row shapes, tenant configuration |
| Cross-cutting | `events.js`, `audit.js`, `security.js`, `search.js` | Domain events, migration audit/lineage, security decisions, search registration |
| Sources | `source-adapters/{registry,builtins,index}.js`, `source-configurations.js` | Pluggable adapter registry, 10 built-in adapter types, source configuration CRUD/test/discover |
| Domain | `projects.js`, `packages.js`, `definitions.js` | Projects, dependency-aware packages, versioned definitions and children |
| Planning | `dependencies.js`, `planning.js` | Dependency resolution, topological order, readiness, execution plans |
| Mapping | `identifier-mapping.js`, `relationships.js`, `files.js` | Source→target identifier maps, relationship migration, binary file migration |
| Execution | `execution.js`, `reconciliation.js`, `statistics.js` | Batch engine with checkpoints, per-object results, error queue, reconciliation, metrics |
| Jobs & bootstrap | `jobs.js`, `foundation.js`, `seed.js` | Background handlers, job types, foundation bootstrap, demo seed |
| HTTP | `router-migration.js`, `index.js` | REST surface mounted at `/api/migration` and `/api/v1/migration`; public facade |

## Source adapters

10 built-in adapter types: `DATABASE`, `FILE`, `REST`, `OBJECT_STORAGE`,
`LEGACY_TEAMCENTER`, `LEGACY_PLM`, `PDM`, `ERP`, `MES`, `CUSTOM`. Each declares
capabilities (`READ`, `STREAMING`, `INCREMENTAL`, `SCHEMA_DISCOVERY`,
`BINARY_FILES`, `PAGINATION`) and a settings schema, and implements

```
{ adapter_type, capabilities, settings_schema, testConnection, discoverSchema, extract }
```

The generic adapters understand `settings.records | content | table | url`.
Legacy and deployment-specific adapters are extension seams registered through
`registerSourceAdapter` — no engine change is needed. Extraction scopes are
`FULL`, `INCREMENTAL`, `DELTA`, `SUBSET` (spec §8).

## Projects, packages and definitions

- A **project** is a bounded onboarding effort (a source system and version, an
  owner, a scope). It moves through `DRAFT → PLANNED → READY → RUNNING →
  PAUSED → COMPLETED / PARTIALLY_COMPLETED / FAILED / CANCELLED / ARCHIVED`.
- A **package** (`mig_packages`) is the unit of work: one source object type → one
  target object type, with its own source, mappings, transformations, validation
  rules, dependency list, duplicate strategy and execution order. Packages are
  the independently resumable work items.
- A **definition** (`mig_definitions`) is a reusable, versioned policy: source
  and target object types, mappings, transformations, validation rules,
  duplicate key/strategy, batch size, retry policy, error policy and
  reconciliation policy. A package may override a definition; a package always
  wins at execution time (`resolveExecutionContract`).

## Dependencies & planning

A package declares dependency edges (`PACKAGE`, `OBJECT`, `RELATIONSHIP`,
`REFERENCE`, `FILE`, `EXTERNAL`) resolved by `dependencies.js`. The strategy is
`STRICT` (block until satisfied), `WARN` (record the gap but plan anyway) or
`IGNORE`. `topologicalOrder` produces a deterministic order and reports cycles;
`evaluatePackageReadiness` checks target type, mappings, source and dependencies;
`generatePlan` writes a versioned, approvable execution plan with per-package
steps and estimates (`planning.js`).

## Execution lifecycle

`execution.js` is the orchestration core. For each batch it:

1. resolves the source adapter and **extracts** records (with paging/streaming);
2. **maps** fields, **transforms** values and **validates** rules using the
   shared Import & Export engines;
3. enforces **Data Security** field policy (`authorizeRecord`,
   `enforceRecordFields`), the **lifecycle guard** and the **quality gate**;
4. resolves **duplicates** (`REJECT`, `SKIP`, `UPDATE`, `UPSERT`, `CREATE_NEW`,
   `MERGE`) and **dependencies**;
5. writes through the object & relationship framework, records identifier maps
   and migrates files;
6. writes a **checkpoint**, a per-object **result**, and structured **errors**
   (`ERROR_CATEGORIES` / `ERROR_TYPES` / `ERROR_STATUSES`).

Modes are `DRY_RUN`, `EXECUTE` and `VALIDATE`. Error strategies are `CONTINUE`,
`STOP_ON_ERROR` and `ROLLBACK_BATCH`. Jobs can be cancelled, paused, resumed and
retried; `retryMigrationJob` re-runs only the failed record numbers on a fresh
job so the original ledger stays immutable.

## Reconciliation, statistics and audit

`reconciliation.js` supports `COUNT`, `KEY`, `FIELD`, `SOURCE_TO_TARGET` and
`TARGET_TO_SOURCE`, produces a reconciliation record with variance and an
exception report (`SOURCE_MISSING`, `TARGET_MISSING`, `FIELD_MISMATCH`,
`DUPLICATE_TARGET`, `UNEXPECTED_TARGET`, `COUNT_VARIANCE`).
`statistics.js` records immutable per-run snapshots and aggregates an
operational metrics snapshot plus health checks. Every meaningful step writes to
`mig_audit` (with hash-chain support), and `objectLineage` reconstructs the
journey of a migrated target object.

## Jobs, events and reuse

Handlers `migration.execute|validate|reconcile|retryFailed|replan|maintenance`
are registered with the shared execution engine; job types are
`DATA_MIGRATION[_VALIDATE|_RECONCILE|_RETRY|_REPLAN|_MAINTENANCE]`. Domain events
(`MigrationStarted`, `MigrationCompleted`, `MigrationPartiallyCompleted`,
`MigrationFailed`, `MigrationCancelled`, `MigrationPaused`, `MigrationResumed`,
`MigrationCheckpointReached`, `MigrationReconciled`, `MigrationDependencyResolved`,
`MigrationIdentifierMapped`, `MigrationPackageCompleted`, `MigrationOperationFailed`)
flow through the platform event backbone. Projects, packages and jobs are
indexed as search object types (`migration_project`, `migration_package`,
`migration_job`).

## IAM resources

`iam.migration.{overview,projects,packages,definitions,sources,mapping,validation,
dependencies,planning,execution,reconciliation,identifiers,relationships,files,
audit,statistics,metrics,admin}` with actions `read`, `create`, `update`,
`execute`. Security actions are declared in `SECURITY_ACTIONS`
(`VIEW_PROJECT`, `MANAGE_PROJECT`, `MANAGE_PACKAGE`, `MANAGE_DEFINITION`,
`MANAGE_SOURCE`, `PLAN_MIGRATION`, `EXECUTE_MIGRATION`, `PAUSE_MIGRATION`,
`RETRY_MIGRATION`, `RECONCILE_MIGRATION`, `MANAGE_IDENTIFIER`, `VIEW_AUDIT`,
`VIEW_ERRORS`).

## Configuration

Per-tenant configuration (`mig_configuration`, defaults in `CONFIG_DEFAULTS` with
bounds in `CONFIG_BOUNDS`): `default_batch_size`, `max_batch_size`,
`default_duplicate_strategy`, `default_error_strategy`,
`default_dependency_strategy`, `default_reconciliation_strategy`, `default_mode`,
`preview_limit`, `checkpoint_interval`, `max_retry_attempts`, `retry_backoff_ms`,
`max_concurrent_packages`, `reconciliation_tolerance`, `lifecycle_guard_enabled`,
`blocked_lifecycle_states`, `quality_gate_enabled`, `quality_min_score`,
`migrate_files`, `file_storage_provider`, `adapter_timeout_seconds`,
`adapter_page_size`, `identifier_mapping_enabled`, `hash_chain_audit`.

## Demo seed

`seed.js` installs a small, realistic estate so the console is not empty on a
fresh install: source configuration `LEGACY_TC`, project `LEGACY_TC_ONBOARD`,
package `PART_MASTER` (target `product`) and active definition `PART_MASTER_DEF`,
plus a generated plan. The seed is idempotent (`ensureMigrationSeed` skips when
the project already exists).
