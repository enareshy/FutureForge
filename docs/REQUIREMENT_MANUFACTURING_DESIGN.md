# Requirement → Manufacturing Traceability — Design & Reuse Analysis

Prompt 5: Requirement → MBOM/BOP Manufacturing Traceability Layer.

This document is the mandatory pre-coding deliverable (spec §27). It records the
technology inventory, architecture/dependency analysis, existing object and
relationship mapping, the reuse/extend/create matrix, identified gaps and
assumptions, and the proposed component/API/event/security/test plan. No code is
written until this analysis is approved.

The guiding principle from the prompt: **do not create a parallel MBOM, BOP,
manufacturing object model, traceability engine or constraint engine.** This is a
composition layer over existing capabilities.

---

## 1. Technology Stack Inventory

| Concern | Existing implementation |
| --- | --- |
| Backend runtime | Node.js (ESM), Node v22 |
| Backend framework | Express 4 (`server/app.js`), custom `wrap`, routers mounted under `/api` + `/api/v1` |
| Persistence | PostgreSQL 15 via `pg` (no ORM). Sync access `server/db.js`; async twins `server/db-async.js` (per-request transaction via AsyncLocalStorage) |
| API conventions | JSON, `req.actor`, tenant via `tenantOf(req)`, `auth` / `authAsync`, `can` / `canAsync`, correlation + idempotency helpers |
| AuthN/AuthZ | Session auth middleware; IAM resource strings `iam.<module>.<action>` via `services/security`, `services/authorization`, `services/access` |
| Events | `event_outbox` + `event_subscriptions` + handlers (`services/events`), `services/events.js` |
| Background jobs | `services/jobs` (job type registry, handlers, queues, retries, dead-letter) |
| Search | `services/search` registry (per-module `SEARCH_OBJECT_TYPES`) |
| Audit | `services/audit.js` (+ `services/audit/`) |
| Lifecycle | `services/lifecycle/engine.js` (states, categories, transitions) |
| Object framework | `services/objects/` (`objects`, `object_relationships`, `relationship_types`, `object_references`, `object_versions`) over `metadata_types` |
| Versioning | `services/versioning`; PDM/BOM revision rules |
| Classification | `services/classification/` (classes, characteristics, allowed values, assignments, validation) |
| Reference / UOM | `services/reference`, `services/bom/units.js` |
| Numbering | `services/numbering` |
| Documents | `services/content` (`content`, `content_associations`) |
| Frontend | React 18 + Vite 6, `react-router-dom` 6, custom components/CSS (no UI kit, no graph library) |
| Testing | `node --test` (`server/tests/*.test.js`), helper `server/tests/` + `openTestDatabase()` |
| Config | `services/config.js` feature flags |

---

## 2. Architecture & Dependency Analysis

Layered, non-duplicating stack:

```
Requirements Manager  (system of record: requirements, requirement_relationships)
        │
Generic Traceability Engine  (services/traceability — composition over thread + objects; owns no tables)
        │
Digital Thread  (services/thread — provider-based graph: object, pdm, bom providers)
        │
Object & Relationship Framework  (services/objects — metadata_types, objects, object_relationships, relationship_types)
        │
Domain services: PDM │ BOM │ Classification │ Lifecycle │ Change │ Content │ IAM │ Audit │ Events │ Jobs
```

- `services/thread/provider-object.js` resolves **any** `metadata_types` code as a
  node and every `object_relationships` row as an edge. Object types are
  config-driven, not hard-coded.
- `services/thread/provider-bom.js` projects `bom_headers` / `bom_revisions` /
  `bom_lines` into the graph. `BOM_TYPE_DOMAIN` maps `EBOM/MBOM/BOP` to the
  matching thread domain; `BRIDGE_TYPES` already includes `operation` and
  `manufacturing-order`, so a BOM line whose `child_object_type='operation'`
  bridges a BOP to operation objects with no new provider.
- `services/traceability/` is a thin composition layer (`forward`, `backward`,
  `graph`, `findPaths`, `impactAnalysis`, `matrix`, `coverage`, `orphans`,
  `brokenLinks`, `health`), reusing the thread's IAM resources. It owns no
  tables, no event bus, no audit store.
- `services/requirement-pdm/` (Prompt 3+4) is the template for this Prompt 5
  layer: it stores requirement-category edges only in the existing
  `requirement_relationships` table, resolves PDM/BOM artifacts through their own
  facades, reuses `ThreadImpact`, and projects documents rather than copying them.

---

## 3. Existing Object / Relationship Mapping

| Concept | Owned by | Identity / node type | Notes |
| --- | --- | --- | --- |
| Requirement | `requirements` (+ `objects` mirror via `requirements.object_id`, type `requirement`) | `requirement` | Edges in `requirement_relationships` |
| Product / Item | `pdm_items` / `pdm_item_revisions` | `pdm_item`, `pdm_revision` | Object types `pdm_item`, `pdm_item_revision` |
| EBOM / MBOM / BOP | `bom_headers` / `bom_revisions` / `bom_lines` | `bom_header`, `bom_revision`; distinguished by `bom_headers.bom_type ∈ {EBOM,MBOM,BOP,OTHER}` | Lines carry `child_object_type`/`child_object_id`, quantity, uom, variant, configuration, effectivity |
| Operation | **not implemented** | thread `MANUFACTURING` domain expects object type `operation` | Gap |
| Work Center | **not implemented** | — | Gap |
| Manufacturing / CTQ characteristic | `classification` (`cla_characteristics`, `cla_assignments`) | characteristic + assignment to any `(object_type, object_id)` | Reuse target for §11/§12/§10 |
| Process constraint | none dedicated; classification characteristics + validation rules | — | Gap (limits) |
| Document / work instruction | `content` / `content_associations` | content projection | Reuse (Prompt 4 pattern) |
| Change | `change_requests` / `change_orders` / `change_notices` | `change_request`, `change_order`, `change_notice` | System of record |
| Generic links | `object_relationships` (typed, `relationship_types`) + `requirement_relationships` (requirement-scoped) | — | No second graph |

Thread semantic links already declared (`thread/constants.js TRACEABILITY_LINKS`)
but not all backed by registered `relationship_types`:
`ebom.transformed-to.mbom`, `mbom.realized-as.bop`, `bop.executed-in.manufacturing`,
`manufacturing.produces.quality`, ...

---

## 4. Reuse / Extend / Create Matrix

| Capability | Existing implementation | Action |
| --- | --- | --- |
| Requirement objects | `requirements` + `objects` mirror | REUSE |
| Product / Item / Revision | PDM | REUSE |
| EBOM / MBOM / BOP structures | BOM engine (`bom_type`) | REUSE |
| EBOM→MBOM transformation | `bom/transformation.js` (definitions, mappings, runs) | EXTEND (persist item provenance) |
| Operations | none as first-class object | CREATE (metadata type `operation` + generic objects) |
| Work Centers | none | CREATE (metadata type `work_center` + generic objects) |
| BOP / Process Plan | BOM `BOP` type + `bom_lines`→operation bridge | REUSE |
| Generic relationships | Object & Relationship Framework | REUSE |
| Traceability / matrix / coverage / impact | `services/traceability` + `services/thread` | REUSE (config-driven manufacturing rules) |
| Manufacturing & CTQ characteristics | Classification characteristics + assignments | REUSE (add CTQ designation) |
| Process constraints | Classification characteristics (+ rules) | REUSE/EXTEND (machine-readable limits) |
| Configuration / revision / effectivity | BOM variants/effectivity + lifecycle + versioning | REUSE |
| Change management | `services/change` (ECR/ECO/ECN) | REUSE |
| Documents | `content` projection | REUSE |
| Events / jobs / search | `event_outbox`, `services/jobs`, `services/search` | EXTEND (register manufacturing event/job/search types) |
| IAM / audit | `services/security`, `services/audit` | REUSE (new resource namespace) |
| UI | `web/src/pages/RequirementPdmPage.jsx`, `web/src/api.js` | EXTEND |

---

## 5. Identified Gaps, Assumptions and Constraints

**Gaps (must be documented before coding, per spec §2.3/§8/§13/§26):**

1. **No Operation object model.** The thread already reserves object type
   `operation` in the `MANUFACTURING` domain, and the BOM provider already treats
   `operation` as a bridge type, but no `metadata_types`/objects/list exists.
   *Smallest compatible extension:* register metadata type `operation` and model
   operations as generic objects; link via `object_relationships` and BOP lines.
2. **No Work Center object model.** *Smallest compatible extension:* register
   metadata type `work_center`; associate via
   `operation.performed-at.work_center` object relationships. No second
   assignment framework.
3. **No persistent EBOM→MBOM item provenance.** `bom_transformation_runs` stores
   aggregate counts only; the per-line `preview` is not persisted in `EXECUTE`
   mode, and `bom_revisions.object_id` exists but is never populated.
   *Smallest compatible extension:* extend `bom/transformation.js` (opt-in,
   backward-compatible) to persist mapped item provenance through the existing
   relationship framework (`ebom.transformed-to.mbom` edges between mapped child
   objects, with quantity/uom/revision/plant/config/effectivity in edge
   attributes). No second mapping store.
4. **No direct MBOM revision → BOP revision edge.** BOP is a BOM `bom_type`;
   process plans are not a separate object. *Smallest compatible extension:*
   represent MBOM↔BOP via BOP lines (`child_object_type='operation'`) plus
   `object_relationships` carrying the MBOM/BOP header+revision ids in the
   relationship attributes; register `mbom.realized-as.bop`. Do not invent a
   process-plan entity.
5. **No CTQ designation.** Classification characteristics have no CTQ flag.
   *Smallest compatible extension:* configurable CTQ designation on the
   classification class/characteristic (existing metadata), consumed by coverage
   rules. No parallel quality model.
6. **Process constraints lack machine-readable limits.** Classification
   characteristics provide data type, UOM, allowed values but not
   inclusive/exclusive numeric limits. *Smallest compatible extension:* store
   limits in the characteristic's existing `config_json`/metadata and validate
   through the classification validation pipeline (no new constraint engine).
7. **Requirement relationship vocabulary** (`requirements/constants.js
   RELATIONSHIP_TYPES`) lacks manufacturing semantics (`GOVERNED_BY`,
   `CONTROLLED_BY`). `ALLOCATED_TO`, `SATISFIED_BY`, `IMPLEMENTED_BY`,
   `REALIZED_BY`, `VERIFIED_BY` already exist. Add only the missing codes.
8. **No manufacturing allocation target types, IAM resources, event types,
   job types, search sources.** Register them in the established seams.
9. **`_revisions.object_id` unused for BOM** — do not rely on it; use the BOM
   provider (`bom_revision`) plus relationship attributes.

**Closure status (pre-Boundary-2):** all nine structural gaps above are closed
without adding a parallel model or engine:

- Gaps 1–2 — `operation` / `work_center` registered as metadata object types;
  created/listed/linked through `manufacturing-objects.js`
  (`createManufacturingObject`, `listManufacturingObjects`,
  `linkManufacturingObjects`), which are thin wrappers over the Object &
  Relationship Framework.
- Gap 3 — `bom/transformation.js` gained an opt-in, backward-compatible
  `persist_provenance` flag (default on) that writes
  `source_line_ref` / `source_object_id` / `source_object_type` into the target
  line's existing `attributes_json` in both sync and async `EXECUTE` paths. No
  second mapping store. Covered by `bom-services.test.js`.
- Gap 4 — MBOM↔BOP modeled through BOP lines + `object_relationships` and the
  registered `mbom.realized-as.bop` / `bop.executed-in.manufacturing` codes (the
  latter reconciled with the thread `TRACEABILITY_LINKS` vocabulary).
- Gaps 5–6 — CTQ designation and process-constraint limits are stored on the
  existing Classification characteristic (`cla_characteristics.metadata_json`
  plus its existing `min_value`/`max_value`/inclusive flags) via
  `characteristics.js` (`designateCtq`, `setCharacteristicLimits`,
  `characteristicConstraints`, `listCriticalCharacteristics`). No quality or
  constraint engine.
- Gap 7 — `requirements/constants.js` `RELATIONSHIP_TYPES` now includes
  `GOVERNED_BY` and `CONTROLLED_BY`.
- Gap 8 — allocation target types, IAM resources, event types, config keys and
  the manufacturing Digital Thread provider are registered in the established
  seams (Boundary 1).
- Gap 9 — BOM/PDM nodes are resolved through the existing `bom_revision` /
  `pdm_*` providers; manufacturing-only nodes (`characteristic`, `content`) are
  resolved through the single sanctioned `requirement-manufacturing` thread
  provider (`provider.js`), which projects `GOVERNED_BY` / `CONTROLLED_BY`
  forward, reverses allocation edges, and derives characteristic/content
  association edges from the existing `cla_assignments` / `content_associations`
  (no new association store). Covered by
  `requirement-manufacturing-traceability.test.js`.

**Assumptions:**

- The platform's existing DB is authoritative; this layer stores only links
  (in `requirement_relationships` / `object_relationships`), never copies of
  EBOM/MBOM/BOP/operation objects.
- Object types, relationship types, lifecycle states, coverage rules, CTQ rules
  and process rules are configuration data, not hard-coded.
- Sync twins are retained only for CLI/seeders/tests; routes use the async layer.

**Explicit non-goals (per prompt):** no new graph DB, no new messaging, no new
authorization/audit store, no second Change Management, no second traceability or
constraint engine, no full MBOM/BOP copies in Requirements Manager.

---

## 6. Proposed Component Changes

**New composition module** `server/services/requirement-manufacturing/`
(structured like `requirement-pdm/`, owns only links/config, reuses everything):

- `constants.js` — relationship codes, node types, IAM resources, event map,
  config keys, coverage/validation vocabularies.
- `foundation.js` — registers metadata types (`operation`, `work_center`),
  relationship types, event types, job types/handlers, search sources,
  security object types, per-tenant config. Idempotent on boot.
- `security.js` — IAM checks reusing `iam.requirement-manufacturing.*`.
- `events.js` — publish through `event_outbox`.
- `targets.js` — resolve manufacturing targets (product/EBOM/MBOM/BOP revisions
  via PDM/BOM facades; operation/work_center via objects; characteristics via
  classification) without copying.
- `allocations.js` — requirement→manufacturing allocation edges stored in
  `requirement_relationships` (extends the requirement-pdm allocation pattern).
- `transformation-trace.js` — reads EBOM→MBOM provenance (from the BOM
  transformation extension + relationship framework); unmapped/invalid detection.
- `bop-operations.js` — MBOM↔BOP↔operation navigation via BOM provider + edges.
- `characteristics.js` / `ctq.js` — reuse classification assignments; CTQ
  designation + coverage.
- `work-centers.js` — operation↔work-center association + reverse navigation.
- `matrix.js` / `coverage.js` / `impact.js` — thin projections over
  `Traceability.matrix` / `coverage` / `impactAnalysis` with configurable
  manufacturing rule sets.
- `router-requirement-manufacturing.js` — mounted `/api/...` (+ `/api/v1/...`).

**Extensions to existing modules:**

- `bom/transformation.js` — opt-in persist of mapped provenance + mapping read
  model (backward compatible; no behavior change when disabled).
- `requirements/constants.js` — add missing manufacturing cross-domain
  relationship codes.
- `objects/relationship-types` registration for manufacturing edge codes
  (via the new foundation, not by editing the framework).
- `web/src/api.js` (`requirementManufacturing` namespace) + a new
  `web/src/pages/RequirementManufacturingPage.jsx` workspace wired into the
  Engineering navigation and router.

**Not created:** no new tables for objects/links/audit/events; the layer adds
data rows only into existing registries and link tables.

---

## 7. API & Event Changes

Endpoints (conceptual, following existing routing/idempotency conventions):

- Forward: `GET /api/requirement-manufacturing/requirements/:ref/{traceability,mbom,bop,operations,work-centers,characteristics,ctq}`
- Reverse: `GET /api/requirement-manufacturing/{mbom,bop,operations,work-centers,ctq}/:ref/requirements`
- Allocations: `GET/POST/PATCH/DELETE .../allocations`, `.../allocations/:ref`
- EBOM→MBOM: `GET .../ebom/:ref/mbom-mappings`, `.../mbom/:ref/ebom-sources`
- Matrix/coverage: `GET .../matrix`, `.../coverage`, `.../gaps`
- Impact: `POST .../impact-analysis` (+ async job), `POST .../validate`
- Meta/health/config mirroring `requirement-pdm`.

Events (registered in `event_outbox`): `RequirementManufacturingTraceCreated`,
`EBOMMBOMMappingChanged`, `RequirementManufacturingImpactDetected`,
`ManufacturingTraceabilityGapDetected`, `ManufacturingTraceabilityValidationFailed`.

---

## 8. Security & Audit Design

- New IAM resource namespace `iam.requirement-manufacturing.*` registered through
  the existing security object-type seam; traversal results are filtered by
  object-level access using the existing security/access services.
- Tenant/org/site boundaries enforced via existing `tenantOf` + object security.
- Audit through `services/audit` for allocation, relationship, mapping,
  validation, impact and sync operations. No separate audit store.
- Errors use stable codes + safe messages + correlation id; transient failures
  reuse existing job retry/dead-letter, permanent validation/auth failures are
  not retried.

---

## 9. Test Plan

- Unit: allocation validation, target resolution, revision/config/effectivity
  compatibility, orphan/broken-link/cycle detection, idempotency.
- Integration: full chain Requirement → Product → EBOM → MBOM → BOP → Operation
  → Work Center, and reverse navigation, using real existing objects.
- Functional: allocation, EBOM→MBOM mapping, operation linkage, constraints,
  characteristics, CTQ coverage, work-center association, matrix/coverage/gaps.
- Events: idempotent processing, retry, failure visibility.
- Security: unauthorized linked objects are not exposed.
- Performance: large structures, deep chains, many-to-many, pagination bounds.
- Regression: existing Requirements/PDM/PLM/BOM/Classification/Traceability
  suites stay green.

---

## 10. Boundary Implementation Plan (report + approval after each)

1. **Boundary 1 — Foundation & registry:** module skeleton, metadata/relationship
   types, IAM/events/jobs/search registration, config, health/meta.
2. **Boundary 2 — Manufacturing allocation:** requirement→Product/EBOM/MBOM/BOP/
   Operation/Work Center/characteristic/CTQ/document allocations.
3. **Boundary 3 — EBOM→MBOM transformation trace:** extend BOM transformation to
   persist provenance; mapping read models; unmapped/invalid detection.
4. **Boundary 4 — BOP→Operation & work-center linkage:** BOP lines bridge,
   operation/work-center edges, process sequence.
5. **Boundary 5 — Characteristics, constraints, CTQ & coverage rules.**
6. **Boundary 6 — Traceability matrix, gaps, coverage, bidirectional navigation.**
7. **Boundary 7 — Change impact integration + events + audit.**
8. **Boundary 8 — Frontend workspace + docs + end-to-end acceptance test.**

Each boundary: implement, test, report, await approval before continuing.

### Progress

- **Boundary 1 — done.** Module `server/services/requirement-manufacturing/`,
  config/seed/app wiring, `GOVERNED_BY`/`CONTROLLED_BY` relationship types;
  `requirement-manufacturing-foundation.test.js` 12/12.
- **Gap closure — done.** `bom/transformation.js` opt-in provenance, CTQ/limits
  on `cla_characteristics`, manufacturing Digital Thread provider;
  `requirement-manufacturing-traceability.test.js` 6/6.
- **Boundary 2 — done.** Target resolution for all seven target kinds and
  allocation CRUD/batch/forward/reverse/coverage;
  `requirement-manufacturing-allocation.test.js` 7/7,
  `-allocation-api.test.js` 4/4.
- **Boundary 3 — done.** `transformation-trace.js` projects EBOM→MBOM mappings
  from the provenance already persisted by the BOM transformation engine (and
  explicit `ebom.transformed-to.mbom` object relationships), plus MBOM→EBOM
  sources, unmapped source-item / unlinked target-item detection, and
  missing-vs-invalid link distinction. No second mapping store. Reads are
  bounded, chunked and paginated (no N+1). Endpoints:
  `GET /api/requirement-manufacturing/ebom/{ref}/mbom-mappings`,
  `GET /api/requirement-manufacturing/mbom/{ref}/ebom-sources`,
  `GET /api/requirement-manufacturing/bom-revisions/{ref}/transformations`.
  `requirement-manufacturing-transformation.test.js` 7/7,
  `-transformation-api.test.js` 3/3.
- **Boundary 4 — done.** `process-linkage.js` links BOP→operation (BOP
  `bom_lines` with `child_object_type='operation'`, `sequence` as order),
  operation↔work-center (`operation.performed-at.work-center`), operation↔
  consumed part (`operation.consumes.part`), predecessor/successor edges
  (`operation.precedes.operation`), plus BOP↔MBOM navigation and process
  sequence / coverage validation. True sync + `*Async` twins throughout; reads
  bounded and paginated. Config gates `require_operation_work_center` /
  `require_mbom_bop_assignment`. Endpoints:
  `POST|GET /api/requirement-manufacturing/bop/{ref}/operations`,
  `GET /api/requirement-manufacturing/bop/{ref}/sequence`,
  `GET /api/requirement-manufacturing/bop/{ref}/coverage`,
  `GET /api/requirement-manufacturing/bop/{ref}/mboms`,
  `GET /api/requirement-manufacturing/mbom/{ref}/bops`,
  `GET /api/requirement-manufacturing/mbom/{ref}/process-coverage`,
  `POST|GET /api/requirement-manufacturing/operations/{ref}/work-centers`,
  `POST|GET /api/requirement-manufacturing/operations/{ref}/mbom-items`,
  `GET /api/requirement-manufacturing/operations/{ref}/predecessors`,
  `GET /api/requirement-manufacturing/work-centers/{ref}/operations`,
  `GET /api/requirement-manufacturing/mbom-items/{ref}/operations`.
  `requirement-manufacturing-process.test.js` 7/7,
  `-process-api.test.js` 3/3. Regression sweep 95/95 across 14 suites.
- **Boundary 5 — done.** `coverage.js` projects manufacturing characteristics,
  process constraints and CTQ coverage without a quality/constraint engine: an
  applicable characteristic/constraint is an existing Classification
  characteristic reached through its class assignment to the `operation` object
  (no second association store); CTQ designation and limits reuse the
  characteristic's own metadata/bounds. Provides operation characteristics /
  constraints, characteristic↔operation navigation, characteristic→requirement
  reverse navigation, requirement→CTQ forward trace, a configurable CTQ coverage
  report (CTQs without an upstream requirement or operation, and requirements
  missing an expected CTQ driven by `ctq_enabled` / `require_ctq_for_critical` /
  `ctq_criticality` / `coverage_rules`), and machine-readable constraint
  compatibility (units, precision, inclusive/exclusive bounds, missing values;
  inaccessible objects are never reported as confirmed missing). New
  tenant-scoped config key `requirement_manufacturing.ctq_criticality`. Endpoints:
  `GET /api/requirement-manufacturing/operations/{ref}/characteristics|constraints`,
  `GET /api/requirement-manufacturing/characteristics/{ref}/operations|requirements`,
  `POST /api/requirement-manufacturing/characteristics/{ref}/validate`,
  `GET /api/requirement-manufacturing/requirements/{ref}/ctq`,
  `GET /api/requirement-manufacturing/ctq/coverage`.
  `requirement-manufacturing-ctq.test.js` 8/8, `-ctq-api.test.js` 4/4.
  Regression sweep 157/157 across 18 suites.
- **Boundary 6 — done.** `matrix.js` is a projection layer, not a second
  traceability engine: it composes the existing allocation, EBOM→MBOM
  transformation, process-linkage and coverage readers, and delegates
  domain-level traversal/matrix to the Generic Traceability Engine
  (`Traceability.forward`/`backward`/`matrix`). Provides a paginated
  requirement→manufacturing matrix (columns: product, ebom, mbom, bop,
  operation, work_center, characteristic, ctq, document; per-row coverage status
  COVERED/PARTIAL/GAP/UNALLOCATED and rule results), a coverage aggregate
  (requirement coverage plus CTQ coverage), a gap report (requirement-level
  implementation/EBOM-MBOM/MBOM-BOP/CTQ gaps plus structure-level MBOM scans for
  unassigned BOPs and unmapped EBOM lines), and bidirectional navigation
  (requirement side plus every manufacturing node type; draft/inactive nodes
  included by default with an explicit opt-out). Gap rules are configuration-
  driven via `coverage_rules` (MUST→ERROR, SHOULD→WARNING) and never hard-code a
  universal notion of "complete"; a rule can be requested per call with
  `rules=...`. Endpoints: `GET /api/requirement-manufacturing/matrix`,
  `GET .../coverage`, `GET .../gaps`, `GET .../trace`, `GET .../trace/matrix`.
  `requirement-manufacturing-matrix.test.js` 8/8, `-matrix-api.test.js` 5/5.
  Regression sweep 179/179 across 36 suites.
- **Boundary 7 — done.** `impact.js` reuses the Digital Thread impact traversal
  (`thread/impact.js`) and only adds the manufacturing vocabulary — forward
  analysis from a requirement classifies the whole Product/EBOM/MBOM/BOP/
  Operation/Work-center/Characteristic/CTQ/Document/Change chain
  (`DIRECT`, `INDIRECT`, `CONFIGURATION`, `EFFECTIVITY`, `PROCESS`,
  `CHARACTERISTIC`, `CTQ`, `DOCUMENT`, `CHANGE`; most-specific-wins precedence),
  and reverse analysis starts from a manufacturing node, finds the requirements
  linked to it through their existing allocations and classifies each. Change
  Management remains the system of record; no second impact/change engine.
  `jobs.js` registers three job types on the shared Job Engine
  (`MANUFACTURING_IMPACT_ANALYSIS`, `MANUFACTURING_GAP_SWEEP`,
  `MANUFACTURING_NODE_IMPACT`) plus submit helpers (sync + `*Async`); the gap
  sweep publishes `ManufacturingTraceabilityGapDetected` /
  `ManufacturingTraceabilitySynchronized`. `subscriptions.js` subscribes to the
  manufacturing/PLM node lifecycle events (`BomRevision*`, `PdmRevision*`) and to
  the integration's own trace events, driving node-impact and requirement-scoped
  gap re-evaluation through the shared Event & Messaging Framework. Impact
  analysis, node changes and gap sweeps are audited through the platform Audit
  service; event/subscription codes use the validated `req-mfg` prefix. Endpoints:
  `POST /api/requirement-manufacturing/impact-analysis`,
  `GET .../requirements/{ref}/impact`, `POST .../node-impact`,
  `POST .../impact-analysis/jobs`, `GET .../requirements/{ref}/gaps`,
  `POST .../gaps/sweep`.
  `requirement-manufacturing-impact.test.js` 6/6,
  `-impact-api.test.js` 5/5. Regression sweep 317/317 across 41 suites.
- **Boundary 8 — done.** Frontend workspace + docs + end-to-end acceptance.
  - `web/src/api.js` — new `requirementManufacturing` namespace mirroring every
    mounted endpoint (meta/health/config/foundation, allocations + forward/reverse
    coverage, EBOM→MBOM mappings + MBOM→EBOM sources + transformation runs,
    BOP/operation/work-center/MBOM-item navigation + linkage, characteristics/
    CTQ coverage, matrix/coverage/gaps/trace, change impact + jobs).
  - `web/src/pages/RequirementManufacturingPage.jsx` — tabbed workspace
    (Overview, Allocations, EBOM/MBOM, BOP/Operations, Characteristics & CTQ,
    Matrix & gaps, Change impact, Traceability, Configuration) modelled on
    `RequirementPdmPage.jsx`; allocation creation reuses the shared allocation
    vocabulary and target loaders, matrix/gap/impact/trace tabs consume the
    Boundary 3–7 projections, and the Configuration tab edits live tenant config.
    Wired via lazy import + nav item (`/requirement-manufacturing`) + route in
    `web/src/App.jsx`.
  - `server/tests/requirement-manufacturing-e2e.test.js` — 10/10 acceptance test
    that builds the full chain (Requirement → EBOM → MBOM → BOP → Operation ∥
    Work center, CTQ) from the seed + transformation engine and asserts the
    COVERED matrix row, zero scoped gaps, forward/reverse trace, CTQ linkage,
    forward/reverse impact, aggregate coverage, a scoped gap-sweep job, and the
    frontend REST surface end to end.

