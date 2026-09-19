# Enterprise Reference Data Management — Operations

This guide covers day-2 operation of Enterprise Reference Data Management (ERDM):
bootstrapping, permissions, maintenance, monitoring and troubleshooting.

## Bootstrapping

The foundation is idempotent and runs automatically at application boot
(`ensureReferenceFoundation`) and during database seeding. It installs:

- the `reference_cache_epoch` row (epoch 0),
- a default scope policy per tenant (`PLANT -> ORGANIZATION -> TENANT -> GLOBAL`),
- the mandatory domain catalogue (Unit of Measure, Currency, Country, Language,
  Time Zone, Plant Type, Product Category, Material Type, Document Type, Industry
  Code, Standard, Status Code, Reason Code) with a v1 governance policy for each,
- the 19 `Reference*` domain event types,
- the `reference_item` search registration per tenant,
- a demonstration set of governed values for operator onboarding.

Re-running never duplicates data. To seed an existing database manually:

```bash
node server/seed.js
```

## Permissions

Authorization uses the `iam.reference` root plus these child resources:

```
iam.reference.domains      iam.reference.items        iam.reference.codes
iam.reference.aliases      iam.reference.translations iam.reference.hierarchy
iam.reference.relationships iam.reference.scopes      iam.reference.versions
iam.reference.approvals    iam.reference.governance   iam.reference.import
iam.reference.export       iam.reference.resolve      iam.reference.metrics
```

Platform and IAM administrators receive full grants. The `app.reader` role is
granted read access to domains, values, metadata and resolution, plus `execute`
on `iam.reference.resolve`.

## Maintenance job

The background worker registers the `REFERENCE_MAINTENANCE` handler
(`registerReferenceHandlers`) which converges the reference search index and
prunes expired export artifacts. Ensure the worker is running:

```bash
node scripts/job-worker.js
```

## Monitoring

- `GET /api/reference-data/metrics` — domain/value/code/alias/translation/version
  totals and status breakdowns, plus the current cache epoch.
- `GET /api/reference-data/dashboard` — top domains, recently updated values and
  pending approvals.
- `GET /api/reference-data/health/ready` — readiness summary; returns `503` when
  unhealthy.

Watch `pending_approvals` for a growing backlog, and `retired_items` for catalogue
growth that may need archiving/export.

## Cache and invalidation

Resolution results are cached in-process keyed by
`(cache_epoch, tenant, request)`. Every governed mutation bumps the monotonic
`reference_cache_epoch`, so stale values are never served. Multiple application
instances each hold their own cache; because the epoch is read from the database,
an epoch change on any instance invalidates reads everywhere. No manual cache
flush is required.

## Import and export

- `POST /imports` stages and validates rows; invalid input performs no writes.
- `POST /imports/:ref/commit` commits a validated import and is safe to retry
  after a failed validation (re-submit, then commit).
- `POST /exports` produces a JSON/CSV/TSV artifact; `GET /exports/:ref/download`
  streams it. Export artifacts expire and are pruned by the maintenance job.

## Backup and retention

ERDM data lives entirely in the `reference_*` tables. Standard database backups
capture domains, governance versions, values, versions, codes, aliases,
translations, hierarchy, relationships, scope policies, approvals, ownership
history, change requests and import/export records. Governance and item versions
are append-only, so restoring an older backup is the supported rollback path for
policy mistakes.

## Troubleshooting

- **`REFERENCE_VALUE_NOT_FOUND`** — no effective, in-scope value matched. Confirm
  the domain code, effective dates and supplied scope context (tenant/plant).
- **`REFERENCE_APPROVAL_REQUIRED`** — the domain policy requires approval before
  activation. Submit an approval (`POST /items/:ref/approvals`) and record a
  decision.
- **`REFERENCE_AMBIGUOUS_VALUE`** — two values tie on precedence. Set the scope
  policy `conflict_strategy` to `highest_precedence` or `latest_version`, or
  remove the duplicate.
- **`REFERENCE_DOMAIN_NOT_FOUND`** — the domain code is unknown or not active;
  create/activate it or check the code.
- **Duplicate `code` conflict** — a value with the same code already exists in the
  same scope. Use a different scope, or change the domain `code_reuse_policy`.
- **Hierarchy cycle** — the requested edge would create a loop; rebuild the
  intended parent/child direction.

## Changing the scope precedence

Precedence is configuration, not code. Update the tenant's scope policy via
`PATCH /api/reference-data/scope-policies/:ref` (or create a new default) and the
resolution engine picks it up immediately; the cache epoch is bumped on change.
