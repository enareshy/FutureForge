# Enterprise Numbering & Identifier Service — HTTP API

All routes are mounted under `/api/numbering` with a versioned alias at
`/api/v1/numbering`. Every route except the health probes requires a bearer token.
Permission resources follow the `iam.numbering.*` catalogue; the action required is
shown per route.

## Metadata

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/meta` | `iam.numbering:read` | Enums (statuses, modes, policies), token registry and scope list |
| GET | `/object-types` | `iam.numbering.objecttypes:read` | List object types (`?status=`) |
| POST | `/object-types` | `iam.numbering.objecttypes:create` | Register an object type |
| POST | `/object-types/:code/status` | `iam.numbering.objecttypes:update` | Activate / deactivate an object type |
| GET | `/scopes` | `iam.numbering:read` | List supported scope dimensions |
| GET | `/tokens` | `iam.numbering:read` | List tokens |
| POST | `/tokens` | `iam.numbering.schemes:create` | Register a custom token |

## Schemes

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/schemes` | `iam.numbering.schemes:read` | List schemes (`objectType`, `status`, `q`, `scopeType`, paging) |
| POST | `/schemes` | `iam.numbering.schemes:create` | Create a scheme |
| GET | `/schemes/:ref` | `iam.numbering.schemes:read` | Scheme by code or id, including versions |
| PUT/PATCH | `/schemes/:ref` | `iam.numbering.schemes:update` | Update a scheme (versioned fields create a new version) |
| DELETE | `/schemes/:ref` | `iam.numbering.schemes:delete` | Delete an unused draft/inactive scheme |
| GET | `/schemes/:ref/versions` | `iam.numbering.schemes:read` | Immutable version history |
| POST | `/schemes/:ref/validate` | `iam.numbering.schemes:read` | Validate a scheme before activation |
| POST | `/schemes/:ref/clone` | `iam.numbering.schemes:create` | Clone a scheme to a new draft |
| POST | `/schemes/:ref/activate` | `iam.numbering.schemes:execute` | Activate a scheme |
| POST | `/schemes/:ref/deactivate` | `iam.numbering.schemes:execute` | Deactivate a scheme |
| POST | `/schemes/:ref/retire` | `iam.numbering.schemes:execute` | Retire a scheme permanently |

Deleting an active scheme, or one that has already issued identifiers, is refused;
retire it instead.

## Generation

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| POST | `/generate` | `iam.numbering.generate:create` | Allocate the next identifier |
| POST | `/reserve` | `iam.numbering.reserve:create` | Reserve an identifier (adds `reserve: true`) |
| POST | `/preview` | `iam.numbering.generate:read` | Next identifier without consuming it |
| POST | `/validate` | `iam.numbering.generate:read` | Validate an identifier against a scheme |

Request body:

```json
{
  "objectType": "PART",
  "schemeCode": "PART_STANDARD",
  "organizationId": 10,
  "plantId": 3,
  "siteId": 7,
  "classification": "mechanical",
  "manualNumber": "PART-2026-000042",
  "reservationTimeoutSeconds": 3600,
  "metadata": { "source": "cad-import" }
}
```

Pass an `Idempotency-Key` header to make a retry return the original allocation.
Supplying `manualNumber` additionally requires `iam.numbering.manual:create`.
`/preview` never advances a counter; its `would_reset` flag indicates the next
allocation will start a new period.

## Allocations

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/allocations` | `iam.numbering.allocations:read` | List allocations (`objectType`, `schemeId`, `status`, `organizationId`, `plantId`, paging) |
| GET | `/allocations/:ref` | `iam.numbering.allocations:read` | Allocation by id or reference |
| POST | `/allocations/:ref/consume` | `iam.numbering.consume:execute` | Mark a reservation as consumed by a business object |
| POST | `/allocations/:ref/release` | `iam.numbering.release:execute` | Release a reservation back to the pool |
| POST | `/allocations/:ref/cancel` | `iam.numbering.release:execute` | Cancel a reservation (terminal) |

## Sequences

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/sequences` | `iam.numbering.sequences:read` | List sequences (`schemeId`, `scopeKey`, `status`, `objectType`, paging) |
| GET | `/sequences/:id` | `iam.numbering.sequences:read` | Sequence detail with utilisation and remaining |
| POST | `/sequences/:id/reset` | `iam.numbering.sequences:execute` | Reset a sequence |

## Monitoring

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/metrics` | `iam.numbering.metrics:read` | Scheme/allocation counters and generation latency |
| GET | `/dashboard` | `iam.numbering.metrics:read` | Aggregated operational dashboard (`from`, `to`) |
| POST | `/maintenance/expire` | `iam.numbering.sequences:execute` | Expire overdue reservations on demand |
| GET | `/health` | none | Composite health; returns `503` when unhealthy |
| GET | `/health/live` | none | Liveness probe |
| GET | `/health/ready` | none | Readiness probe; `503` until ready |

## Errors

Errors use the platform envelope. Numbering-specific failures include a stable
`code` such as `NO_APPLICABLE_SCHEME`, `AMBIGUOUS_SCHEME`, `SCHEME_INACTIVE`,
`INVALID_OBJECT_TYPE`, `INVALID_PATTERN`, `SEQUENCE_EXHAUSTED`,
`NUMBER_ALREADY_EXISTS`, `INVALID_NUMBER_FORMAT`, `CONCURRENCY_CONFLICT` or
`SCHEME_CONFLICT`.

```json
{ "error": "Number \"PART-2026-000001\" already exists in this scope", "code": "NUMBER_ALREADY_EXISTS", "details": { "number": "PART-2026-000001" } }
```
