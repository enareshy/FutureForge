# Requirement → PLM Integration — API

Base path (both aliases): `/api/requirement-pdm` and `/api/v1/requirement-pdm`.

- Authentication: bearer token via the platform `auth`/`authAsync` middleware.
- Tenant: derived from the authenticated principal (`tenantOf(req)`).
- Authorization: IAM resources `iam.requirement-pdm[.*]` (see table below).
- Errors: the platform's standard error envelope (HTTP status + stable error
  code + message + details). Validation happens centrally before any write.
- Idempotency: allocation/link creation dedupes on the natural key and returns
  `created:false` / `reactivated:true`; change initiation is keyed by
  `requirement-change:<tenant>:<requirementId>:v<version>` (or an explicit
  `idempotency_key`) and never creates a duplicate change request.

IAM resources: `overview`, `allocations`, `coverage`, `compatibility`, `impact`,
`synchronization`, `metrics`, `plm`, `changes`, `change-initiation`, `documents`,
`admin`.

---

## Meta, health, config

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/meta` | allocations:read | Static vocabulary (target/node types). |
| GET | `/health` | overview:read | Integration health. |
| GET | `/config` | admin:read | List `requirement_pdm.*` config. |
| PUT | `/config/:key` | admin:update | Update a config key. |
| POST | `/foundation/ensure` | admin:execute | Idempotently ensure foundation rows. |
| GET | `/targets` | allocations:read | Target type vocabulary. |
| GET | `/targets/resolve` | allocations:read | Resolve a target (`target_type`, `target_id`/`ref`). |

## Allocations

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/allocations` | allocations:read | List/paginate (`requirement_id`, `relationship_type`, `target_type`, `target_id`, `status`, `page`, `pageSize`, `withTargets`). |
| POST | `/allocations` | allocations:create | Create an allocation. `201` when created, `200` when reactivated. |
| GET | `/allocations/:ref` | allocations:read | Get one allocation. |
| DELETE | `/allocations/:ref` | allocations:delete | Remove an allocation. |
| POST | `/allocations/:ref/check` | compatibility:execute | Compatibility check. |
| POST | `/allocations/:ref/synchronize` | synchronization:execute | Synchronize one allocation. |
| GET | `/requirements/:ref/allocations` | allocations:read | Requirement-scoped allocations. |
| GET | `/requirements/:ref/coverage` | coverage:read | Allocation coverage. |
| GET | `/requirements/:ref/compatibilities` | compatibility:read | Requirement compatibilities. |

## Product / lifecycle

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/products` | allocations:read | Products allocated to a requirement (query `status`). |
| GET | `/products/:ref/lifecycle` | plm:read | Realized lifecycle for a product. |
| GET | `/products/:ref/requirements` | plm:read | Requirements realized by a product (query `status`). |

## EBOM / MBOM / BOP structures

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/structures` | plm:read | Structure projection (`status`, `asOf`, `variant`, `configuration`, `includeStructure`). |
| GET | `/requirements/:ref/structure-coverage` | plm:read | Structure coverage (`asOf`, `variant`, `configuration`). |
| GET | `/structures/:ref/trace` | plm:read | Full structure trace for a BOM revision. |
| GET | `/structures/:ref/requirements` | plm:read | Reverse: requirements for a BOM revision (query `status`). |

Effectivity/configuration filtering is delegated to the BOM engine
(`filterByEffectivity`, `filterByVariant`).

## Documents

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/documents` | documents:read | Document projection (`category`, `page`, `pageSize`). Content is only projected when downloadable and not infected. |

## Impact analysis

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/impact-analysis` | impact:read | Impact report (`maxDepth`, `asOf`). |
| POST | `/requirements/:ref/impact-analysis` | impact:execute | Impact report with body options. |
| POST | `/requirements/:ref/impact-analysis/job` | impact:execute | `202` async impact job. |
| GET | `/coverage` | coverage:read | Tenant coverage summary. |
| GET | `/impact` | impact:read | Tenant impact summary. |
| GET | `/impact/allocations` | impact:read | Impact across allocations. |

## Change Management links

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/changes` | changes:read | Linked changes (`change_type`, paging). |
| POST | `/requirements/:ref/changes` | changes:create | Link a change (`201`/`200`). |
| GET | `/changes/:type/:id` | changes:read | Require a change node. |
| GET | `/changes/:type/:id/requirements` | changes:read | Requirements linked to a change node. |
| DELETE | `/change-links/:ref` | changes:delete | Unlink a change. |

## Change initiation and chain

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/requirements/:ref/change-initiation` | change-initiation:read | Evaluate rules without writing (`maxDepth`, `asOf`, `severity`). |
| POST | `/requirements/:ref/change-initiation` | change-initiation:execute | Initiate (idempotent). `201` when created, `200` when existing. |
| POST | `/requirements/:ref/change-initiation/job` | change-initiation:execute | `202` async change-initiation job. |
| GET | `/requirements/:ref/change-chain` | change-initiation:read | CR→ECO→ECN chain for a requirement. |

Change initiation reuses the existing ECR (`services/change`); it never creates
a parallel change object.

## PLM → Requirement synchronization

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| POST | `/synchronize` | synchronization:execute | Synchronize from a PLM node. |
| POST | `/synchronize/job` | synchronization:execute | `202` async sync job. |
| POST | `/synchronize/enqueue` | synchronization:execute | `202` enqueue sync. |
| POST | `/impact/sweep` | impact:execute | `202` impact sweep job. |
| GET | `/plm-nodes/:type/:id/requirements` | plm:read | Reverse navigation from a PLM node. |
| POST | `/plm-sync` | synchronization:execute | PLM→Requirement sync (`nodeType`, `nodeId`, `analyze`, `eventType`). |
| POST | `/plm-sync/job` | synchronization:execute | `202` async PLM sync job. |
| POST | `/plm-sync/enqueue` | synchronization:execute | `202` enqueue PLM sync. |

## Metrics

| Method | Path | Resource | Purpose |
| --- | --- | --- | --- |
| GET | `/integration/summary` | metrics:read | Integration summary. |
| GET | `/metrics` | metrics:read | Integration metrics. |
| GET | `/plm-metrics` | metrics:read | PLM metrics. |
| GET | `/metrics/plm` | metrics:read | PLM metrics (alias). |

---

## Representative contracts

### Create allocation — `POST /allocations`

Request:

```json
{
  "requirement_id": 42,
  "relationship_type": "SATISFIED_BY",
  "target_type": "bom_revision",
  "target_id": 7,
  "configuration_context": "CONFIG-A",
  "effectivity_from": "2026-01-01"
}
```

Response `201`:

```json
{
  "allocation_ref": "RREL-...",
  "relationship_type": "SATISFIED_BY",
  "status": "ACTIVE",
  "target_type": "bom_revision",
  "target_id": "7",
  "created": true,
  "reactivated": false
}
```

Validation: known requirement; resolvable target of a supported `target_type`;
effectivity well-formed; optional release gate
(`requirement_pdm.require_target_released`). Errors: `404` target/requirement not
found, `409` conflict, `422` validation, `403` unauthorized.

### Initiate change — `POST /requirements/:ref/change-initiation`

Request: `{ "force": false, "severity": "CRITICAL", "idempotency_key": "..." }`

Response `201` when a change request is created:

```json
{
  "status": "CREATED",
  "created": true,
  "decision": { "initiate": true, "severity": "CRITICAL", "matched_rules": ["AUTO_CHANGE_REQUEST"] },
  "change": { "id": 5, "change_type": "change_request", "request_number": "ECR-000005", "status": "DRAFT" }
}
```

Repeat calls return `status:"EXISTING"` with the same `change.id`. The created
request then flows through the existing Change Management workflow
(`submit → screen → promote → order → approve → release → notice`).

### PLM sync — `POST /plm-sync`

Request: `{ "nodeType": "bom_revision", "nodeId": 7, "analyze": true, "eventType": "BomRevisionReleased" }`

Response:

```json
{
  "direction": "PLM_TO_REQUIREMENT",
  "status": "COMPLETED",
  "node": { "node_type": "bom_revision", "node_id": "7" },
  "requirement_count": 1,
  "analyzed_count": 1,
  "failed_count": 0,
  "requirements": [{ "requirement": { "id": 42 }, "analysis_status": "ANALYZED" }]
}
```

Failure handling: a per-requirement failure yields `status:"FAILED"` (or
`PARTIAL`) with the error captured and a `RequirementPLMSynchronizationFailed`
event published; retrying is safe and does not duplicate change requests.
