# Data Governance & Data Quality API

All routes require a bearer token and the permission listed against them and are
available under both `/api/data-governance` and `/api/v1/data-governance` (and
`/api/data-quality`, `/api/v1/data-quality`). Responses are JSON; list endpoints
return `{ items, total, page, page_size }`. Errors use
`{ error, code?, details? }`.

## Vocabulary, metrics and health

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/data-governance/meta` | `iam.data_governance:read` | Vocabularies, execution modes, duplicate strategies and remediation actions |
| GET | `/api/v1/data-governance/metrics` | `iam.data_governance.metrics:read` | Governance and quality counters plus aggregate quality |
| GET | `/api/v1/data-governance/health` | `iam.data_governance.metrics:read` | Health checks (domains, rules, unregistered types with results) |
| GET | `/api/v1/data-quality/meta` | `iam.data_quality:read` | Quality vocabularies, evaluators and duplicate strategies |

## Domains

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-governance/domains` | `iam.data_governance.domains:read` |
| GET | `/api/v1/data-governance/domains/tree` | `iam.data_governance.domains:read` |
| GET | `/api/v1/data-governance/domains/:ref` | `iam.data_governance.domains:read` |
| POST | `/api/v1/data-governance/domains` | `iam.data_governance.domains:create` |
| PUT/PATCH | `/api/v1/data-governance/domains/:ref` | `iam.data_governance.domains:update` |
| POST | `/api/v1/data-governance/domains/:ref/status` | `iam.data_governance.domains:execute` |
| DELETE | `/api/v1/data-governance/domains/:ref` | `iam.data_governance.domains:delete` |

Create body: `{ code, name, description?, category?, parent_id?, criticality?, status? }`.
Cycle-safe: a domain can never become its own ancestor.

## Ownership & stewardship

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-governance/ownership` | `iam.data_governance.ownership:read` |
| GET | `/api/v1/data-governance/ownership/resolve` | `iam.data_governance.ownership:read` |
| POST | `/api/v1/data-governance/ownership` | `iam.data_governance.ownership:create` |
| PATCH | `/api/v1/data-governance/ownership/:id` | `iam.data_governance.ownership:update` |
| DELETE | `/api/v1/data-governance/ownership/:id` | `iam.data_governance.ownership:delete` |

Create body: `{ scope, relationship, subject_type, subject_id, domain_id?, object_type?, attribute_name?, priority? }`.
`/ownership/resolve?domainId=&objectType=&attributeName=&relationship=` returns the
effective assignment by precedence (attribute > object > domain).

## Catalogue

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-governance/catalog` | `iam.data_governance.catalog:read` |
| GET | `/api/v1/data-governance/catalog/:ref` | `iam.data_governance.catalog:read` |
| POST | `/api/v1/data-governance/catalog` | `iam.data_governance.catalog:create` |
| PUT/PATCH | `/api/v1/data-governance/catalog/:ref` | `iam.data_governance.catalog:update` |
| GET | `/api/v1/data-governance/catalog/:ref/attributes` | `iam.data_governance.catalog:read` |
| POST | `/api/v1/data-governance/catalog/:ref/attributes` | `iam.data_governance.catalog:create` |
| PATCH | `/api/v1/data-governance/catalog/:ref/attributes/:attributeId` | `iam.data_governance.catalog:update` |

Register body: `{ object_type, name, description?, domain_id?, source_adapter? }`.

## Policies

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-governance/policies` | `iam.data_governance.policies:read` |
| GET | `/api/v1/data-governance/policies/:ref` | `iam.data_governance.policies:read` |
| GET | `/api/v1/data-governance/policies/:ref/versions` | `iam.data_governance.policies:read` |
| POST | `/api/v1/data-governance/policies` | `iam.data_governance.policies:create` |
| PUT/PATCH | `/api/v1/data-governance/policies/:ref` | `iam.data_governance.policies:update` |
| POST | `/api/v1/data-governance/policies/:ref/status` | `iam.data_governance.policies:execute` |

Create body:

```json
{
  "code": "PRODUCT_COMPLETENESS",
  "name": "Product completeness",
  "object_type": "product",
  "domain_id": 1,
  "severity": "error",
  "status": "active",
  "attributes": ["part.number", "part.name"],
  "rule_set": [
    { "code": "HAS_NUMBER", "rule_type": "REQUIRED", "attribute_name": "part.number", "severity": "error" }
  ]
}
```

Policy statuses are limited to `draft`, `active`, `suspended` and `retired`.
Activating a policy materialises executable `dg_rules` rows owned by the policy.

## Configuration & dimensions

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-governance/configuration` | `iam.data_governance.configuration:read` |
| PUT | `/api/v1/data-governance/configuration` | `iam.data_governance.configuration:update` |
| GET | `/api/v1/data-governance/dimensions` | `iam.data_governance.dimensions:read` |
| PUT | `/api/v1/data-governance/dimensions/:code` | `iam.data_governance.dimensions:update` |

Configurable keys: `scoring_strategy`, `status_thresholds`, `dimension_weights`,
`auto_raise_exceptions`, `exception_min_severity`, `event_evaluation_enabled`,
`notify_on_critical`, `history_retention_days`, `duplicate_threshold`.

## Quality rules

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-quality/rules` | `iam.data_quality.rules:read` |
| POST | `/api/v1/data-quality/rules/validate` | `iam.data_quality.rules:read` |
| GET | `/api/v1/data-quality/rules/:ref` | `iam.data_quality.rules:read` |
| GET | `/api/v1/data-quality/rules/:ref/versions` | `iam.data_quality.rules:read` |
| POST | `/api/v1/data-quality/rules` | `iam.data_quality.rules:create` |
| PUT/PATCH | `/api/v1/data-quality/rules/:ref` | `iam.data_quality.rules:update` |
| POST | `/api/v1/data-quality/rules/:ref/status` | `iam.data_quality.rules:execute` |

Create body (structural rule):

```json
{ "code": "HAS_NUMBER", "object_type": "product", "rule_type": "REQUIRED", "attribute_name": "part.number", "severity": "error", "status": "active" }
```

Create body (expression rule):

```json
{
  "code": "CATEGORY_ALLOWED",
  "object_type": "product",
  "rule_type": "CUSTOM",
  "attribute_name": "part.category",
  "expression": { "logic": "AND", "on_match": "PASS", "conditions": [{ "attribute": "part.category", "operator": "in", "value": ["mechanical", "hydraulic"] }] }
}
```

Rules are validated before activation; malformed or unsafe expressions are
rejected with `DATA_QUALITY_INVALID_EXPRESSION`.

## Evaluation

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/v1/data-quality/evaluate` | `iam.data_quality.evaluation:execute` |
| POST | `/api/v1/data-quality/evaluate/batch` | `iam.data_quality.evaluation:execute` |
| GET | `/api/v1/data-governance/jobs` | `iam.data_governance.jobs:read` |
| POST | `/api/v1/data-governance/jobs/evaluate` | `iam.data_governance.jobs:execute` |
| POST | `/api/v1/data-governance/jobs/duplicates` | `iam.data_governance.jobs:execute` |

Evaluate body: `{ object_type, object_id }`. Batch body:
`{ object_type, object_ids?, limit?, persist? }`. Batch/scheduled runs are
submitted as platform background jobs and return `202` with the job reference.

## Results, violations, scores & trends

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-quality/results` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/results/:objectType/:objectId` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/results/:objectType/:objectId/history` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/violations` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/scores` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/scores/domains` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/scores/object-types` | `iam.data_quality.results:read` |
| GET | `/api/v1/data-quality/scores/trend` | `iam.data_quality.results:read` |

Results carry `evaluation_state` of `PASSED`, `FAILED`, `NOT_EVALUATED` or
`UNKNOWN`. Aggregates are tenant scoped and never include other tenants.

## Exceptions

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-quality/exceptions` | `iam.data_quality.exceptions:read` |
| GET | `/api/v1/data-quality/exceptions/summary` | `iam.data_quality.exceptions:read` |
| GET | `/api/v1/data-quality/exceptions/:ref` | `iam.data_quality.exceptions:read` |
| PUT/PATCH | `/api/v1/data-quality/exceptions/:ref` | `iam.data_quality.exceptions:update` |
| POST | `/api/v1/data-quality/exceptions` | `iam.data_quality.exceptions:create` |
| POST | `/api/v1/data-quality/exceptions/:ref/assign` | `iam.data_quality.exceptions:execute` |
| POST | `/api/v1/data-quality/exceptions/:ref/status` | `iam.data_quality.exceptions:execute` |
| POST | `/api/v1/data-quality/exceptions/:ref/resolve` | `iam.data_quality.exceptions:execute` |
| POST | `/api/v1/data-quality/exceptions/:ref/verify` | `iam.data_quality.exceptions:execute` |
| POST | `/api/v1/data-quality/exceptions/:ref/close` | `iam.data_quality.exceptions:execute` |
| POST | `/api/v1/data-quality/exceptions/:ref/waive` | `iam.data_quality.exceptions:execute` |
| GET | `/api/v1/data-quality/exceptions/:ref/comments` | `iam.data_quality.exceptions:read` |
| POST | `/api/v1/data-quality/exceptions/:ref/comments` | `iam.data_quality.exceptions:update` |

Assign body: `{ assignee_user_id?, assignee_group_id?, assignee_organization_id?, priority?, due_date?, sla_hours?, comment? }`.
Update body: `{ description?, priority?, severity?, due_date?, sla_hours?, owner_user_id?, steward_user_id? }`.
Status transitions: `OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → VERIFIED → CLOSED`,
with `REJECTED`, `WAIVED`, `DUPLICATE` and `FALSE_POSITIVE` terminal branches.

## Duplicate detection

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-quality/duplicates/match-rules` | `iam.data_quality.duplicates:read` |
| POST | `/api/v1/data-quality/duplicates/match-rules` | `iam.data_quality.duplicates:create` |
| PATCH | `/api/v1/data-quality/duplicates/match-rules/:ref` | `iam.data_quality.duplicates:update` |
| GET | `/api/v1/data-quality/duplicates/candidates` | `iam.data_quality.duplicates:read` |
| GET | `/api/v1/data-quality/duplicates/summary` | `iam.data_quality.duplicates:read` |
| POST | `/api/v1/data-quality/duplicates/detect` | `iam.data_quality.duplicates:execute` |
| POST | `/api/v1/data-quality/duplicates/candidates/:ref/resolve` | `iam.data_quality.duplicates:execute` |

Match rule body: `{ code, name, object_type, attributes: ["part.number"], strategy, threshold? }`.
Strategies: `exact`, `normalized`, `attribute`, `similarity` (all deterministic).
Candidate resolution body: `{ status, resolution? }` where status is one of
`OPEN`, `REVIEWING`, `CONFIRMED`, `DISMISSED` or `MERGED`.

## Remediation

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/data-quality/remediations` | `iam.data_quality.remediation:read` |
| GET | `/api/v1/data-quality/remediations/summary` | `iam.data_quality.remediation:read` |
| POST | `/api/v1/data-quality/remediations` | `iam.data_quality.remediation:execute` |

Remediation body: `{ action_type, object_type, object_id, attribute_name?, value?, owner_user_id?, exception_id?, message? }`.
Actions: `SET_ATTRIBUTE`, `REPLACE_VALUE`, `ASSIGN_CLASSIFICATION`, `CORRECT_UOM`,
`MERGE_DUPLICATE` and `ASSIGN_OWNER`. Every attempt is recorded, including
failures.
