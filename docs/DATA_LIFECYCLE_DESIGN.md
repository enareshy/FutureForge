# Data Lifecycle & Archival — Design

The Data Lifecycle & Archival service is the platform's single, centralized owner
of business-data lifecycle state, retention, archiving, restore, recovery, purge,
legal holds and data tiering. Business modules register the objects they own with
this service and receive lifecycle decisions from it; they do **not** build their
own archival engines.

It is deliberately separate from two other, similarly named capabilities:

- **Audit Retention** (`services/audit.js`) — retention of audit/history records.
  Audit retention is *not* business-data retention and is never repurposed here.
- **Lifecycle kernel** (`services/lifecycle.js`, `/lifecycles`) — the configurable
  status/state-machine kernel used for workflow-facing object statuses. The
  Data Lifecycle service is a distinct subsystem with a `lc_` schema prefix.

## Lifecycle states

The default model is installed per tenant and is a **row**, not a hard-coded
branch, so tenants can extend it:

```
ACTIVE ──DEACTIVATE──▶ INACTIVE ──ARCHIVE──▶ ARCHIVED ──COLD_STORAGE──▶ COLD_STORAGE ──PURGE──▶ PURGED
   ◀──REACTIVATE──────────   ◀──RESTORE──────────   ◀──RESTORE──────────
```

Each state carries a capability matrix (`read_allowed`, `update_allowed`,
`delete_allowed`, `restore_allowed`, `export_allowed`, `archive_eligible`,
`purge_eligible`) and a logical data tier. Transitions are guarded: only edges in
the tenant's transition graph are permitted, and `PURGED` is reachable only
through the purge workflow (never a direct state change).

## Retention policies

A policy is scoped (`OBJECT`, `OBJECT_TYPE`, `ORGANIZATION`, `TENANT`, `PLATFORM`)
and resolves deterministically — most specific first, then priority — so no
retention period, object type or organization is hard-coded. A policy defines:

- `retention_period_days` and an extensible `retention_basis` (created,
  last-modified, last-accessed, release, completion, lifecycle-transition,
  business-event date).
- `archive_after_days`, `cold_storage_after_days`, `purge_after_days`.
- Stage actions (`NONE`, `MARK_ELIGIBLE`, `AUTOMATIC`).
- Target `data_tier`.
- Effectivity window and priority.

`computeRetentionSchedule(anchor, policy, config)` turns an anchor date plus a
policy into `archive_eligible_at`, `cold_storage_at` and `purge_eligible_at`,
persisted on the object ledger.

## Explainable eligibility

`evaluateEligibility` is the decision engine used by every operation and by the
policy simulator. It never returns a bare boolean: it returns a `result`
(`SAFE`, `WARNING`, `REQUIRES_REVIEW`, `BLOCKED`) plus a list of reasons with
severities. Checks, in order:

1. State reachability (tenant transition graph).
2. Retention window (has the stage date elapsed?).
3. Legal holds (always win).
4. Dependencies (blocking live dependants).
5. Optional quality gate (Data Governance/Quality integration — configurable).
6. Policy stage action (`NONE` blocks).
7. Purge prerequisites (an archive must exist when configured).

## Legal holds

A legal hold is a first-class record that suspends archive, purge and deletion
for everything it covers. Holds are scoped explicitly (`OBJECT`, `OBJECT_SET`) or
by rule (`OBJECT_TYPE`, `ORGANIZATION`, `PLANT`, `CLASSIFICATION`,
`BUSINESS_DOMAIN`) so millions of ids are never materialised. A hold blocks any
transition that is not a return to `ACTIVE`, and it always overrides purge
eligibility. Holds may be released, cancelled or auto-expired by maintenance.

## Archive, restore and recovery

- **Archive** builds a self-describing package (identifier, object type/id/ref,
  version, relationships, business metadata, classification, lifecycle and
  retention info, checksum, archive timestamp, original storage reference and
  schema version), stores it through a pluggable provider and records an
  `lc_archive_records` row. File archiving *orchestrates* the shared File Storage
  service rather than duplicating file storage.
- **Restore** brings archived/cold data back to active storage, verifying the
  archive checksum first and honouring a conflict strategy (`FAIL`, `SKIP`,
  `RENAME`, `OVERWRITE_IF_UNCHANGED`).
- **Recovery** is a distinct capability for recovering data after a failure,
  corruption or storage loss. It is a framework plus a basic workflow; physical
  disaster-recovery infrastructure is out of scope.

Archive and recovery providers are pluggable. The built-in `database` provider
stores payloads in `lc_archive_blobs` (development/small deployments); the
`file-storage` provider delegates to the platform File Storage facade. The
provider is chosen per tenant through configuration.

## Data tiering

Logical tiers (`HOT`, `WARM`, `ARCHIVE`, `COLD`) are policy decisions, distinct
from physical storage. A tenant maps each lifecycle state to a tier via
`lc_tier_policies`; `resolveTier` consults that mapping before the platform
default. Tier follows state on transition, and objects expose their tier
independently of state.

## Platform integration

The service reuses the platform's shared seams and never duplicates them:

| Capability | Integration |
| --- | --- |
| IAM | `iam.data_lifecycle.*` permission resources and `SECURITY_ACTIONS` |
| Audit | every state change, policy change, archive, restore, purge, hold and config change |
| Events | `Lifecycle*`/`Object*` domain event types; subscribes to object/relationship events |
| Notifications | archive/restore/purge/hold notifications through the shared service |
| Jobs | seven `LIFECYCLE_*` job types handled by the shared execution engine |
| Search | lifecycle-aware registrations so archived state is searchable |
| File Storage | archive payload storage and file archiving orchestration |
| Object & Relationship Framework | relationships and dependencies for the archive manifest and dependency checks |
| Data Governance / Quality | optional configurable archive/purge quality gate |
| Data Catalog | lifecycle fields exposed through `lifecycleSnapshot` without duplication |

## Configuration

All bounds are tenant configuration (`lc_configuration`) with platform defaults:
default retention/days, default tier, archive-eligible state, cold-storage and
purge offsets, batch size, legal-hold auto-expiry, quality-gate settings,
provider selection and whether purge requires an archive. Nothing here is a
compile-time business rule.

## Resilience

`ensureLifecycleFoundation` and the seed are idempotent and wrapped so a failure
can never block application boot. The job worker registers lifecycle handlers and
runs a periodic maintenance sweep (expire holds, converge retention dates,
verify archive integrity).
