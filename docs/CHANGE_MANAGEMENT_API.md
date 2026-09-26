# Change Management API

Base paths: `/api/change` and `/api/v1/change`. Every route requires a
session (`Authorization: Bearer <token>`) and an IAM grant on the matching
`iam.change.*` resource. Errors: `{error, code, details}`. Lists:
`{items, total, page, page_size}`.

## Meta / health / configuration

- `GET /meta` — vocabulary, resource map
- `GET /health` — per-tenant counts
- `GET /config`, `PUT /config/:key`
- `POST /foundation/ensure` — re-run the idempotent bootstrap
- `POST /seed` — install the demo ECR→ECO→ECN chain

## Change Requests (ECR)

- `GET /requests`, `POST /requests`
- `GET /requests/:ref`, `PUT /requests/:ref`
- `POST /requests/:ref/submit`
- `POST /requests/:ref/withdraw`
- `POST /requests/:ref/screen` — body `{decision: "APPROVED"|"REJECTED", notes}`
- `POST /requests/:ref/promote` — body optional `{title, description, effective_strategy, metadata}`; returns `{request, order}`
- `GET /requests/:ref/history`

## Change Orders (ECO)

- `GET /orders`, `POST /orders`
- `GET /orders/:ref`, `PUT /orders/:ref`
- `POST /orders/:ref/submit`
- `POST /orders/:ref/decide` — body `{decision: "APPROVED"|"REJECTED"}`; on approval, best-effort fires `lifecycle.release.approved` for any registered workflow binding
- `POST /orders/:ref/release` — requires APPROVED status and at least one affected item; returns `{order, effectivity: [...], baseline_id}`
- `POST /orders/:ref/cancel`
- `GET /orders/:ref/history`

### Affected items & impact

- `GET /orders/:ref/affected-items`
- `POST /orders/:ref/affected-items` — body `{object_type, object_id, object_label, disposition, notes}`
- `DELETE /orders/:ref/affected-items/:itemRef`
- `GET /impact?objectType=&objectId=&maxDepth=` — BOM-backed multi-level where-used suggestion

## Change Notices (ECN)

- `GET /notices`, `POST /notices` — body requires `change_order_id` of a **RELEASED** order
- `GET /notices/:ref`
- `POST /notices/:ref/issue`
- `POST /notices/:ref/acknowledge`
- `GET /notices/:ref/history`

## Relationships

- `GET /relationships`, `POST /relationships`, `GET /relationships/:ref`, `DELETE /relationships/:ref`
- `relationship_type`: `PRODUCES_ORDER` | `PRODUCES_NOTICE` | `AFFECTS`

Design notes: `docs/CHANGE_MANAGEMENT_DESIGN.md`.
