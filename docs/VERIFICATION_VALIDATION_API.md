# Verification & Validation Engine — API

Base path (both aliases): `/api/verification-validation` and
`/api/v1/verification-validation`.

- Authentication: bearer token via the platform `auth`/`authAsync` middleware.
- Tenant: derived from the authenticated principal (`tenantOf(req)`); every read
  and write is tenant-scoped.
- Authorization: IAM resource codes `iam.verification-validation.*` (see table
  below); deny by default.
- Errors: the platform's standard error envelope (HTTP status + stable error
  code + message + details). Validation happens centrally before any write.
- Pagination: list endpoints accept `page` and `pageSize` (alias `page_size`)
  and return `{ items, total, page, pageSize }`.
- Idempotency: retest/coverage/stale-scan jobs accept an `idempotency_key`;
  requirement V&V status recalculation is idempotent (only changes are written
  and published).
- Async discipline: the router uses the `*Async` service layer consistently, so
  no request mixes the sync and async twins.

IAM resources: `overview`, `test-cases`, `procedures`, `executions`, `results`,
`evidence`, `coverage`, `waivers`, `traceability`, `impact`, `quality`,
`metrics`, `admin`.

---

## Meta, health, audit & config

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/meta` | overview:read | Static vocabulary (node types, kinds, statuses, outcomes, resources, config). |
| GET | `/health` | overview:read | Module health (foundation + counts). |
| GET | `/audit` | overview:read | Module-scoped audit/event view (filters: `action`, `resource_type`, `resource_id`, `actor`, `from`, `to`, `status`, `q`). |
| GET | `/subscriptions` | admin:read | Registered event subscriptions (own + requirement). |
| GET | `/config` | admin:read | List `verification_validation.*` config. |
| PUT | `/config/:key` | admin:update | Update a config key. |
| POST | `/foundation/ensure` | admin:execute | Idempotently ensure foundation rows (methods, job types, handlers, subscriptions). |

## Verification / validation methods

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/methods` | test-cases:read | List method registry (`status`, `verification_kind`, `q`). |
| POST | `/methods` | admin:create | Create a method. |
| GET | `/methods/:ref` | test-cases:read | Get one method. |
| PUT | `/methods/:ref` | admin:update | Update a method. |

## Test cases

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/test-cases` | test-cases:read | List/paginate (`status`, `verification_kind`, `method_code`, `organization_id`, `owner_user_id`, `q`). |
| POST | `/test-cases` | test-cases:create | Create a test case. `201`. |
| GET | `/test-cases/:ref` | test-cases:read | Get one test case. |
| PUT | `/test-cases/:ref` | test-cases:update | Update a test case. |
| POST | `/test-cases/:ref/transition` | test-cases:update | Lifecycle transition (`status`/`target`, `reason`). |
| POST | `/test-cases/:ref/revise` | test-cases:create | Revise (new revision). |

## Requirement coverage links (VERIFIED_BY / VALIDATED_BY)

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/test-cases/:ref/requirements` | test-cases:read | Requirements linked to a test case. |
| POST | `/test-cases/:ref/requirements` | test-cases:update | Link a requirement (`relationship_type` in `VERIFIED_BY`/`VALIDATED_BY`). `201`. |
| DELETE | `/test-cases/:ref/requirements/:relationshipRef` | test-cases:update | Unlink a requirement. |

## Test procedures & steps

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/procedures` | procedures:read | List procedures (`test_case_id`, `status`, `includeSteps`). |
| GET | `/test-cases/:ref/procedures` | procedures:read | Procedures for a test case. |
| POST | `/test-cases/:ref/procedures` | procedures:create | Create a procedure. `201`. |
| GET | `/procedures/:ref` | procedures:read | Get one procedure. |
| PUT | `/procedures/:ref` | procedures:update | Update a procedure. |
| POST | `/procedures/:ref/transition` | procedures:update | Lifecycle transition. |
| GET | `/procedures/:ref/steps` | procedures:read | Ordered steps. |
| POST | `/procedures/:ref/steps` | procedures:update | Add a step. `201`. |
| PUT | `/procedures/:ref/steps/:stepRef` | procedures:update | Update a step. |
| DELETE | `/procedures/:ref/steps/:stepRef` | procedures:update | Remove a step. |

## Test executions

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/executions` | executions:read | List/paginate (`status`, `overall_outcome`, `test_case_id`, `procedure_id`, `previously_of`, `q`). |
| POST | `/executions` | executions:create | Plan an execution (gated on approved definitions). `201`. |
| GET | `/executions/:ref` | executions:read | Get one execution. |
| PUT | `/executions/:ref` | executions:update | Update an execution. |
| POST | `/executions/:ref/transition` | executions:update | Lifecycle transition. |
| POST | `/executions/:ref/retest` | executions:create | Request a retest (new execution via `previous_execution_id`). `201`. |
| GET | `/executions/:ref/requirements` | executions:read | Requirement scope of an execution. |
| POST | `/executions/:ref/evaluate` | results:update | Evaluate all results and roll up the outcome. |

Execution lifecycle: `PLANNED → READY → IN_PROGRESS → COMPLETED → EVALUATED →
REVIEWED`, plus `FAILED` / `BLOCKED` / `CANCELLED` / `REQUIRES_RETEST`.

## Test results

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/results` | results:read | List/paginate (`execution_id`, `result_level`, `outcome`, `requirement_id`). |
| GET | `/results/:ref` | results:read | Get one result. |
| POST | `/executions/:ref/results` | results:create | Record a result. `201`. |
| PUT | `/results/:ref` | results:update | Update a result. |
| POST | `/results/:ref/evaluate` | results:update | Evaluate against acceptance criteria. |

## Evidence (content associations)

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/evidence` | evidence:read | List evidence associations (filters via query). |
| POST | `/evidence` | evidence:create | Attach evidence (existing content) to a result/execution. `201`. |
| DELETE | `/evidence/:associationRef` | evidence:update | Detach evidence. |

"Pass requires evidence" is enforced when `verification_validation.require_evidence_for_pass`
is on: an evaluation cannot reach PASS without supporting evidence.

## Requirement V&V coverage & status

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/coverage/requirements` | coverage:read | List requirement coverage (`status`, `verification_status`, `validation_status`). |
| GET | `/coverage/summary` | coverage:read | Aggregate coverage summary. |
| GET | `/requirements/:ref/coverage` | coverage:read | Compute coverage for a requirement (`rule`). |
| POST | `/requirements/:ref/coverage/recalculate` | coverage:update | Recompute and persist the requirement V&V status. |
| POST | `/coverage/recalculate/job` | coverage:create | Queue a tenant coverage recalculation. `202`. |

## Waivers & exceptions

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/waivers` | waivers:read | List/paginate (`status`, `requirement_id`, `test_case_id`, `execution_id`, `result_id`, `valid_only`). |
| GET | `/waivers/summary` | waivers:read | Waiver summary. |
| POST | `/waivers/expire-overdue` | waivers:update | Expire overdue waivers. |
| POST | `/waivers` | waivers:create | Request a waiver / exception. `201`. |
| GET | `/waivers/:ref` | waivers:read | Get one waiver. |
| PUT | `/waivers/:ref` | waivers:update | Update a waiver. |
| POST | `/waivers/:ref/transition` | waivers:update | Lifecycle transition (`APPROVED`/`REJECTED`/`REVOKED`). |

## Retest policy, chain & plan

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/executions/:ref/retest-chain` | executions:read | Retest lineage. |
| GET | `/executions/:ref/retest-plan` | executions:read | Suggested retest plan (`policy`). |

## Failure → quality / change / deviation integration

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/failures` | quality:read | List failures (`test_case_id`, `execution_id`, `requirement_id`). |
| GET | `/failures/summary` | quality:read | Failure summary. |
| POST | `/quality-exceptions` | quality:create | Raise an existing Quality module exception (`dg_quality_exceptions`). `201`. |
| POST | `/failures/link-records` | quality:update | Link independent failure records. |

## Revision / configuration applicability & stale evidence

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/executions/:ref/applicability` | traceability:read | Assess pinned revisions/config vs current. |
| POST | `/executions/:ref/flag-stale` | traceability:update | Flag potentially stale evidence (metadata + event; no history lost). |
| GET | `/stale-evidence` | traceability:read | List potentially stale evidence. |
| POST | `/stale-evidence/scan` | traceability:update | Scan and (optionally) flag stale evidence. |
| POST | `/stale-evidence/scan/job` | traceability:create | Queue a stale-evidence scan. `202`. |

## Traceability & change impact

Both endpoints reuse the shared Digital Thread engine (the V&V provider projects
`test_case`, `test_procedure`, `test_execution`, `test_result` and `vv_waiver`
nodes), so no second graph or engine is created.

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/impact` | impact:read | Downstream impact chain, classified by V&V category. |
| GET | `/requirements/:ref/trace` | traceability:read | Forward (`direction=DOWNSTREAM`) or backward (`direction=UPSTREAM`) trace. |

`/requirements/:ref/trace` returns `{ requirement, root, direction, node_count,
edge_count, depth_reached, truncated, category_totals, domains, nodes, edges }`
and supports `maxDepth` (alias `max_depth`) and `asOf`.

---

## Events, jobs & subscriptions

The module owns no scheduler and no message bus. It registers domain-event
handlers and job types on the existing platform frameworks:

- Job types: `VV_COVERAGE_RECALC`, `VV_STALE_EVIDENCE_SCAN` on queue
  `verification-validation`, handled by
  `verification-validation.coverageRecalc` /
  `verification-validation.staleEvidenceScan`.
- Event subscriptions: test-case/execution/result/waiver events feed coverage
  recalculation; requirement revised/updated/released events feed stale-evidence
  scanning plus requirement recalculation.
- Published events include `TestCaseCreated`/`Approved`, `TestExecutionStarted`/
  `Completed`, `TestResultRecorded`/`Evaluated`, `VerificationCompleted`,
  `ValidationCompleted`, `VerificationFailed`, `EvidenceAttached`,
  `RetestRequested`, `WaiverRequested`/`Approved`/`Revoked`,
  `RequirementVnVStatusChanged`, `VerificationEvidenceInvalidated` and
  `QualityExceptionRaised`.

Audit trails are read through `/audit`, which projects the shared platform event
store (`SOURCE_MODULE`-scoped) rather than maintaining a separate audit table.
