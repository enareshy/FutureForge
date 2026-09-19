# Effectivity & Versioning Kernel — Operations

This guide covers day-2 operation of the Effectivity & Versioning Kernel: boot
behaviour, background maintenance, permissions, monitoring and troubleshooting.

## Boot behaviour

`createApp(db)` calls `ensureVersioningFoundation(db)` on startup. The call is
idempotent and creates the effectivity-type catalogue, the default resolution
policy (`configuration > revision > serial > model > plant > unit > date >
default`), the versioning event types and the search registrations if they are
missing. It never blocks application boot. `seedDatabase(db)` additionally creates
the `iam.versioning.*` catalog resources, permission grants and a set of demo
objects (`PART-DEMO-DATE`, `PART-DEMO-SERIAL`, `PART-DEMO-PLANT`,
`PART-DEMO-MODEL`), the `VEHICLE` variant and the `CFG-DEMO-2026` configuration
context.

## Background maintenance

The job worker registers two versioning handlers and runs a periodic sweep:

- `VERSIONING_EXPIRE_EFFECTIVITY` — emit `EffectivityExpired` for ranges that
  ended.
- `VERSIONING_MAINTENANCE` — expire effectivity and prune resolution bookkeeping.

The worker also runs the same convergence on an interval controlled by
`VERSIONING_MAINTENANCE_MS` (default `30000`). Each sweep calls
`runVersioningMaintenance(db)` and logs a line when ranges expired or resolution
records were pruned:

```bash
# run the worker (versioning handlers are registered automatically)
npm run worker
```

Resolution results older than 30 days are pruned so resolution bookkeeping stays
bounded. Effectivity expiry is recorded once per definition.

## Permissions

Versioning access is governed by the `iam.versioning.*` resources:

- `iam.versioning` — module access.
- `iam.versioning.revisions` — revision management (read/create/update/delete/execute).
- `iam.versioning.versions` — version management.
- `iam.versioning.effectivities` — effectivity definitions and assignments.
- `iam.versioning.resolve` — as-of resolution (read/execute).
- `iam.versioning.baselines` — baseline management.
- `iam.versioning.snapshots` — historical snapshots.
- `iam.versioning.variants` — variant and option management.
- `iam.versioning.configurations` — configuration context management.
- `iam.versioning.policies` — resolution policy administration.
- `iam.versioning.metrics` — monitoring and metrics.

The seeded reader role can read revisions, versions, effectivities, baselines,
snapshots, variants, contexts and metrics and can execute resolution; revision,
policy and foundation administration are available to administrators.

## Monitoring

- `GET /api/versioning/health/ready` — readiness; `503` until ready.
- `GET /api/versioning/health/live` — liveness.
- `GET /api/versioning/metrics` — resolution counters (success, ambiguous,
  conflict, not-found), latency and revision/baseline/snapshot counts.
- `GET /api/versioning/dashboard` — aggregated summary with recent resolutions,
  upcoming/expired/open-ended revisions and revisions by status.

The Versioning console (`/versioning`) surfaces the same data across the Overview,
Revisions, Effectivities, Resolve, Policies, Baselines, Snapshots, Variants and
Contexts tabs.

## Operational tasks

### Resolve an object as-of a date

```bash
curl -sS -X POST http://localhost:3001/api/versioning/effectivity/resolve \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"objectType":"Part","objectId":"PART-1000","context":{"asOfDate":"2026-08-01"}}'
```

Check `resolutionStatus` before acting on the result: `RESOLVED` is safe to
consume, `AMBIGUOUS` and `CONFLICT` require a configuration change, and `NOT_FOUND`
means no effectivity applies.

### Inspect an object for overlaps and gaps

```bash
curl -sS "http://localhost:3001/api/versioning/effectivity/inspect?objectType=Part&objectId=PART-1000&asOf=2026-05-01" \
  -H "Authorization: Bearer $TOKEN"
```

### Freeze a baseline

```bash
curl -sS -X POST http://localhost:3001/api/versioning/baselines/BL-RELEASE/freeze \
  -H "Authorization: Bearer $TOKEN"
```

A frozen baseline is immutable; add objects before freezing.

### Expire effectivity on demand

```bash
curl -sS -X POST http://localhost:3001/api/versioning/effectivity/validate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"SERIAL-B","typeCode":"SERIAL_EFFECTIVITY","dimension":"serial","serialFrom":"0501","serialTo":"1000"}'
```

## Troubleshooting

| Symptom | Likely cause | Resolution |
| ------- | ------------ | ---------- |
| `409 AMBIGUOUS_RESOLUTION` | Two revisions match equally | Tighten effectivity, set a default revision, or use a policy with an explicit ambiguity strategy |
| `409 EFFECTIVITY_CONFLICT` | Ranged effectivity overlaps where not permitted | Adjust the ranges, mark a definition `overlapAllowed`, or use a policy with `allowOverlap` |
| `409 EFFECTIVITY_OVERLAP` on assignment | Two same-dimension definitions overlap on the same revision | Change the ranges or mark one as overlap-allowed |
| `404 NO_APPLICABLE_REVISION` | No effectivity matches the context | Verify the context dimensions and revision effective dates |
| `422 INVALID_EFFECTIVITY` / `INVALID_SERIAL_RANGE` | Inverted or malformed range | Ensure `effectiveFrom <= effectiveTo` and `serialFrom <= serialTo` |
| `409 BASELINE_IMMUTABLE` | Modifying a frozen baseline | Create a new baseline instead |
| `503` from `/health/ready` | The readiness check failed | Inspect the `metrics` and `error` fields in the response |
| Resolution results grow unbounded | The maintenance sweep is not running | Ensure `npm run worker` is alive and `VERSIONING_MAINTENANCE_MS` is set |

## Scaling notes

Resolution batch-loads revisions, assignments, definitions and values in a bounded
number of queries, so bulk resolution avoids N+1 access; callers should prefer the
bulk endpoint for product structures. SQLite serialises writers, so correctness
comes from transactions, optimistic `version` columns and unique constraints rather
than raw throughput. The engine holds no lock across an HTTP request, so moving to a
networked database later changes the connection, not the algorithm. Cacheable
resolution results are currently recorded for observability; callers that require
sub-millisecond lookups should cache by `objectType|objectId|context|policy`.
