# Enterprise Classification Framework — HTTP API

Base paths: `/api/classification` and `/api/v1/classification`. All endpoints
require authentication (Bearer token). Errors use the standardized shape
`{ "error": string, "code"?: string, "details"?: object }`. List endpoints return
`{ items, total, page, page_size }`. Unauthenticated calls return `401`; calls
without the required permission return `403`.

Permission resources:
`iam.classification.{overview,classifications,classes,characteristics,groups,values,
assignments,validation,search,governance,migration,audit,metrics,admin}` with
actions `read`, `create`, `update`, `delete`, `execute`.

## Meta, health, metrics

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Vocabularies, capabilities, security actions and resources |
| GET | `/health` | Foundation counts and health status (`healthy` / `degraded`) |
| GET | `/metrics` | Adoption snapshot (totals, per-status, classified objects, missing required) |
| GET | `/coverage?object_type=&total_objects=` | Classification coverage report |

## Configuration

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/config` | Effective tenant configuration |
| PUT/PATCH | `/config/:key` | Set a single configuration key (bounds-enforced) |

## Classifications

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/classifications` | List / create |
| GET | `/classifications/:ref` | Read |
| PUT/PATCH | `/classifications/:ref` | Update |
| POST | `/classifications/:ref/status` | Transition status |
| POST | `/classifications/:ref/approve` | Approve |
| DELETE | `/classifications/:ref` | Delete (only when it has no classes/assignments) |
| GET/POST | `/classifications/:ref/versions` | List / create a version snapshot |
| GET | `/classifications/:ref/audit` | Change history for the classification |
| GET | `/classifications/:ref/tree` | Class tree (nodes with children) |
| POST | `/classifications/:ref/reorder-classes` | Reorder sibling classes |

## Classes & inheritance

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/classes` | List / create |
| GET | `/classes/:ref` | Read |
| PUT/PATCH | `/classes/:ref` | Update |
| POST | `/classes/:ref/status` | Transition status |
| POST | `/classes/:ref/move` | Move within the hierarchy (cycle-safe) |
| POST | `/classes/:ref/copy` | Copy a class (optionally with subtree) |
| DELETE | `/classes/:ref` | Delete when empty |
| GET | `/classes/:ref/children` | Direct children |
| GET | `/classes/:ref/ancestors` | Ancestor chain |
| GET | `/classes/:ref/descendants` | Subtree |
| GET/POST | `/classes/:ref/versions` | List / create a class version |
| GET | `/classes/:ref/effective` | Effective (inherited + local) characteristics |
| GET/POST | `/classes/:ref/characteristics` | List / attach a characteristic to the class |
| POST | `/classes/:ref/validate` | Validate a value map against the class |
| GET | `/classes/:ref/approved-values` | Validate allowed-value modes |
| PUT/PATCH/DELETE | `/class-characteristics/:ref` | Update / remove a class-characteristic link |

## Characteristics, allowed values & groups

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/characteristics` | List / create |
| GET | `/characteristics/:ref` | Read |
| PUT/PATCH | `/characteristics/:ref` | Update |
| POST | `/characteristics/:ref/status` | Transition status |
| DELETE | `/characteristics/:ref` | Delete when unused |
| GET/POST | `/characteristics/:ref/versions` | List / create a version |
| GET/POST | `/characteristics/:ref/allowed-values` | List / add an allowed value |
| PUT/PATCH/DELETE | `/allowed-values/:ref` | Update / delete an allowed value |
| GET/POST | `/groups` | List / create characteristic groups |
| GET | `/groups/:ref` | Read |
| PUT/PATCH | `/groups/:ref` | Update |
| DELETE | `/groups/:ref` | Delete |
| GET/POST | `/groups/:ref/members` | List / add a member |
| DELETE | `/groups/:ref/members/:characteristicRef` | Remove a member |

## Rules

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/rules` | List / create |
| PUT/PATCH | `/rules/:ref` | Update |
| DELETE | `/rules/:ref` | Delete |

## Assignments

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/assignments` | List / assign a class to an object |
| GET | `/assignments/:ref` | Read with stored values |
| PUT/POST | `/assignments/:ref/values` | Replace assignment values |
| POST | `/assignments/:ref/status` | Set assignment status |
| POST | `/assignments/:ref/reclassify` | Replace the assigned class |
| POST | `/assignments/:ref/validate` | Validate the assignment's values |
| DELETE | `/assignments/:ref` | Unassign |

## Objects, duplicates & units

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/objects/:objectType/:objectId` | Classifications of an object |
| GET | `/objects/:objectType/:objectId/values` | Resolved values for an object |
| GET | `/objects/:objectType/:objectId/effective` | Effective characteristics for an object |
| POST | `/objects/:objectType/:objectId/validate` | Validate an object's classifications |
| POST | `/objects/:objectType/validate-batch` | Validate many objects |
| POST | `/duplicates/scan` | Run a duplicate scan |
| GET | `/duplicates/summary` | Duplicate groups/similarity summary |
| GET | `/units` | Unit catalogue (Reference Data `UNIT_OF_MEASURE`) |
| POST | `/units/convert` | Convert a value between units |

## History, jobs & seed

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/history` | Change history (filters: `entity_type`, `entity_id`, `entity_ref`, `action`) |
| GET | `/lineage/:objectType/:objectId` | Object classification lineage |
| POST | `/jobs/bulk-assign` | Submit a bulk assign/unassign job |
| POST | `/jobs/bulk-validate` | Submit a bulk validation job |
| POST | `/jobs/duplicate-scan` | Submit a duplicate scan job |
| POST | `/jobs/maintenance` | Submit a maintenance job |
| POST | `/seed` | Install the idempotent demonstration classification |

## Background jobs & idempotency

Job submission endpoints return `202` and accept an `Idempotency-Key` header (or
`idempotency_key` / `idempotencyKey` in the body). Re-submitting the same key
returns the existing job rather than creating a new one.

## Examples

Create a classification and an active class:

```
POST /api/v1/classification/classifications
{ "code": "MECH_COMPONENTS", "name": "Mechanical components" }

POST /api/v1/classification/classes
{ "classification_id": 1, "code": "PUMP", "name": "Pump" }

POST /api/v1/classification/classes/1/status
{ "status": "ACTIVE" }
```

Attach a required enumerated characteristic and add allowed values:

```
POST /api/v1/classification/characteristics
{ "code": "MATERIAL", "name": "Material", "data_type": "ENUMERATION" }

POST /api/v1/classification/characteristics/MATERIAL/allowed-values
{ "code": "STAINLESS_STEEL", "display_name": "Stainless steel" }

POST /api/v1/classification/classes/1/characteristics
{ "characteristic_id": 1, "required": true }
```

Classify an object and validate it:

```
POST /api/v1/classification/assignments
{ "object_type": "product", "object_id": "PUMP-001", "class_id": 1,
  "values": { "MATERIAL": "STAINLESS_STEEL" } }

GET  /api/v1/classification/objects/product/PUMP-001/values
POST /api/v1/classification/objects/product/PUMP-001/validate
```

Validate a value map against a class without saving:

```
POST /api/v1/classification/classes/1/validate
{ "values": { "MATERIAL": "GOLD" } }
```

The response contains `valid`, `errors`, `warnings`, `missing_required`,
`invalid_values` and per-characteristic `items`.
