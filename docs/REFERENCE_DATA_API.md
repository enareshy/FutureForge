# Enterprise Reference Data Management — HTTP API

The reference data API is exposed under both `/api/reference-data` and the
versioned alias `/api/v1/reference-data`. Every route requires authentication and
is authorized through the `iam.reference.*` permission resources. Errors are
returned as `{ "error": "...", "details": {...}, "code": "REFERENCE_*" }`.

`tenant` scoping is derived from the authenticated request; consumers pass domain
scope context through resolution bodies instead of headers.

## Meta and health

- `GET /meta` — vocabularies (statuses, scope types, categories, mandatory domains,
  default scope precedence) and the current cache epoch.
- `GET /health/live` — liveness probe.
- `GET /health/ready` — readiness with pending-approval and metrics detail.
- `GET /metrics` — snapshot totals and per-status breakdowns.
- `GET /dashboard` — top domains, recently updated values and pending approvals.

## Domains

- `GET /domains` — list domains (filters: `status`, `category`, `q`, paging).
- `POST /domains` — create a domain.
- `GET /domains/:ref` — fetch one domain (by ref, code or id).
- `PUT|PATCH /domains/:ref` — update descriptive fields and ownership.
- `POST /domains/:ref/status` — activate/inactivate/deprecate.
- `GET /domains/:ref/governance` — active policy plus version history.
- `POST /domains/:ref/governance` — publish a new governance policy version.
- `GET /domains/:ref/ownership-history` — ownership/stewardship change trail.
- `GET /domains/:ref/tree` — hierarchy tree for the domain.
- `POST /domains/:ref/reindex` — reindex every value in the domain.

## Values and value metadata

- `GET /items` — list values (filters: `domainCode`, `status`, `scopeKey`,
  `scopeType`, `code`, `q`, `parentId`, `effectiveAt`, paging).
- `POST /items` — create a value.
- `GET /items/:ref` — fetch a value (with children).
- `PUT|PATCH /items/:ref` — update a value (records a new version).
- `DELETE /items/:ref` — delete a value.
- `POST /items/:ref/status` and `/submit` `/approve` `/activate` `/inactivate`
  `/retire` `/reject` — lifecycle transitions.
- `GET /items/:ref/versions` — immutable version history.
- `GET /items/:ref/relationships` — related values.
- `GET /items/:ref/codes` / `POST /items/:ref/codes` — alternate/external codes.
- `GET /items/:ref/aliases` / `POST /items/:ref/aliases` — aliases.
- `GET /items/:ref/translations` / `POST /items/:ref/translations` — translations.
- `GET /codes` `/codes/:ref`, `PATCH|DELETE /codes/:ref` — code administration.
- `GET /aliases`, `PATCH|DELETE /aliases/:ref` — alias administration.
- `GET /translations`, `DELETE /translations/:ref` — translation administration.
- `GET /versions/:ref` and `GET /versions/:ref/compare/:other` — version compare.

## Hierarchy and relationships

- `GET /hierarchy` — list edges (filters: `domainId`, `parentId`, `childId`).
- `POST /hierarchy` — create an edge (cycle-safe; rebuilds materialized paths).
- `GET /hierarchy/:ref/descendants` — subtree descendants.
- `DELETE /hierarchy/:ref` — remove an edge.
- `GET /relationships` — list relationships.
- `POST /relationships` — create a typed cross-domain relationship.
- `PATCH|DELETE /relationships/:ref` — update or remove.

## Scope policies

- `GET /scope-policies`, `POST /scope-policies`
- `GET /scope-policies/:ref`, `PUT|PATCH /scope-policies/:ref`,
  `DELETE /scope-policies/:ref`

## Resolution and validation

- `POST /resolve` — resolve a single value (by `code`, `alias`, `itemRef` or
  `is_default`), honouring scope precedence, effective dating and language.
- `POST /resolve/bulk` — resolve many values without N+1 queries.
- `POST /lookup` — silent lookup; returns `null` when no value resolves.
- `POST /validate` — validation result (`valid`, `reason`, `matched_scope`, codes).
- `GET /values` — effective values for a domain (filters: `domain_code`,
  `language`, `asOf`, `text`).
- `GET /search` — cross-domain value search over code, name, description, aliases,
  alternate codes and translations.

Example:

```json
POST /api/reference-data/resolve
{ "domain_code": "UNIT_OF_MEASURE", "code": "EA", "as_of": "2026-06-01" }
```

```json
{
  "resolution_status": "RESOLVED",
  "resolution": "code",
  "domain": { "id": 1, "code": "UNIT_OF_MEASURE", "name": "Unit of Measure" },
  "value": { "item_ref": "RDM-UNIT_OF_MEASURE-EA", "code": "EA", "name": "Each", "scope_key": "GLOBAL", "version": 1 }
}
```

## Approvals and change requests

- `GET /approvals`, `GET /approvals/:ref`
- `POST /items/:ref/approvals` — submit a value for approval.
- `POST /approvals/:ref/decide` — `{ "decision": "approve" | "reject", "comment": "..." }`
- `GET /change-requests`, `POST /change-requests`, `PATCH /change-requests/:ref`

## Import and export

- `GET /imports`, `GET /imports/:ref`
- `POST /imports` — stage and validate rows (no writes on invalid input).
- `POST /imports/:ref/commit` — commit a validated import.
- `GET /exports`, `GET /exports/:ref`, `GET /exports/:ref/download`
- `POST /exports` — produce a JSON/CSV/TSV export artifact.

## SDK consumption

Business modules should depend on `server/services/reference.js` rather than the
HTTP API or reference tables:

```js
import { resolveValue, listValues, searchValues, validateValue, ReferenceData } from "../services/reference.js";
```

The SDK applies the same scope precedence, effective dating and caching as the
API, so behaviour is identical for in-process and remote consumers.
