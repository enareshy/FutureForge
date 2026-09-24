# BOM Engine - HTTP API

Base paths: `/api/bom` and `/api/v1/bom`. All endpoints require authentication
(Bearer token). Errors use the standardized shape
`{ "error": string, "code"?: string, "details"?: object }`. List endpoints return
`{ items, total, page, page_size }`. Unauthenticated calls return `401`; calls
without the required permission return `403`.

Permission resources:
`iam.bom.{overview,boms,revisions,lines,structure,compare,whereused,rollup,
transformation,validation,baseline,search,audit,metrics,admin}` with actions
`read`, `create`, `update`, `delete`, `execute`.

## Meta, health, metrics and configuration

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Vocabularies, capabilities, security actions and resources |
| GET | `/health` | Foundation counts and health status (`healthy` / `degraded`) |
| GET | `/metrics?bom_type=` | Adoption snapshot, quality signals and cache stats |
| GET | `/compare-summary` | Comparison counts by change type |
| GET | `/config` | Effective tenant configuration |
| PUT/PATCH | `/config/:key` | Set a single configuration key (bounds-enforced) |
| GET | `/units?q=` | Unit catalogue (Reference Data `UNIT_OF_MEASURE`) |
| GET | `/units/convert?value=&from=&to=` | Convert a value between units |

## BOM headers & revisions

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/boms` | List / create BOM headers |
| GET | `/boms/:ref` | Read a BOM header (id, `bom_ref` or `bom_number`) |
| PUT/PATCH | `/boms/:ref` | Update |
| POST | `/boms/:ref/status` | Transition BOM status |
| DELETE | `/boms/:ref` | Delete |
| GET | `/boms/:ref/audit` | Change history for the BOM |
| GET/POST | `/boms/:ref/revisions` | List / create revisions |
| GET | `/revisions` | List revisions |
| GET | `/revisions/:ref` | Read a revision |
| PUT/PATCH | `/revisions/:ref` | Update |
| POST | `/revisions/:ref/status` | Transition revision status (`DRAFT`/`IN_REVIEW`/`RELEASED`/`SUPERSEDED`/`OBSOLETE`) |
| POST | `/revisions/:ref/revise` | Create a successor draft, copying lines/substitutes/attributes |
| DELETE | `/revisions/:ref` | Delete a revision |
| GET | `/revisions/:ref/tree` | Nested structure tree |
| GET | `/revisions/:ref/structure` | Flattened structure |
| GET/POST | `/revisions/:ref/lines` | List / add lines |
| POST | `/revisions/:ref/lines/reorder` | Reorder lines |
| GET/POST | `/revisions/:ref/substitutes` | List / add substitutes |
| GET | `/revisions/:ref/substitutes/summary` | Substitute counts by group |
| POST/GET | `/revisions/:ref/rollup` | Compute a recursive quantity rollup |
| POST | `/revisions/:ref/validate` | Run validation rules over the revision |
| GET | `/revisions/:ref/validation-results` | Validation results for the revision |

## Lines, attributes & substitutes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/lines` | List lines (filters: `revision_id`, `usage`, `find_number`, `line_status`, ...) |
| GET | `/lines/:ref` | Read a line with attributes |
| PUT/PATCH | `/lines/:ref` | Update |
| DELETE | `/lines/:ref` | Remove |
| GET/PUT | `/lines/:ref/attributes` | List / replace per-line attributes |
| GET | `/substitutes` | List substitutes |
| PUT/PATCH | `/substitutes/:ref` | Update |
| DELETE | `/substitutes/:ref` | Remove |

## Where-used, uses & comparison

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/where-used` | Where-used search (query `object_id`, filters) |
| GET | `/where-used/:objectId` | Direct where-used parents |
| POST | `/where-used/:objectId/multi-level` | Cycle-safe multi-level where-used |
| GET | `/where-used/:objectId/summary` | Component usage summary |
| GET | `/uses` | What a BOM/revision consumes |
| POST | `/compare` | Compare two revisions or baselines (`left_kind`/`left_id`, `right_kind`/`right_id`, `scope`) |
| GET | `/comparisons` | List comparisons |
| GET | `/comparisons/:ref` | Read a comparison with summary |
| GET | `/comparisons/:ref/results` | Per-line diff results (`change_type`) |

## Transformation

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/transformations` | List / create transformation definitions |
| GET | `/transformations/:ref` | Read a definition |
| PUT/PATCH | `/transformations/:ref` | Update |
| DELETE | `/transformations/:ref` | Delete |
| GET/POST | `/transformations/:ref/mappings` | List / add mappings |
| PUT/PATCH/DELETE | `/transformations/:ref/mappings/:mappingId` | Update / delete a mapping |
| POST | `/transform` | Run a transformation (`mode`: `DRY_RUN`/`EXECUTE`) |
| GET | `/transformation-runs` | List runs |
| GET | `/transformation-runs/:ref` | Read a run |

## Validation rules & results

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/validation-rules` | List / create rules |
| PUT/PATCH | `/validation-rules/:ref` | Update |
| DELETE | `/validation-rules/:ref` | Delete |
| GET | `/validation-results` | List validation results |
| GET | `/validation-results/:ref` | Read a result |
| GET | `/validation-results/:ref/issues` | Issues for a result (`severity`) |

## Baselines

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/baselines` | List / create baselines |
| GET | `/baselines/:ref` | Read a baseline |
| GET | `/baselines/:ref/lines` | Frozen baseline lines |
| GET | `/baselines/:ref/snapshot` | Baseline plus its frozen lines |
| POST | `/baselines/:ref/freeze` | Freeze (immutable) |
| DELETE | `/baselines/:ref` | Delete (rejected when frozen) |

## History, jobs, search & seed

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/history` | Change history (filters: `entity_type`, `entity_id`, `entity_ref`, `action`) |
| GET | `/history/:objectType/:objectId` | Object BOM lineage |
| POST | `/jobs/rollup` | Submit a rollup job |
| POST | `/jobs/where-used` | Submit a where-used job |
| POST | `/jobs/transform` | Submit a transformation job |
| POST | `/jobs/validate` | Submit a validation job |
| POST | `/jobs/compare` | Submit a comparison job |
| POST | `/jobs/maintenance` | Submit a maintenance job |
| POST | `/foundation/ensure` | Idempotently ensure foundation |
| POST | `/seed` | Install the idempotent demonstration BOM |
| GET | `/search-meta` | Registered BOM search object types |
| POST | `/search/reindex` | Re-register BOM search sources |

## Background jobs & idempotency

Job submission endpoints return `202` and accept an `Idempotency-Key` header (or
`idempotency_key` / `idempotencyKey` in the body). Re-submitting the same key
returns the existing job rather than creating a new one.

## Examples

Create a BOM and a draft revision, then add lines:

```
POST /api/v1/bom/boms
{ "bom_number": "PUMP-ASSY", "name": "Pump assembly", "bom_type": "EBOM" }

POST /api/v1/bom/boms/PUMP-ASSY/revisions
{ "revision_number": "A1" }

POST /api/v1/bom/revisions/1/lines
{ "child_object_id": "SEAL", "quantity": 2, "uom": "EA", "find_number": "40",
  "usage": "DESIGN" }
```

Roll up and validate:

```
POST /api/v1/bom/revisions/1/rollup
{ "options": { "includeOptional": true } }

POST /api/v1/bom/revisions/1/validate
{}
```

Release the revision and freeze a baseline:

```
POST /api/v1/bom/revisions/1/status
{ "status": "IN_REVIEW" }
POST /api/v1/bom/revisions/1/status
{ "status": "RELEASED" }

POST /api/v1/bom/baselines
{ "revision_id": 1, "baseline_number": "PUMP-ASSY-BL-A", "name": "Pump A baseline" }

POST /api/v1/bom/baselines/PUMP-ASSY-BL-A/freeze
```

Compare two revisions and run an EBOM to MBOM transformation:

```
POST /api/v1/bom/compare
{ "left_kind": "REVISION", "left_id": 1, "right_kind": "REVISION", "right_id": 2 }

POST /api/v1/bom/transform
{ "definition_id": 1, "source_revision_id": 1, "mode": "DRY_RUN" }
```
