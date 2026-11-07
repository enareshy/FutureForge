# Verification & Validation (V&V) Engine — Design & Reuse Analysis

Prompt 7: Requirement → Verification/Validation Method → Test Case → Test Procedure
→ Test Execution → Test Result → Evidence → Requirement Status.

This document is the mandatory pre-coding deliverable (spec §2, §21, §22). It
records the technology inventory, architecture/dependency analysis, existing
object and relationship mapping, the REUSE / EXTEND / CREATE matrix, the V&V
domain model and relationship strategy, identified gaps/assumptions, and the
proposed component/API/event/security/test plan. No code is written until this
analysis is approved.

Guiding principle from the prompt: **inspect first; reuse the existing
technology stack, data model, business objects, relationship framework, Generic
Traceability Engine and platform services; extend where possible; create only
genuinely missing components. V&V must not become a separate test-management
silo.**

---

## 1. Technology Stack Inventory

| Concern | Existing implementation |
| --- | --- |
| Backend runtime | Node.js (ESM), Node v22 |
| Backend framework | Express 4 (`server/app.js`), custom `wrap`, routers mounted under `/api` + `/api/v1` |
| Persistence | PostgreSQL 15 via `pg` (no ORM). Sync `server/db.js`; async twins `server/db-async.js` (per-request transaction via AsyncLocalStorage) |
| API conventions | JSON, `req.actor`, tenant via `tenantOf(req)`, `auth` / `authAsync`, `can` / `canAsync`, correlation + idempotency helpers |
| AuthN/AuthZ | Session auth middleware; IAM resource strings `iam.<module>.<action>` via `services/security`, `services/authorization`, `services/access` |
| Events | `event_outbox` + `event_registry` + `event_subscriptions` + handlers (`services/events`) |
| Background jobs | `services/jobs` (job type registry, handlers, queues, retries, dead-letter) |
| Search | `services/search` registry (per-module `SEARCH_OBJECT_TYPES`) |
| Audit | `services/audit.js` (+ `services/audit/`, append-only, DB triggers reject UPDATE/DELETE) |
| Lifecycle | `services/lifecycle/` (states, categories, transitions, approvals) — pinned per object via `objects.lifecycle_*` |
| Workflow | `services/workflow/` (instances, tasks, approvals, bindings, lifecycle bridge) |
| Object framework | `services/objects/` (`objects`, `object_relationships`, `relationship_types`, `object_references`, `object_versions`) over `metadata_types` |
| Versioning | `services/versioning` |
| Classification | `services/classification/` (classes, characteristics with UOM/limits, assignments, allowed values, validation) |
| Reference / UOM | `services/reference`; classification `units.js` `convertValue` |
| Numbering | `services/numbering`; object framework has its own code allocator |
| Documents | `services/content` (`content`, `content_versions`, `content_associations`) |
| Requirements | `services/requirements/` (`requirements`, `requirement_revisions`, `requirement_relationships`, `requirement_baselines`, `requirement_validation_rules`) |
| Traceability | `services/traceability/` (composition over thread + objects; owns no tables) |
| Digital Thread | `services/thread/` (provider-based graph: object, pdm, bom, requirement-pdm, requirement-manufacturing providers) |
| Frontend | React 18 + Vite 6, `react-router-dom` 6, custom components/CSS |
| Testing | `node --test` (`server/tests/*.test.js`), helper + `openTestDatabase()` |
| Config | `services/config.js` feature/config definitions (per-tenant resolution) |

---

## 2. Architecture & Dependency Analysis

```
Requirements Manager  (system of record: requirements, revisions, requirement_relationships)
        │  VERIFIED_BY / VALIDATED_BY edges (already in the vocabulary)
        ▼
V&V Engine  (NEW native domain: owns test cases, procedures, executions, results, waivers;
             composes Requirement links, Content evidence, Classification units,
             Unit/Lifecycle/Workflow/Events/Jobs/Audit)
        │
Generic Traceability Engine  (services/traceability — composition over thread + objects)
        │
Digital Thread  (services/thread — provider-based graph; add a `verification-validation` provider)
        │
Object & Relationship Framework  (services/objects — metadata_types, objects, object_relationships)
        │
Reused engines: Content │ Classification │ Lifecycle │ Workflow │ Change │ IAM │ Audit │ Events │ Jobs │ Search
```

Key facts established during discovery:

- **No test-management subsystem exists.** `server/schema.sql` has **no** test case,
  test procedure, test execution, test result, evidence, waiver, or quality
  inspection / nonconformance / deviation / CAPA tables. The only "quality"
  tables (`dg_quality_*`, schema.sql:4802) belong to **Data Governance**, not
  product quality.
- **Verification/validation already exist as requirement columns and vocabulary**:
  `requirements.verification_status` (`NOT_VERIFIED|IN_PROGRESS|VERIFIED|FAILED|WAIVED`),
  `requirements.validation_status` (`NOT_VALIDATED|IN_PROGRESS|VALIDATED|FAILED`),
  `requirements.status` lifecycle includes `VERIFIED`/`VALIDATED`, and
  `RequirementsManager.setVerificationStatus` exists. VERIFIED_BY / VALIDATED_BY
  already exist in `requirements/constants.js RELATIONSHIP_TYPES`. **Reuse these;
  do not create a competing requirement lifecycle.**
- **Requirement-scoped generic edges** live in `requirement_relationships`
  (source_type/source_id/target_type/target_id free text) — the correct home for
  Requirement↔TestCase / Requirement↔Method links (spec §5: do not add a separate
  hard-coded requirement-to-test mapping if the generic engine suffices).
- **Evidence has no repository of its own to reuse for files**: `content` +
  `content_associations` (object_type/object_id → content, with `content_role`)
  is the authoritative document/evidence store (spec §3, §4.7, §18).
- **Numeric acceptance criteria** map onto Classification's units engine
  (`classification/units.js convertValue(value, fromUnit, toUnit, {units,strict})`)
  and CTQ/limits conventions from Prompt 5. No criteria/evaluation engine exists,
  so one small reusable evaluator is genuinely missing (spec §7).
- **MES integration (Prompt 6)** is **not implemented as a module**; MES/SLM exist
  only as integration/migration/exchange extension points
  (`data-exchange/connectors/builtins.js`, `migration/source-adapters/builtins.js`,
  `integration/validation.js`). V&V consumes MES evidence through the existing
  integration/exchange seam and, where a production result is materialised, as a
  generic object / content reference. Documented as a gap.

---

## 3. Existing Object / Relationship Mapping

| V&V concept | Owned by | Identity / node type | Notes |
| --- | --- | --- | --- |
| Requirement | `requirements` (+ `objects` mirror) | `requirement` | Edges in `requirement_relationships` |
| Requirement revision | `requirement_revisions` | `requirement_revision` | Executions pin exact revision |
| Verification / Validation method | none | `vv_method` | CREATE a small tenant-scoped registry (`vv_methods`) |
| Test case | none | `test_case` | CREATE (`vv_test_cases`) |
| Test procedure / steps | none | `test_procedure` | CREATE (`vv_test_procedures`, `vv_procedure_steps`) |
| Test execution | none | `test_execution` | CREATE (`vv_executions`) |
| Test result | none | `test_result` | CREATE (`vv_results`) |
| Evidence | `content` / `content_associations` | `content` | REUSE (link, never copy files) |
| Waiver / exception | none | `vv_waiver` | CREATE (`vv_waivers`) + existing workflow approvals |
| Acceptance criteria / evaluation | none | — | CREATE one reusable evaluator + criteria JSON on definitions |
| Product / item / revision | PDM | `pdm_item`, `pdm_revision` | REUSE (execution context) |
| MBOM / BOP / operation | BOM + Object framework | `bom_revision`, `operation` | REUSE (execution context, Prompt 5/6) |
| Characteristic / CTQ | Classification | `characteristic` | REUSE (measurement definition/limits) |
| Deviation / nonconformance / CAPA | none (Data Governance only) | — | GAP: integrate via Change + generic object/content; do not build a quality silo |
| Change request/order/notice | `services/change` | `change_request`, `change_order`, `change_notice` | REUSE (impact + integration) |
| Generic links | `object_relationships` (typed) + `requirement_relationships` (requirement-scoped) | — | No second graph |

---

## 4. Reuse / Extend / Create Matrix

| Capability | Existing implementation | Action |
| --- | --- | --- |
| Requirement identity / revision / lifecycle | `services/requirements` | REUSE |
| Requirement verification/validation status columns + `setVerificationStatus` | `requirements.verification_status` / `.validation_status` | REUSE / EXTEND (evidence-driven recalculation) |
| Requirement↔test links | `requirement_relationships` + `VERIFIED_BY`/`VALIDATED_BY` | REUSE |
| Generic objects / typed relationships | Object & Relationship Framework | REUSE (execution context links, cross-domain) |
| Traceability / traversal / coverage / impact | `services/traceability` + `services/thread` | REUSE (+ one new V&V thread provider) |
| Evidence / documents | `content` + `content_associations` | REUSE |
| Units, precision, conversion | `classification/units.js` | REUSE |
| Characteristics / CTQ limits | `services/classification` | REUSE |
| Lifecycle states/transitions | `services/lifecycle` + requirement lifecycle | REUSE (V&V execution state model follows platform conventions) |
| Approvals / review / waiver sign-off | `services/workflow` (+ lifecycle bridge) | REUSE |
| Change management | `services/change` | REUSE |
| Events / jobs / search | `services/events`, `services/jobs`, `services/search` | EXTEND (register V&V event/job/search types) |
| IAM / audit / notifications | `services/security`, `services/audit`, `services/notifications` | REUSE (new resource namespace) |
| Numbering | `services/numbering` | REUSE (TESTCASE/PROCEDURE/EXECUTION/WAIVER refs) |
| Verification/validation methods | none | CREATE (config registry `vv_methods`) |
| Test case / procedure / step definitions | none | CREATE (`vv_test_cases`, `vv_test_procedures`, `vv_procedure_steps`) |
| Execution / result recording | none | CREATE (`vv_executions`, `vv_results`) |
| Acceptance-criteria evaluator | none | CREATE (small reusable evaluator) |
| Coverage & requirement-status engine | partial (`verification_status` column only) | CREATE (calculate from executions/results/evidence/waivers) |
| Retest & waiver management | none | CREATE (`vv_waivers` + retest links) reusing workflow approvals |
| UI | existing page patterns (`RequirementManufacturingPage.jsx`) | EXTEND |

---

## 5. Identified Gaps, Assumptions and Constraints

**Gaps (closed in the smallest compatible way):**

1. **No test-management data model.** *CREATE* a minimal, dedicated V&V schema
   (`vv_*`), consistent with how native domains (requirements/change/bom/pdm) own
   their own tables and mirror/publish into the shared graph. No second object,
   relationship, document, workflow, audit or event engine.
2. **No verification/validation method registry.** *CREATE* `vv_methods`
   (tenant-scoped, seeded): verification vs validation flag + method type
   (TEST/INSPECTION/ANALYSIS/DEMONSTRATION/MEASUREMENT/SIMULATION).
3. **No acceptance-criteria evaluator.** *CREATE* one reusable evaluator
   supporting exact/allowed, min/max (inclusive/exclusive), tolerance, boolean,
   categorical, step-completion, logical combinations and manual evaluation;
   reuse `units.convertValue` for UOM. Missing result/evidence is never PASS.
4. **No evidence review/integrity seam.** *REUSE* `content` +
   `content_associations`; store evidence role/version/review-state on the
   association and execution/result reference. No file duplication.
5. **No coverage/status engine.** *CREATE* a calculation service that reads
   executions/results/evidence/waivers and writes the existing
   `requirement.verification_status` / `.validation_status` (and records status
   transitions) via `Requirements.setVerificationStatus`. It never overwrites
   historical records and never counts missing evidence as PASS.
6. **No retest linkage / no waiver object.** *CREATE* retest via
   `vv_executions.previous_execution_id` (new execution, never overwrite) and
   `vv_waivers` approved through `services/workflow`.
7. **No quality/deviation subsystem.** *GAP*: integrate failures to Change /
   generic objects and document the limitation; do not build a parallel
   deviation/CAPA model.
8. **MES (Prompt 6) not implemented as a domain.** *GAP*: consume MES evidence
   through the integration/exchange seam and generic object/content references.
9. **No V&V event/job/search/IAM/thread wiring.** *EXTEND* the existing seams
   (register in the foundation, mirroring `requirement-manufacturing`).

**Assumptions:**

- The existing DB is authoritative; V&V owns only its own test/execution/waiver
  state and links — never copies of requirements, products, BOM, documents.
- Methods, criteria templates, coverage rules, retest policies and waiver rules
  are configuration data, not hard-coded.
- Sync twins are retained for CLI/seeders/tests; routes use the async layer.
- The Digital Thread resolves V&V nodes through a single new provider.

**Non-goals (per prompt):** no parallel requirement/relationship/document/
workflow/quality/change/audit/event model; no second traceability, constraint or
scheduling engine; no job scheduler or message bus; no requirement lifecycle
competitor.

---

## 6. V&V Domain Model

Logical capabilities (concrete `vv_*` tables are the minimum missing store; all
cross-domain data is referenced, not copied):

- **Verification Method / Validation Method** (`vv_methods`): `code`, `name`,
  `kind` (`VERIFICATION|VALIDATION`), `method_type`
  (`TEST|INSPECTION|ANALYSIS|DEMONSTRATION|MEASUREMENT|SIMULATION`), `status`,
  `tenant_id` (null = global). A Requirement→Method link is a
  `requirement_relationships` edge carrying the method code in `attributes_json`.
- **Test Case** (`vv_test_cases`): ref/number, name, description, objective,
  method (→`vv_methods`), `kind` (verification vs validation), revision,
  status/lifecycle, owner/reviewer/approver, preconditions, inputs/parameters,
  `acceptance_criteria_json` (per-case default), equipment/environment/config,
  requirement scope (also materialised as `requirement_relationships` edges),
  links to supporting documents (content).
- **Test Procedure** (`vv_test_procedures`) + **Steps** (`vv_procedure_steps`):
  ordered steps (sequence, instruction, expected observation/measurement,
  per-step acceptance criteria, required inputs/equipment, safety notes),
  revision, approval state, optional controlled procedure document (content).
- **Test Execution** (`vv_executions`): ref, test case + procedure revision,
  applicable requirement revisions, product/item revision/configuration/
  manufacturing context (generic object references), status
  (`PLANNED→READY→IN_PROGRESS→COMPLETED→EVALUATED→REVIEWED` + `BLOCKED|CANCELLED|FAILED|REQUIRES_RETEST`),
  tester, planned/actual timestamps, environment/equipment, input params, notes,
  `previous_execution_id` (retest chain).
- **Test Result** (`vv_results`): execution (+ optional step) reference, expected
  value/outcome, actual value/observation, unit, acceptance criteria (with
  version), evaluation rule/version, `outcome`
  (`PASS|FAIL|PENDING|BLOCKED|NOT_EVALUABLE`), failure reason, evaluated_at,
  reviewer, evidence references. Historical results are preserved.
- **Evidence**: `content` associations against `vv_execution` / `vv_result`
  (role `EVIDENCE`), with version/review state; external evidence stored as a
  typed reference (URL/system+id) on the result/association metadata.
- **Waiver / Exception** (`vv_waivers`): requirement + revision, related
  test/execution/failure, justification, risk/rationale, scope/applicability,
  duration/expiry, requester, approver/decision/date, conditions, related
  change/deviation reference, status (`REQUESTED|APPROVED|REJECTED|REVOKED|EXPIRED`).

---

## 7. Requirement-to-V&V Traceability Strategy

- **Requirement ↔ Method / Test Case**: `requirement_relationships` edges
  (`VERIFIED_BY`, `VALIDATED_BY`; method code in edge attributes). Many-to-many.
- **Test Case → Procedure → Step**: FK columns (efficient, no generic edge).
- **Execution → Result → Evidence**: FK columns + `content_associations`.
- **Execution ↔ Requirement revision / product / operation / change**: generic
  `object_relationships` (or `requirement_relationships` where requirement-scoped)
  carrying revision/configuration context in edge attributes.
- **Digital Thread**: one new `verification-validation` provider resolves
  `test_case`, `test_procedure`, `test_execution`, `test_result`, `vv_waiver`
  nodes by projecting the `vv_*` tables, so the existing Traceability/Thread
  engine traverses Requirement → Method → TestCase → Procedure → Execution →
  Result → Evidence forward and backward with no new graph.

---

## 8. Acceptance-Criteria & Result Evaluation

Reusable evaluator (spec §7): exact/allowed value, min/max (inclusive or
exclusive), numeric tolerance, boolean, step-completion, expected categorical
outcome, logical combinations (`and`/`or`/`not`), and manual (authorized review).
Numeric results validate unit conversion via `classification/units.js`. Every
evaluation records criteria + version, actual result, rule + version, timestamp,
outcome, reason, and execution/evidence refs. Missing result/evidence/invalid
measurement is never PASS.

---

## 9. Requirement Status & Coverage Engine

Distinct concepts (spec §12): planning coverage, execution coverage, verification
outcome, validation outcome, exception status. Configurable aggregation rules
across multiple mandatory tests (one pass never verifies when another mandatory
test failed/incomplete). Writes the existing requirement status columns and
records status transitions. A valid approved waiver yields a distinct `WAIVED`
state, never a successful verification.

---

## 10. Failure, Retest, Waiver and Deviation Integration

- Failures preserved; retest creates a new execution linked to the failed one;
  original definition/execution/result/evidence never overwritten (spec §9).
- Waivers approved through the existing workflow/approval services; expired,
  revoked or rejected waivers do not count (spec §10).
- Quality/deviation/change integration uses existing Change + generic
  object/content references; no parallel quality subsystem (spec §11).

---

## 11. Revision, Configuration & Change Impact

Executions pin exact requirement / test case / procedure / product revision.
Requirement or definition changes flag potentially stale evidence via configured
applicability rules, recalculate status, and initiate review/retest through
existing workflows — without deleting history and without auto-invalidating all
evidence (spec §13). Impact reuses `Traceability.impactAnalysis`.

---

## 12. Proposed Component Changes

**New native domain module** `server/services/verification-validation/`:

- `constants.js` — vocabularies, node/relationship codes, IAM resources, event
  map, config keys, job/subscription definitions.
- `errors.js`, `configuration.js`, `security.js`, `events.js`.
- `foundation.js` — idempotent registration of metadata types, relationship
  types, event types, job types/handlers, search sources, numbering object types,
  config definitions and the V&V thread provider.
- `methods.js` — method registry CRUD/seed.
- `test-cases.js`, `test-procedures.js` (+ steps), `test-executions.js`,
  `test-results.js`, `evidence.js`, `waivers.js`.
- `criteria.js` — acceptance-criteria normalization + evaluator.
- `coverage.js` — planning/execution coverage, verification/validation outcome,
  requirement-status engine.
- `retest.js`, `deviation.js` — retest chains + failure/quality/change hand-off.
- `revision-impact.js` — revision applicability + stale-evidence flagging.
- `provider.js` — Digital Thread provider for V&V nodes.
- `jobs.js`, `subscriptions.js`.
- `router-verification-validation.js` — mounted `/api/verification-validation`
  (+ `/api/v1/...`).
- `index.js` — public facade (DB-first, sync + `*Async` twins).

**Schema (new tables only, `server/schema.sql` appended):** `vv_methods`,
`vv_test_cases`, `vv_test_procedures`, `vv_procedure_steps`, `vv_executions`,
`vv_results`, `vv_waivers` (+ indexes). No duplicate object/relationship/content/
workflow/audit/event tables.

**Extensions to existing modules:** register V&V codes in the existing seams; no
behavioral change to engine internals beyond additive registration.

**Frontend:** `web/src/api.js` (`verificationValidation` namespace) + new
`web/src/pages/VerificationValidationPage.jsx` workspace wired into the
Engineering navigation, plus a Requirement V&V panel link.

---

## 13. API & Event Changes

Endpoints (conceptual; adapted to platform conventions): test cases CRUD;
procedures + steps; requirement links; executions start/update/complete;
step/overall results; evidence attach/list; evaluate; requirement V&V status;
forward/backward trace; coverage + gaps; retest; waiver request/approve/reject/
revoke; failure→change/deviation link; history + change impact; meta/health/config.

Events (registered via `event_registry`): `TestCaseCreated`, `TestCaseApproved`,
`TestExecutionStarted`, `TestExecutionCompleted`, `TestResultRecorded`,
`TestResultEvaluated`, `VerificationFailed`, `VerificationCompleted`,
`ValidationCompleted`, `EvidenceAttached`, `RetestRequested`, `WaiverRequested`,
`WaiverApproved`, `WaiverRevoked`, `RequirementVnVStatusChanged`,
`VerificationEvidenceInvalidated`. Consumers idempotent; reuse outbox/DLQ/replay.

---

## 14. Security & Audit Design

- New IAM namespace `iam.verification-validation.*` registered through the
  existing security object-type seam; object-level access enforced on reads.
- Separation of duties (execute vs review vs approve) via existing roles/perms;
  controlled editing of approved definitions and completed results (amendments
  preserve the original + reason/actor/timestamp).
- Audit through `services/audit` for all definition/execution/result/evidence/
  waiver/status operations. No separate audit store.

---

## 15. Frontend UX

Extends existing UI conventions (tabbed page + `ConfigRow`), mirroring
`RequirementManufacturingPage.jsx`:
A. Requirement V&V workspace; B. Test case & procedure management; C. Test
execution workspace; D. V&V coverage dashboard; E. Evidence & result review;
F. Waiver & deviation workspace. Permissions, lifecycle rules, accessibility,
loading/empty/error states reuse existing components.

---

## 16. Performance & Reliability

Batched, paginated, indexed reads; per-requirement coverage avoids N+1; no full
table scans; large evidence stays in the content-storage abstraction; long
evaluations/coverage recalculation run as jobs reporting progress; concurrent
result submissions guarded by transaction boundaries + idempotency; no second
job scheduler/event bus.

---

## 17. Test Plan

- **Unit:** relationship validation; verification vs validation classification;
  criteria evaluation + boundaries + tolerance + units; missing/invalid evidence;
  coverage aggregation; requirement-status calculation; revision applicability;
  retest history; waiver validity/expiry; authorization/lifecycle transitions.
- **Integration:** requirements + traceability; test case/procedure persistence;
  content evidence; workflow approvals; change/deviation hand-off; MES evidence
  (where materialised); events/idempotency/retry; migrations + rollback.
- **Frontend:** workspace, definition/execution flows, evidence linking, coverage
  dashboard, failure/retest, waiver permissions, loading/validation/error states.
- **E2E acceptance:** the 12 scenarios from spec §20.
- **Regression:** existing Requirements/PDM/PLM/BOM/Classification/Traceability/
  Change/Job suites stay green.

---

## 18. Boundary Implementation Plan (report + approval after each)

1. **Boundary 1 — Foundation, schema & registry:** `vv_*` tables + indexes;
   module skeleton; methods registry seed; metadata/relationship types; IAM,
   event, job, search, numbering, config registration; health/meta; thread
   provider skeleton.
2. **Boundary 2 — Test cases & procedures:** definitions, revisions, steps,
   requirement links (`VERIFIED_BY`/`VALIDATED_BY`), lifecycle/approval.
3. **Boundary 3 — Executions, results & evidence:** execution lifecycle, step
   results, evidence association via content, retest chain.
4. **Boundary 4 — Acceptance-criteria evaluation service.**
5. **Boundary 5 — Requirement status & coverage engine.**
6. **Boundary 6 — Failure, retest, waiver & deviation/change integration.**
7. **Boundary 7 — Revision/configuration/change impact & traceability.**
8. **Boundary 8 — Events, jobs, subscriptions & audit.**
9. **Boundary 9 — APIs & router.**
10. **Boundary 10 — Frontend workspaces, docs & end-to-end acceptance.**

Each boundary: implement, test, report, await approval before continuing.

### Progress

- **Discovery & design — done (this document).**
- **Boundary 1 — Foundation, schema & registry — done.** `vv_*` tables + indexes;
  module skeleton (`constants`, `errors`, `configuration`, `security`, `events`,
  `methods`, `search`, `foundation`); methods registry seed; metadata object
  types, numbering schemes, IAM/event/search/config registration; health/meta;
  router mounted at `/api/verification-validation` (+ `/api/v1/...`).
  Schema version bumped `postgres_006 -> postgres_007`.
- **Boundary 2 — Test cases & procedures — done.** `refs.js`; `test-cases.js`
  (CRUD, revision, definition lifecycle, `VERIFIED_BY`/`VALIDATED_BY` requirement
  edges through the Requirements Manager); `test-procedures.js` (procedures +
  ordered steps, batch-loaded to avoid N+1); API routes; tests green.
- **Boundary 3 — Executions, results & evidence — done.** `test-executions.js`
  (planning gated on approved definitions, pinned definition revisions, execution
  lifecycle, retest chain via `previous_execution_id`); `test-results.js` (result
  recording, declarative acceptance-criteria evaluator, execution outcome rollup,
  manual outcomes); `evidence.js` (evidence via the Content association framework,
  denormalised evidence count, "pass requires evidence" gate); async config getters;
  API routes; tests green. Awaiting approval for Boundary 4.
- **Boundary 4 — Acceptance-criteria evaluation service — done.** `evaluation.js`
  pure evaluator: numeric comparisons with tolerance, inclusive/exclusive ranges,
  allowed-value sets, categorical/expected outcome, boolean, step-completion,
  regex/contains, logical `all`/`any`/`not`, and manual outcomes. Unit conversion
  reuses `classification/units.js`; missing/invalid measurements and incompatible
  units are never PASS (`NOT_EVALUABLE`). Evaluation persists criteria + rule +
  version on the result. Tests green. Awaiting approval for Boundary 5.
- **Boundary 5 — Requirement status & coverage engine — done.** `coverage.js`
  computes planning coverage (mandatory tests defined/approved), execution
  coverage (required executions completed), per-kind verification/validation
  outcomes (`ALL_MANDATORY`/`ANY`/`MAJORITY`, one unwaived failure or an
  incomplete mandatory test never PASSes), a deterministic requirement V&V status
  ladder (`NOT_PLANNED`/`PLANNED`/`IN_PROGRESS`/`PARTIALLY_VERIFIED`/`VERIFIED`/
  `VALIDATION_COMPLETE`/`FAILED`/`BLOCKED`/`WAIVED`) and gap lists. It reuses the
  Requirements Manager's `VERIFIED_BY`/`VALIDATED_BY` edges and the existing
  `requirements.verification_status`/`.validation_status` columns (no competing
  lifecycle), honours approved, unexpired waivers, and publishes
  `RequirementVnVStatusChanged`. `recalculate*` persists status changes
  idempotently and can fan out from changed test cases; `listRequirementCoverage*`
  / `coverageSummary*` back the `/coverage/*` and
  `/requirements/:ref/coverage[/recalculate]` API routes. `requirements.js`
  gained `setValidationStatus[Async]` and `listRequirementHistory[Async]`.
  Tests green. Awaiting approval for Boundary 6.
- **Boundary 6 — Failure, retest, waiver & deviation integration — done.**
  `waivers.js` owns the waiver/exception lifecycle
  (`REQUESTED→APPROVED|REJECTED`, `APPROVED→REVOKED|EXPIRED`) with validity/expiry
  checks and an overdue sweep; approvals use the platform's authorized-transition
  model (an optional `workflow_instance_id` is recorded for linkage, never a
  parallel approval engine); expired/revoked/rejected waivers never count, and a
  valid waiver drives the requirement to the distinct `WAIVED` state (never a
  pseudo-PASS) via the coverage engine. `retest.js` adds configurable retest
  policies (`FULL_TEST|FAILED_STEPS|FAILED_TEST`), retest-plan and retest-chain
  views; a retest still creates a new execution linked via `previous_execution_id`
  and never overwrites the failed attempt. `deviation.js` raises an existing Data
  Governance `dg_quality_exceptions` exception from a failed result/execution
  (storing only the reference), links existing Change/deviation records, and
   exposes failure lists/summary — no parallel quality/deviation subsystem. New
   routes for waivers, retest plan/chain, failures and quality integration.
   Tests green. Awaiting approval for Boundary 7.
- **Boundary 7 — Revision/configuration/change impact & traceability — done.**
  `provider.js` registers a single `verification-validation` Digital Thread
  provider (via the engine's `registerProvider` seam, `PROVIDERS.VERIFICATION_VALIDATION`):
  it resolves the `test_case`/`test_procedure`/`test_execution`/`test_result`/
  `waiver` nodes from the `vv_*` tables, delegates requirement/product/content
  nodes to the Object and Content providers that own them, and projects the
  `VERIFIED_BY`/`VALIDATED_BY` requirement edges plus the TestCase → Procedure →
  Execution → Result → Evidence edges (including retest chains and evidence
  content associations) forward and backward — no second graph. `revision-impact.js`
  reports revision/configuration applicability (`assessRevisionApplicability`
  pure function + `assessExecutionApplicability*`), lists and scans executions
  whose pinned test-case/procedure/requirement revision no longer matches the
  current revision (`listStaleEvidence*`, `scanStaleEvidence*`) and flags stale
  evidence by writing a flag into execution metadata and publishing
  `VerificationEvidenceInvalidated` — history is never deleted and evidence is
  never auto-invalidated unless `auto_invalidate_evidence` is enabled (default
  off). Change impact reuses `thread/impact.js` (`analyzeRequirementImpact*`)
  and classifies the V&V nodes it now reaches. New routes: requirement impact,
  execution applicability, stale-evidence list/scan, flag-stale. The V&V provider
  is registered from the idempotent foundation. Tests green (V&V suite 78/78;
  thread/traceability/requirement regression 81/81). Awaiting approval for
  Boundary 8.
- **Boundary 8 — Events, jobs, subscriptions & audit — done.** `jobs.js` registers
  the shared Job Scheduling & Execution Engine job types (`VV_COVERAGE_RECALC`,
  `VV_STALE_EVIDENCE_SCAN`), their handlers, and submit/run helpers; the tenant-wide
  recalculation pages through `recalculateTenantCoverage*` (new, reusing the
  per-requirement engine) so nothing loads every requirement at once.
  `subscriptions.js` registers two event-driven subscriptions through the shared
  Event & Messaging Framework — one consuming the engine's own events
  (`TestCaseApproved`, `TestExecutionCompleted`, `TestResultRecorded`,
  `TestResultEvaluated`, `VerificationCompleted`, `ValidationCompleted`,
  `WaiverApproved`, `WaiverRevoked`) to recalculate the affected requirement(s),
  the other consuming requirement lifecycle events (`RequirementRevised`,
  `RequirementUpdated`, `RequirementReleased`) to flag potentially stale evidence
  (scoped to the requirement; history never deleted, auto-invalidation still off by
  default) and recalculate coverage. `revision-impact.js` stale scans now accept an
  optional `requirementId` scope. `audit.js` exposes a module-scoped audit read
  (`listVvAudit*`) over the platform audit query layer — no separate audit store;
  the existing `writeAudit` capture on every V&V operation is unchanged.
  `foundation.js` now ensures job types, registers handlers and ensures both
  subscription sets idempotently on every boot; new API routes submit the coverage
  / stale-scan jobs (202), list the module audit trail and expose subscription
  status. Design §18: boundaries 1–8 implemented (each with sync + `*Async` twins);
  no parallel event bus, scheduler, or audit store. Tests green (new boundary
  suite 9/9; V&V suite 87/87; thread/traceability/requirement regression 112/112).
  Awaiting approval for Boundary 9.
- **Boundary 9 — APIs & router — done.** The REST surface is consolidated and
  documented in `docs/VERIFICATION_VALIDATION_API.md`: meta/health/audit/
  subscriptions/config/foundation, methods, test cases (+ requirement
  `VERIFIED_BY`/`VALIDATED_BY` links), procedures/steps, executions, results,
  evidence, coverage/status, waivers, retest plan/chain, failure → quality
  integration, revision applicability/stale evidence, and traceability/impact.
  All routes use the `*Async` service layer (no request mixes the sync and async
  twins), are tenant-scoped, authorize against the published
  `iam.verification-validation.*` resources, and return the platform error
  envelope. A convenience traceability route was added —
  `GET /requirements/:ref/trace` (`direction=DOWNSTREAM|UPSTREAM`) — which
  reuses the shared Digital Thread traversal engine via the V&V provider
  (`traceRequirement[Async]`), so no second graph is built. Tests green (V&V
  suite 89/89; thread/traceability/requirement regression 112/112). Awaiting
  approval for Boundary 10.
- **Boundary 10 — Frontend workspaces, docs & end-to-end acceptance — done.**
  Frontend: a `verificationValidation` namespace in `web/src/api.js` (every
  route), a new `web/src/pages/VerificationValidationPage.jsx` tabbed workspace
  (Overview, Test cases + requirement links, Procedures & steps, Executions &
  results + evidence, Coverage & status, Waivers & retest, Failures & quality,
  Traceability & impact, Configuration) mirroring the existing page conventions
  (no app-name/health header badges), wired into the Engineering navigation in
  `web/src/App.jsx` (`/verification-validation`), plus a "V&V coverage" link from
  the requirement detail panel in `RequirementsPage.jsx` that deep-links into the
  workspace. Docs: `docs/VERIFICATION_VALIDATION_API.md` documents the full REST
  surface. End-to-end acceptance: `server/tests/verification-validation-e2e.test.js`
  exercises the 12 canonical scenarios — (1) provider registration, (2) plan +
  approve + `VERIFIED_BY` link, (3) procedure with ordered steps, (4) execution
  pins approved revision + requirement scope, (5) execute/record/attach
  evidence/evaluate to PASS, (6) coverage recalculation drives `VERIFIED`,
  (7) evidence gate blocks an unsupported PASS, (8) failure drives `FAILED` and
  raises an existing quality exception, (9) retest creates a linked new execution
  and restores `VERIFIED`, (10) approved waiver yields `WAIVED` and a revoked
  waiver does not count, (11) revising a definition flags stale evidence without
  deleting history and re-approval restores coverage, (12) traceability, impact,
  audit and the REST API are wired end to end. Tests green (V&V suite 101/101;
  thread/traceability/requirement regression 106/106). Design §18 boundaries 1–10
  implemented; no parallel requirement/relationship/content/workflow/quality/
  change/audit/event/job/traceability engine.


