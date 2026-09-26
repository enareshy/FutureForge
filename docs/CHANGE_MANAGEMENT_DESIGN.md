# Change Management Domain - Design

The Change Management domain (`change`) is the platform's **engineering
change control capability**: Change Request (ECR) → Change Order (ECO) →
Change Notice (ECN). It owns request/order/notice identity and status, and is
a **domain layer over the platform engines**, not a replacement for them:
Change Management composes Numbering, the Effectivity & Versioning Kernel,
BOM (for impact discovery), Audit, Events and — for the change order's CCB
gate — Lifecycle and Workflow.

Source of truth: `server/services/change/`. Tables: `change_*` in
`server/schema.sql`, marker `036_change_management`. REST surface:
`/api/change` and `/api/v1/change`.

## Why a domain layer

`docs/WORKFLOW_ENGINE_DESIGN.md` and `docs/LIFECYCLE_DESIGN.md` both name
Change Management as an intended future consumer of the Workflow and
Lifecycle engines. Nothing about a CCB process is hard-coded here: the ECO's
approval gate reuses the exact same `approval_rules`/`approval_rule_steps`
tables the Lifecycle engine's own release-approval flow uses, and its release
fires the same `lifecycle.release.approved` event the Workflow engine's
`workflow_bindings` already listen for — the same mechanism proven by
`server/tests/workflow.test.js`'s "starts a bound workflow when a lifecycle
release is approved" test.

## Architectural rules

- **Compose, never duplicate.** Numbers come from the Numbering &
  Identifier Service (no hard-coded literals — every ECR/ECO/ECN number is
  generated through `nextNumber`). Effectivity/baselines on release come
  from the Versioning kernel's `versioning_effectivity_definitions`/
  `_assignments` and `versioning_baselines` (keyed by free-form
  `object_type`/`object_id`, so no new linking table is needed for arbitrary
  affected objects). Impact suggestions reuse BOM's
  `multiLevelWhereUsed`.
- **Deterministic identity.** Request/order/notice unique by
  `(tenant_id, *_number)`. Refs are human-readable prefixes: `CHG-ECR-*`,
  `CHG-ECO-*`, `CHG-ECN-*`.
- **Immutable once released/terminal.** A released ECO, and a
  rejected/withdrawn/promoted ECR, cannot be edited in place.
- **Versioned and auditable.** Every meaningful change writes
  `change_history` + the centralized Audit & History Framework, and emits a
  domain event.
- **Best-effort platform onboarding, never a hard dependency.** Change
  Order additionally attempts to onboard itself onto the generic Lifecycle +
  Approval engines (`lifecycle_type_assignments`, a real `approval_rules`
  row on its CCB transition) at foundation time — the first domain to
  actually exercise that path as designed; PDM itself still runs its own
  fallback state machine. That registration is wrapped in one guarded block:
  if it fails for any reason (for example, the platform-admin-only global
  metadata-type check), Change Order's own status-driven approve/release
  path is fully functional regardless, and boot is never blocked.

## Object model

| Object | Table | Notes |
| --- | --- | --- |
| Change Request (ECR) | `change_requests` | draft → submitted → screening → approved/rejected/withdrawn → promoted |
| Change Order (ECO) | `change_orders` | draft → in_review → approved/rejected → released/cancelled; carries `baseline_id` once released |
| Change Notice (ECN) | `change_notices` | draft → issued → acknowledged; requires its order to be RELEASED |
| Affected item | `change_affected_items` | generic `object_type`/`object_id` per change order; carries disposition + the resulting effectivity definition/assignment ids once released |
| Relationship | `change_relationships` | polymorphic edges: ECR→ECO (`PRODUCES_ORDER`), ECO→ECN (`PRODUCES_NOTICE`), ECO→affected object (`AFFECTS`) |

## The release integration

`Orders.releaseOrder` is the point that proves the composition: for every
affected item it calls the Versioning kernel's `createDefinition` (a
date-effective rule, effective from the release date) then `createAssignment`
(binding that rule to the affected object) — there is no single-call
shortcut in the kernel for this, so Change Management performs the same
two-step sequence any caller must. It then snapshots the whole affected set
into a `versioning_baselines` row and freezes it, the change's immutable
record of what was released. A per-item failure is recorded rather than
aborting the whole release; the baseline snapshot is itself best-effort (a
record of the release, not a gate on it).

## What's deliberately deferred

- A `provider-change.js` Digital Thread provider (so ECR/ECO/ECN show up in
  cross-domain traceability graphs alongside PDM/BOM nodes) — the contract
  is documented in `server/services/thread/providers.js`; not implemented
  in this pass.
- Registering a `workflow_bindings` row for the CCB gate at foundation time
  (auto-starting a review workflow instance on approval) — `decideOrder`
  already fires the `lifecycle.release.approved` event via `triggerEvent`,
  so once such a binding exists (created by an administrator, or in a later
  foundation pass), it activates with no code change.
- UI screens (`ChangeRequestsPage`, `ChangeOrdersPage`, `ChangeNoticesPage`)
  — this pass is REST-API-complete, mirroring how PDM was reviewed as a
  backend capability first.
- Background job handlers / dedicated search-object registration for
  ECR/ECO/ECN, mirroring PDM's `jobs.js`/`search.js` — not required for
  correctness, deferred as a fast-follow.

## APIs

- `/api/change/requests` — ECR CRUD, `/submit`, `/withdraw`, `/screen`
  (CCB decision), `/promote` (creates the linked ECO)
- `/api/change/orders` — ECO CRUD, `/submit`, `/decide` (CCB decision),
  `/release`, `/cancel`
- `/api/change/orders/:ref/affected-items` — add/list/remove affected items
- `/api/change/impact` — BOM-backed multi-level where-used impact suggestion
- `/api/change/notices` — ECN CRUD, `/issue`, `/acknowledge`
- `/api/change/relationships` — read/create/delete the polymorphic edges
- `/api/change/config`, `/api/change/health`, `/api/change/meta`,
  `/api/change/foundation/ensure`, `/api/change/seed`

Full REST surface: `docs/CHANGE_MANAGEMENT_API.md`.
