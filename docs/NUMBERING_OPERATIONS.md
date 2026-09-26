# Enterprise Numbering & Identifier Service — Operations

This guide covers day-2 operation of the Numbering & Identifier Service: boot
behaviour, background maintenance, permissions, monitoring and troubleshooting.

## Boot behaviour

`createApp(db)` calls `ensureNumberingFoundation(db)` on startup. The call is
idempotent and creates the default object types, scope dimensions and system tokens if
they are missing. It never blocks application boot. `seedDatabase(db)` additionally
creates the catalog resources, permission grants and the ten example schemes
(`PART_STANDARD`, `PRODUCT_STANDARD`, `DOCUMENT_CONTROLLED`, `BOM_STANDARD`,
`DRAWING_STANDARD`, `SPECIFICATION_STANDARD`, `CHANGE_REQUEST`, `SUPPLIER_STANDARD`,
`CUSTOMER_STANDARD`, `MATERIAL_STANDARD`).

## Background maintenance

The job worker registers two numbering handlers and runs a periodic sweep:

- `NUMBERING_EXPIRE_RESERVATIONS` — expire overdue reservations.
- `NUMBERING_MAINTENANCE` — expire reservations and prune stale idempotency records.

The worker also runs the same convergence on an interval controlled by
`NUMBERING_MAINTENANCE_MS` (default `30000`). Each sweep calls
`runNumberingMaintenance(db)` and logs a line when reservations expired or
idempotency records were pruned:

```bash
# run the worker (numbering handlers are registered automatically)
npm run worker
```

Idempotency records older than 14 days whose allocation is terminal are removed, so
replay bookkeeping stays bounded.

## Permissions

Numbering access is governed by the `iam.numbering.*` resources:

- `iam.numbering` — module access.
- `iam.numbering.schemes` — scheme administration (read/create/update/delete/execute).
- `iam.numbering.objecttypes` — object-type administration.
- `iam.numbering.sequences` — sequence administration and reset.
- `iam.numbering.allocations` — allocation history.
- `iam.numbering.generate` — generate and preview.
- `iam.numbering.reserve` — reserve.
- `iam.numbering.consume` — consume.
- `iam.numbering.release` — release and cancel.
- `iam.numbering.manual` — manual numbers.
- `iam.numbering.metrics` — monitoring and metrics.

The seeded reader role can read schemes, allocations, sequences, object types and
metrics and can generate/reserve; scheme administration, manual numbering and
sequence reset are available to administrators.

## Monitoring

- `GET /api/numbering/health` — composite health; `503` when unhealthy.
- `GET /api/numbering/health/ready` and `/health/live` — readiness and liveness.
- `GET /api/numbering/metrics` — scheme and allocation counters, generation latency.
- `GET /api/numbering/dashboard` — aggregated operational summary.

The Numbering console (`/numbering`) surfaces the same data in the Overview,
Schemes, Generate, Allocations and Sequences tabs.

## Operational tasks

### Expire reservations on demand

```bash
# expire up to 200 overdue reservations
curl -sS -X POST http://localhost:3001/api/numbering/maintenance/expire \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"limit":200}'
```

### Reset a sequence

Resetting is an administrative action; use it when a scheme must restart at a known
value after a data migration.

```bash
curl -sS -X POST http://localhost:3001/api/numbering/sequences/12/reset \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"startValue":1,"reason":"post-migration"}'
```

### Retire a scheme

Retiring preserves history and stops new allocations under that scheme. Deleting is
only allowed for draft/inactive schemes that have never issued a number.

```bash
curl -sS -X POST http://localhost:3001/api/numbering/schemes/OLD_SCHEME/retire \
  -H "Authorization: Bearer $TOKEN"
```

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `409 AMBIGUOUS_SCHEME` | Two schemes apply equally to the request | Give one a higher priority, mark a default, or pass an explicit `schemeCode` |
| `409 SEQUENCE_EXHAUSTED` | The counter reached `maxValue` | Raise `maxValue` (creates a new scheme version) or widen the pattern |
| `409 NUMBER_ALREADY_EXISTS` | A manual number or reuse rule collided | Choose another value or enable an appropriate reuse policy |
| `503` from `/health` | The readiness check failed | Inspect the `metrics` and `error` fields in the response |
| Reservations stay `reserved` | The maintenance sweep is not running | Ensure `npm run worker` is alive and `NUMBERING_MAINTENANCE_MS` is set |
| Numbers reset unexpectedly | A reset-scoped period rolled over | Confirm the scheme `reset_policy` and the request date |

## Scaling notes

SQLite serialises writers, so the compare-and-swap update and the unique
`uniqueness_key` index give correctness rather than raw throughput. The design keeps
all mutable state in narrow, indexed rows and never holds a lock across an HTTP
request, so moving to a networked database later changes the connection, not the
algorithm. The `nextNumber` SDK helper performs a full transaction per call; batch
callers should keep transactions short and rely on idempotency keys for retries.
