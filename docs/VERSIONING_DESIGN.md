# Effectivity & Versioning Kernel — Design

The Effectivity & Versioning Kernel is the platform's single source of truth for
"which revision/version applies" for any controlled object. PDM, BOM, MBOM, BOP,
Engineering Change, Manufacturing, Requirements, Documents and Product
Configuration all resolve effectivity through this one capability; no business
module owns revision state or invents its own effectivity rules. It reuses the
platform foundations rather than re-implementing them: the Background Job engine
runs expiry/maintenance sweeps, the Audit service records every mutation, the
Event & Messaging Framework publishes domain events through the transactional
outbox, and Search & Discovery indexes revisions, baselines and snapshots.

## Goals

- A single, deterministic as-of resolution engine over Date, Serial, Plant/Unit,
  Model, Variant, Revision and Configuration Context dimensions.
- Reusable, data-driven effectivity definitions and explicit assignments to
  concrete targets (object / revision / version).
- Configurable resolution precedence and ambiguity strategy (policy rows), never
  hard-coded business rules.
- A rich revision/version lifecycle with relationships (`supersedes`,
  `effective_after`, `effective_before`, `applicable_with`, `derived_from`).
- Immutable baselines and historical snapshots that stay reproducible after new
  revisions are created.
- Structured variant/option/rule modelling and configuration contexts.
- Full audit trail, domain events, metrics, dashboard and health endpoints.

## Architecture

```
                    ┌────────────────────────── UI (React) ──────────────────────────┐
                    │  Versioning console: overview · revisions · effectivities ·     │
                    │  resolve · policies · baselines · snapshots · variants ·        │
                    │  contexts                                                       │
                    └────────────────────────────┬───────────────────────────────────┘
                                                 │ /api/versioning, /api/v1/versioning
                    ┌────────────────────────────▼───────────────────────────────────┐
                    │ Express router (server/app.js) — auth + can("iam.versioning.*") │
                    └────────────────────────────┬───────────────────────────────────┘
                                                 │
   ┌────────────┬────────────┬──────────────┬───┴────────┬─────────────┬────────────────┐
   ▼            ▼            ▼              ▼            ▼             ▼                ▼
Revisions    Versions   Effectivities   Resolution   Policies     Baselines/         Variants/
 lifecycle    lifecycle  + assignments   Engine       precedence   Snapshots          Contexts
   │            │            │              │            │             │                │
   └────────────┴────────────┴──────┬───────┴────────────┴─────────────┴────────────────┘
                                    ▼
        Audit · Event outbox · Search index · Background jobs (SQLite, shared)

Business modules depend on the flat SDK in `server/services/versioning.js`
(`resolveEffectivity`, `resolveEffectivityBulk`, `validateEffectivity`,
`inspectEffectivity`, `Effectivity`, `ensureVersioningFoundation`,
`registerVersioningHandlers`, `runVersioningMaintenance`, `seedVersioning`) and
never touch the tables directly.
```

## Module layout

- `server/services/versioning.js` — public facade and flat SDK.
- `server/services/versioning/errors.js` — `VersioningError` and stable error codes.
- `server/services/versioning/validation.js` — enums, normalization, range/serial
  helpers, precedence, public projections.
- `server/services/versioning/refs.js` — opaque reference generation.
- `server/services/versioning/revisions.js` — revision CRUD, lifecycle,
  relationships, comparison, history.
- `server/services/versioning/versions.js` — version CRUD, lifecycle, comparison.
- `server/services/versioning/effectivities.js` — definitions, values,
  assignments, overlap/gap inspection.
- `server/services/versioning/variants.js` — variant/option/rule model and
  applicability evaluation.
- `server/services/versioning/contexts.js` — configuration contexts.
- `server/services/versioning/policies.js` — resolution policy administration.
- `server/services/versioning/baselines.js` — baseline capture/freeze/restore.
- `server/services/versioning/snapshots.js` — immutable snapshots/reconstruction.
- `server/services/versioning/engine.js` — `EffectivityResolver` orchestration.
- `server/services/versioning/resolution/context.js` — `ContextValidator`.
- `server/services/versioning/resolution/candidates.js` — `CandidateSelector` and
  batched dataset loading (no N+1).
- `server/services/versioning/resolution/conflicts.js` — `ConflictDetector`.
- `server/services/versioning/resolution/rule-engine.js` — `ResolutionRuleEngine`.
- `server/services/versioning/foundation.js` — effectivity-type catalogue and
  default policy bootstrap.
- `server/services/versioning/events.js` — event types.
- `server/services/versioning/search.js` — search source resolvers and indexing.
- `server/services/versioning/metrics.js` — metrics, health and dashboard.
- `server/services/versioning/jobs.js` — background handlers and maintenance.
- `server/services/versioning/seed.js` — idempotent demo data.

## Data model

- `versioning_revisions` — a controlled revision of an `(object_type, object_id)`,
  with monotonic `revision_sequence`, one default per object, lifecycle status and
  intrinsic effective dates.
- `versioning_versions` — versions inside a revision, with a single default.
- `versioning_effectivity_types` — the dimension catalogue (date, serial, plant,
  unit, site, organization, model, revision, variant, configuration).
- `versioning_effectivity_definitions` — reusable effectivity rules (ranges,
  values, priority, boundary, overlap policy).
- `versioning_effectivity_values` — included/excluded structured values.
- `versioning_effectivity_assignments` — binds a definition to an object,
  revision and/or version with a role and precedence.
- `versioning_revision_relationships` — typed edges between revisions.
- `versioning_variants` / `_variant_options` / `_variant_rules` — variant model.
- `versioning_configuration_contexts` — named, reusable context bundles.
- `versioning_resolution_policies` — precedence, boundary, ambiguity strategy,
  overlap tolerance and default fallback.
- `versioning_baselines` / `_baseline_objects` — captured sets of resolved
  object/revision pairs; frozen baselines are immutable.
- `versioning_snapshots` / `_snapshot_objects` — immutable historical captures
  with a content hash.
- `versioning_resolution_results` — one row per resolution for audit, metrics and
  replay.

## Resolution model

The engine validates the context, selects candidates, applies the policy
precedence, detects conflicts and returns a deterministic result with a status:

```
RESOLVED | AMBIGUOUS | NOT_FOUND | INVALID_CONTEXT | CONFLICT
```

Default precedence (the `CORE_PRECEDENCE`) is:

```
configuration > revision > serial > model > plant > unit > date > default
```

Within a dimension, the most specific candidates win. If two candidates cannot be
distinguished the engine returns `AMBIGUOUS`; if their ranged effectivity overlaps
where overlap is not permitted it returns `CONFLICT`. It never silently picks an
arbitrary revision. An empty context falls back to the object's default revision
(`DEFAULT_REVISION`); a discriminated context with no match returns `NOT_FOUND`.

## Effectivity rules

- Date effectivity supports inclusive/exclusive boundaries, open-ended ranges,
  inverted-range rejection and gap/overlap inspection.
- Serial effectivity supports numeric and alphanumeric ranges, open-ended ranges,
  boundary validation and overlap detection.
- Model/plant/unit/site/organization/variant effectivity use structured
  include/exclude values keyed by dimension.
- Overlap is prohibited only when two definitions of the same dimension are
  attached to the same target revision/version; overlap across different revisions
  is legitimate and surfaces as a resolution `CONFLICT`.

## Baselines and snapshots

A baseline resolves a set of objects as-of a context and stores the resulting
object/revision pairs. Freezing a baseline locks it; later revisions never change
a frozen baseline, and `restore` reproduces the captured pairs. A snapshot is a
point-in-time capture with a `content_hash`, immutable by construction, that can be
reconstructed or archived.

## Events, audit and search

Every revision/version/effectivity/variant/context/baseline/snapshot mutation
writes an audit record and emits a domain event (`RevisionCreated`,
`RevisionActivated`, `RevisionSuperseded`, `VersionCreated`, `VersionActivated`,
`EffectivityCreated`, `EffectivityChanged`, `EffectivityExpired`,
`BaselineCreated`, `BaselineFrozen`, `SnapshotCreated`, `VariantCreated`,
`ConfigurationContextCreated`, ...) through the transactional outbox. Revisions,
baselines and snapshots are registered as search sources.

## Related documents

- `docs/VERSIONING_API.md` — HTTP reference.
- `docs/VERSIONING_OPERATIONS.md` — day-2 operations and troubleshooting.
