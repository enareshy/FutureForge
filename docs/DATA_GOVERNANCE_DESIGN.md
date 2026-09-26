# Data Governance & Data Quality Design

The Data Governance & Data Quality capability is the single centralized platform
service for data domains, ownership, data policies, quality rules, quality
evaluation, scoring, exceptions, duplicate detection and remediation. Business
modules register their data definitions (domains, object types, attributes,
relationships, rules, ownership and stewardship) with this service; they never
build their own governance model or quality engine.

Related documents: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`,
`docs/ORGS_DESIGN.md`, `docs/DATA_SECURITY_DESIGN.md`,
`docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/REFERENCE_DATA_DESIGN.md`,
`docs/SEARCH_FOUNDATION_DESIGN.md`, `docs/EVENTS_DESIGN.md`,
`docs/JOB_EXECUTION_DESIGN.md`, `docs/AUDIT_DESIGN.md` and the HTTP reference
`docs/DATA_GOVERNANCE_API.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| Domains, catalogue, ownership, policies, quality rules, scoring, exceptions, duplicates, remediation | Data Governance & Data Quality service |
| Users, groups, roles, permissions, resource catalogue | IAM / Authorization |
| Tenant, organization, plant and site hierarchy | Organization Management |
| Object types, attributes (typed metadata) and object data | Metadata + Object & Relationship Framework |
| Reference domains and value validation | Enterprise Reference Data |
| Background execution, retries and scheduling | Job Execution Framework |
| Domain events and subscriptions | Event & Messaging framework |
| Audit trail of governance administration and evaluation | Audit & History |
| Notifications on critical quality and exception assignment | Notifications + Delivery |
| Search over domains and exceptions | Search Foundation |

The service never reads another module's tables directly. All object data flows
through a **data source adapter** (`server/services/data-governance/adapter.js`),
whose default implementation `platform.objects` is backed by the Object
Framework.

## 2. Data model

All tables use the `dg_` prefix and are tenant scoped.

| Table | Purpose |
| --- | --- |
| `dg_domains` | Data domain hierarchy (`parent_id`), category, criticality, status |
| `dg_ownership` | Ownership / stewardship assignments with scope and precedence |
| `dg_catalog_objects` | Registered governed object types and their source adapter |
| `dg_catalog_attributes` | Governed attributes: label, data type, required, sensitivity, reference domain |
| `dg_policies` / `dg_policy_versions` | Versioned governance policies (DRAFT/ACTIVE/SUSPENDED/RETIRED) |
| `dg_rules` / `dg_rule_versions` | Executable quality rules and their version snapshots |
| `dg_dimensions` | Per-tenant quality dimensions and weights |
| `dg_configuration` | Per-tenant scoring, thresholds, weights and behaviour switches |
| `dg_quality_results` | Historical, versioned evaluation results per object (one `is_current`) |
| `dg_quality_violations` | Per-rule violations behind each result (one `is_current`) |
| `dg_quality_exceptions` | Exception workflow records with priority, SLA, due date and escalation |
| `dg_exception_comments` | Exception discussion / audit comments |
| `dg_duplicate_match_rules` | Configured duplicate matching rules and strategies |
| `dg_duplicate_candidates` | Detected duplicate candidate pairs and their resolution |
| `dg_remediations` | Applied remediation actions and outcomes |
| `dg_quality_jobs` | Quality job run bookkeeping (batch/scheduled/duplicate runs) |

## 3. Quality dimensions and scoring

Five dimensions are seeded per tenant: **completeness**, **validity**,
**consistency**, **accuracy** and **uniqueness**. Each rule maps to a dimension
(a rule type maps to a default dimension).

Scoring is a pure function of the per-dimension pass rate and configurable
weights:

```
score = 100 * Σ(weight_d * passed_d / total_d) / Σ(weight_d)
```

Status bands are configurable and default to:

| Status | Minimum score |
| --- | --- |
| EXCELLENT | 90 |
| GOOD | 75 |
| WARNING | 60 |
| POOR | 40 |
| CRITICAL | 0 |

An object with **no active rules is `NOT_EVALUATED`**, never `PASSED`. Result
records carry `evaluation_state` in `PASSED` / `FAILED` / `NOT_EVALUATED` /
`UNKNOWN`, so an unevaluated object can never be mistaken for a healthy one.

## 4. Rule expressions are data, never code

A rule is a declarative `IF <attribute> <operator> <value> THEN PASS/FAIL`
predicate. Expressions are compiled and validated by
`server/services/data-governance/expressions.js`:

- Attribute paths must match a strict grammar and may not contain `__proto__`,
  `prototype` or `constructor` segments.
- Operators come from a closed set (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`,
  `in`, `not_in`, `is_null`, `is_not_null`, `contains`, `matches`, `between`,
  length operators, ...).
- There is **no `eval` and no `Function`**. A condition count, value size and
  regular expression length are all bounded.
- Structural rule types (`REQUIRED`, `NOT_NULL`, `UNIQUE`, `REFERENCE`) accept
  an attribute-only form and normalise to a canonical null-check condition.

Rules are validated at create/update and re-validated before activation, so an
active rule can always be evaluated. Every change snapshots a new rule version.

## 5. Evaluation engine

`engine.js` orchestrates evaluation and contains no rule-type-specific business
logic beyond a small built-in evaluator set:

- Built-in evaluators: `REQUIRED` / `NOT_NULL`, `UNIQUE`, `REFERENCE` and a
  generic expression evaluator for all other rule types.
- Business modules may `registerEvaluator(ruleType, fn)` or register their own
  `registerAdapter(code, { load, list, findDuplicates })`.
- Evaluation loads the governed object through its adapter, runs every active
  and currently-effective rule, aggregates dimensions, computes the score,
  persists a result plus violations and raises exceptions for failures at or
  above the configured severity floor.

Execution modes are `SYNC`, `ASYNC`, `BATCH`, `SCHEDULED` and `EVENT_DRIVEN`.
Large or scheduled runs are submitted as platform background jobs
(`DATA_QUALITY_BATCH`, `DATA_QUALITY_SCHEDULED`, `DATA_QUALITY_DUPLICATES`,
`DATA_QUALITY_MAINTENANCE`) so request transactions are never blocked. Object
create/update events re-evaluate governed objects through the event framework.

## 6. Exception lifecycle

```
OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → VERIFIED → CLOSED
  ↘ REJECTED  ↘ WAIVED  ↘ DUPLICATE  ↘ FALSE_POSITIVE
```

Exceptions carry priority, SLA, due date and an assignee that may be a user,
group, data steward, data owner or organization. Overdue exceptions are
escalated by the maintenance job. All transitions are guarded and audited.

## 7. Duplicate detection

Duplicate detection is behind a strategy interface and is fully deterministic in
P1 (no machine learning is claimed). Built-in strategies:

| Strategy | Behaviour |
| --- | --- |
| `exact` | Byte-for-byte equality of the configured attributes |
| `normalized` | Case/whitespace/punctuation-insensitive equality |
| `attribute` | Exact equality restricted to the configured attribute list |
| `similarity` | Normalised Levenshtein ratio above the configured threshold |

New strategies are added with `registerDuplicateStrategy(code, fn)`. Detected
pairs are stored as candidates that can be resolved as duplicate, distinct or
false positive.

## 8. Multi-tenancy and security

- Every table and query is tenant scoped; tenant identity is always derived
  server-side and never accepted from the client.
- Dashboard aggregates, scores and counts are computed only over the caller's
  tenant, so counts cannot leak governed data across tenants.
- Access is enforced with the standard IAM permission model. Resource codes are
  `iam.data_governance.*` and `iam.data_quality.*`; roles are configured through
  IAM, never hard-coded in the service.

## 9. Platform reuse

| Platform capability | Reuse |
| --- | --- |
| Events | 21 `Data*` / `DataQuality*` event types registered idempotently |
| Jobs | Four quality job types + handlers registered on the shared worker |
| Search | Governed domains and quality exceptions registered as searchable object types |
| Notifications | Critical quality, exception assignment and escalation notices |
| Audit | Every administration and evaluation action writes an audit record |
| Reference data | `REFERENCE` rules resolve values through reference validation |

## 10. Source layout

```
server/services/data-governance/
  constants.js      vocabularies, transitions, config defaults, event types
  errors.js         typed HttpError subclasses (DATA_GOVERNANCE_* / DATA_QUALITY_*)
  validation.js     normalisation, assertion, pagination, vocabulary()
  refs.js           public reference generators (DG-DOM-, DG-RULE-, DG-EXC-, ...)
  repository.js     row → public DTO mappers
  expressions.js    safe rule compiler / evaluator (no eval)
  domains.js        domain hierarchy and cycle guard
  ownership.js      ownership scopes and resolution precedence
  catalog.js        governed object types and attributes
  policies.js       versioned policies that materialise executable rules
  configuration.js  tenant configuration
  dimensions.js     dimensions, scoring and status bands
  rules.js          rule validation, versioning and activation
  adapter.js        data source adapters (platform.objects)
  engine.js         evaluation orchestration and evaluators
  results.js        read model: results, violations, scores, trends
  exceptions.js     exception lifecycle, comments, escalation
  duplicates.js     strategy registry and duplicate detection
  remediation.js    remediation actions
  events.js         event type registration and publishing
  jobs.js           background job handlers and submission
  search.js         search registrations
  notifications.js  notification helpers
  metrics.js        metrics and health
  foundation.js     idempotent bootstrap and event subscriptions
  seed.js           demonstration estate seed
  index.js          public facade / stable SDK
  router-data-governance.js  /api/data-governance REST router
  router-data-quality.js     /api/data-quality REST router
```
