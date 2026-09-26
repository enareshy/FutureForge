# Migration & Onboarding Framework — HTTP API

Base paths: `/api/migration` and `/api/v1/migration`. All endpoints require
authentication (Bearer token). Errors use the standardized shape
`{ "error": string, "code"?: string, "details"?: object }`. List endpoints return
`{ items, total, page, page_size }`.

Permission resources: `iam.migration.{overview,projects,packages,definitions,
sources,mapping,validation,dependencies,planning,execution,reconciliation,
identifiers,relationships,files,audit,statistics,metrics,admin}` with actions
`read`, `create`, `update`, `execute`.

## Meta, health, metrics

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Vocabulary (statuses, strategies, adapter types, pipeline stages), security actions, resources, capabilities |
| GET | `/health` | Health checks and foundation counts |
| GET | `/metrics` | Operational snapshot (projects, packages, jobs, errors, variance) |

## Source adapters & configurations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/source-adapters` | Built-in and registered source adapter catalogue |
| GET/POST | `/source-configurations` | List / create |
| GET | `/source-configurations/:ref` | Read |
| PUT/PATCH | `/source-configurations/:ref` | Update |
| POST | `/source-configurations/:ref/status` | Activate / deactivate |
| POST | `/source-configurations/:ref/test` | Test connectivity |
| POST | `/source-configurations/:ref/discover` | Discover the source schema |

## Projects

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/projects` | List / create |
| GET | `/projects/:ref` | Read |
| PUT/PATCH | `/projects/:ref` | Update |
| POST | `/projects/:ref/status` | Transition status |
| GET | `/projects/:ref/packages` | Packages in the project |
| GET | `/projects/:ref/dependencies` | Project dependency edges |
| GET | `/projects/:ref/topology` | Topological order and cycles |
| GET | `/projects/:ref/readiness` | Project readiness report |
| GET/POST | `/projects/:ref/plans` | List / generate a plan |

## Plans

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/plans` | List |
| GET | `/plans/:ref` | Read with steps |
| POST | `/plans/:ref/approve` | Approve a non-blocked plan |

## Packages

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/packages` | List / create |
| GET | `/packages/:ref` | Read |
| PUT/PATCH | `/packages/:ref` | Update |
| POST | `/packages/:ref/status` | Transition status |
| GET | `/packages/:ref/dependencies` | Package dependency edges |
| GET | `/packages/:ref/readiness` | Readiness checks |
| POST | `/packages/:ref/preview` | Extract/map/transform/validate a preview without writing |
| POST | `/packages/:ref/validate` | Validate mappings, transformations and a sample |
| POST | `/packages/:ref/jobs` | Create a job (and submit it unless `mode: "VALIDATE"` or `submit: false`) |

## Definitions

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/definitions` | List / create |
| GET | `/definitions/:ref` | Read with mappings/transformations/rules |
| PUT/PATCH | `/definitions/:ref` | Update (DRAFT only) |
| POST | `/definitions/:ref/status` | `DRAFT` / `ACTIVE` / `INACTIVE` / `DEPRECATED` |
| POST | `/definitions/:ref/validate` | Validate mappings, transformations and rules |
| GET/POST | `/definitions/:ref/versions` | List / create a version |
| POST | `/definitions/:ref/jobs` | Create and submit a job from a definition |

## Jobs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/jobs` | List with filters |
| GET | `/jobs/:ref` | Read |
| GET | `/jobs/:ref/batches` | Batch ledger |
| GET | `/jobs/:ref/results` | Per-object results |
| GET | `/jobs/:ref/errors` | Structured error queue |
| GET | `/jobs/:ref/checkpoints` | Checkpoints |
| GET | `/jobs/:ref/lineage` | Migration audit / lineage entries for the job |
| POST | `/jobs/:ref/cancel` | Cancel a running/queued job |
| POST | `/jobs/:ref/pause` | Pause |
| POST | `/jobs/:ref/resume` | Resume |
| POST | `/jobs/:ref/retry` | Submit a retry of retryable failed records |
| POST | `/jobs/:ref/execute` | (Re)submit execution |
| POST | `/jobs/:ref/reconcile` | Run reconciliation synchronously |
| POST | `/jobs/:ref/submit-reconcile` | Submit reconciliation as a platform job |
| POST | `/jobs/:ref/files/retry` | Retry failed file migrations |

`POST /jobs/:ref` creation supports `Idempotency-Key` (header) or
`idempotency_key` (body); a repeated key returns the original job (`200`).

## Identifier & relationship mappings

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/identifier-mappings` | List / upsert a source→target identifier |
| POST | `/identifier-mappings/bulk` | Bulk upsert |
| GET | `/identifier-mappings/resolve` | Resolve by `source_system`, `source_object_type`, `source_object_id` |
| GET | `/relationship-mappings` | List relationship mappings |
| POST | `/relationships` | Migrate one relationship (`dry_run`) |
| POST | `/relationships/bulk` | Migrate many relationships |
| POST | `/relationships/retry` | Retry missing relationships |

## Files, reconciliation, statistics, audit

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/file-migrations` | List file/binary migration records |
| GET | `/reconciliations` | List reconciliation records |
| GET | `/reconciliations/:ref` | Read one |
| GET | `/reconciliations/:ref/exceptions` | Exception report |
| GET | `/statistics` | Per-run statistics snapshots |
| GET | `/audit` | Migration audit trail |
| GET | `/object-lineage?target_object_id=...` | Lineage of a migrated target object |

## Configuration & administration

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/configuration` | Effective per-tenant configuration |
| GET | `/configuration/:key` | Read one key |
| PUT | `/configuration/:key` | Set a key (validated bounds) |
| POST | `/maintenance` | Submit the maintenance job (prune checkpoints, resolve identifiers, recompute statistics) |
| POST | `/seed` | Install the demo onboarding estate (idempotent) |
