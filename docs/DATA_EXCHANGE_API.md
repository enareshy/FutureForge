# Import & Export Framework — HTTP API

Base paths: `/api/data-exchange` and `/api/v1/data-exchange`. All endpoints require
authentication (Bearer token). Errors use the standardized shape
`{ "error": string, "code"?: string, "details"?: object }`. List endpoints return
`{ items, total, page, page_size }`.

Permission resources: `iam.data_exchange.{overview,imports,import_definitions,
exports,export_definitions,connectors,mapping,validation,reconciliation,templates,
history,jobs,metrics,admin}` with actions `read`, `create`, `update`, `execute`.

## Meta, health, metrics

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/meta` | Vocabulary: directions, connector types, formats, destinations, strategies, job types |
| GET | `/health` | Health checks and foundation counts |
| GET | `/metrics` | Operational snapshot |
| GET | `/connectors` | Connector catalogue (`items`, `types`) |

## Connector configurations & credentials

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/connector-configurations` | List / create |
| GET | `/connector-configurations/:ref` | Read |
| PUT/PATCH | `/connector-configurations/:ref` | Update |
| POST | `/connector-configurations/:ref/status` | Activate / deactivate |
| POST | `/connector-configurations/:ref/test` | Test connectivity |
| POST | `/connector-configurations/:ref/discover` | Discover source schema |
| POST | `/connector-configurations/test` | Test an unsaved configuration |
| GET/POST | `/credential-references` | Opaque `secret_ref` registry |
| POST | `/credential-references/:ref/status` | Set status |

## Import definitions

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/import-definitions` | List / create |
| GET | `/import-definitions/:ref` | Read (with children) |
| PUT/PATCH | `/import-definitions/:ref` | Update (DRAFT only) |
| POST | `/import-definitions/:ref/status` | `DRAFT` / `ACTIVE` / `INACTIVE` / `DEPRECATED` |
| GET/POST | `/import-definitions/:ref/versions` | List / create a version |
| GET | `/import-definitions/:ref/catalog` | Resolve catalog references |
| POST | `/import-definitions/:ref/validate` | Validate the definition |
| POST | `/import-definitions/:ref/preview` | Preview (`content`/`buffer`/`settings` inline or connector) |
| POST | `/import-definitions/:ref/run` | Create and run a job (`mode`, inline `content`) |

## Import jobs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/import-jobs` | List |
| GET | `/import-jobs/:ref` | Read |
| POST | `/import-jobs/:ref/run` | Re-run a job (`async: true` submits a platform job) |
| POST | `/import-jobs/:ref/reconcile` | Reconcile |
| POST | `/import-jobs/:ref/retry` | Retry failed records |
| POST | `/import-jobs/:ref/cancel` | Cancel |
| GET | `/import-jobs/:ref/records` | Record results |
| GET | `/import-jobs/:ref/errors` | Errors |
| GET | `/import-errors` | Errors across jobs |

`Idempotency-Key` (header or `idempotency_key`/`idempotencyKey` body field) makes a
repeated run return the original job.

## Export definitions

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/export-definitions` | List / create |
| GET | `/export-definitions/:ref` | Read (with children) |
| PUT/PATCH | `/export-definitions/:ref` | Update (DRAFT only) |
| POST | `/export-definitions/:ref/status` | Set status |
| GET/POST | `/export-definitions/:ref/versions` | List / create a version |
| GET | `/export-definitions/:ref/catalog` | Resolve catalog references |
| POST | `/export-definitions/:ref/validate` | Validate |
| POST | `/export-definitions/:ref/preview` | Preview rows and fields |
| POST | `/export-definitions/:ref/run` | Create and run an export job |

## Export jobs & results

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/export-jobs` | List |
| GET | `/export-jobs/:ref` | Read |
| POST | `/export-jobs/:ref/run` | Run |
| POST | `/export-jobs/:ref/cancel` | Cancel |
| GET | `/export-jobs/:ref/results` | Results for the job |
| GET | `/export-results` | Results across jobs |
| GET | `/export-results/:ref/download` | Authorized artifact download |

## Templates, jobs, history, configuration

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | `/templates` | List / create |
| GET | `/templates/:ref` | Read |
| PUT/PATCH | `/templates/:ref` | Update |
| POST | `/templates/:ref/status` | Set status |
| POST | `/templates/:ref/versions` | Create a version |
| POST | `/templates/:ref/validate` | Validate |
| GET | `/jobs` | Platform exchange jobs |
| GET | `/history` | Unified import/export history |
| GET | `/configuration` | Tenant configuration |
| PUT | `/configuration/:key` | Set a validated configuration value |

## Example

```bash
# Preview inline CSV through an active import definition
curl -sS -X POST "$BASE/api/v1/data-exchange/import-definitions/PART_IMPORT/preview" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"content":"part_number,part_name,part_category\nPART-1,Pump A,hydraulic\n"}'

# Run the import (idempotent)
curl -sS -X POST "$BASE/api/v1/data-exchange/import-definitions/PART_IMPORT/run" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: run-1" -H "Content-Type: application/json" \
  -d '{"content":"part_number,part_name,part_category\nPART-1,Pump A,hydraulic\n","mode":"IMPORT"}'

# Run an export and download the artifact
curl -sS -X POST "$BASE/api/v1/data-exchange/export-definitions/PART_EXPORT/run" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
curl -sS "$BASE/api/v1/data-exchange/export-results/<RESULT_REF>/download" \
  -H "Authorization: Bearer $TOKEN" -o export.csv
```
