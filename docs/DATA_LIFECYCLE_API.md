# Data Lifecycle & Archival API

All routes require a bearer token and the permission listed against them. The
service is mounted at both `/api/lifecycle` and `/api/v1/lifecycle`. Responses are
JSON; list endpoints return `{ items, total, page, page_size }`. Errors use
`{ error, code?, details? }`.

Permission resource codes are `iam.data_lifecycle.*` (`overview`, `states`,
`policies`, `objects`, `eligibility`, `archive`, `restore`, `recovery`, `purge`,
`legal_holds`, `dependencies`, `jobs`, `metrics`, `admin`) and are granted through
IAM roles. The service never trusts a client-declared authorization.

Write operations that create work accept an `Idempotency-Key` header (or an
`idempotency_key` body field) so retries are safe.

## Vocabulary, health, metrics and providers

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/meta` | `iam.data_lifecycle.overview:read` |
| GET | `/api/v1/lifecycle/health` | `iam.data_lifecycle.metrics:read` |
| GET | `/api/v1/lifecycle/metrics` | `iam.data_lifecycle.metrics:read` |
| GET | `/api/v1/lifecycle/providers` | `iam.data_lifecycle.overview:read` |

`/meta` returns the vocabularies (states, tiers, retention bases, policy scopes,
legal-hold scopes, eligibility actions/results, restore strategies, provider
types, job types) and the `security_actions` the service enforces.

## States, transitions and tiers

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/states` | `iam.data_lifecycle.states:read` |
| POST | `/api/v1/lifecycle/states` | `iam.data_lifecycle.states:create` |
| GET | `/api/v1/lifecycle/states/:code` | `iam.data_lifecycle.states:read` |
| PUT/PATCH | `/api/v1/lifecycle/states/:code` | `iam.data_lifecycle.states:update` |
| GET | `/api/v1/lifecycle/states/:code/transitions` | `iam.data_lifecycle.states:read` |
| GET | `/api/v1/lifecycle/transitions` | `iam.data_lifecycle.states:read` |
| POST | `/api/v1/lifecycle/transitions` | `iam.data_lifecycle.states:create` |
| POST | `/api/v1/lifecycle/transitions/:id/status` | `iam.data_lifecycle.states:update` |
| GET | `/api/v1/lifecycle/tiers` | `iam.data_lifecycle.states:read` |
| PUT | `/api/v1/lifecycle/tiers/:stateCode` | `iam.data_lifecycle.states:update` |

## Retention policies

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/policies` | `iam.data_lifecycle.policies:read` |
| POST | `/api/v1/lifecycle/policies` | `iam.data_lifecycle.policies:create` |
| POST | `/api/v1/lifecycle/policies/resolve` | `iam.data_lifecycle.policies:read` |
| GET | `/api/v1/lifecycle/policies/:ref/versions` | `iam.data_lifecycle.policies:read` |
| GET | `/api/v1/lifecycle/policies/:ref` | `iam.data_lifecycle.policies:read` |
| PUT/PATCH | `/api/v1/lifecycle/policies/:ref` | `iam.data_lifecycle.policies:update` |
| POST | `/api/v1/lifecycle/policies/:ref/status` | `iam.data_lifecycle.policies:update` |

`/policies` filters with `status`, `scope_type`, `object_type`,
`lifecycle_state`, `q`, `page` and `page_size`. `/policies/resolve` is the policy
simulator: it returns the resolved policy, its match score and the candidates.

## Tracked objects (lifecycle ledger)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/objects` | `iam.data_lifecycle.objects:read` |
| POST | `/api/v1/lifecycle/objects` | `iam.data_lifecycle.objects:create` |
| GET | `/api/v1/lifecycle/objects/:objectType/:objectId` | `iam.data_lifecycle.objects:read` |
| GET | `/api/v1/lifecycle/objects/:objectType/:objectId/snapshot` | `iam.data_lifecycle.objects:read` |
| GET | `/api/v1/lifecycle/objects/:objectType/:objectId/history` | `iam.data_lifecycle.objects:read` |
| GET | `/api/v1/lifecycle/objects/:objectType/:objectId/dependencies` | `iam.data_lifecycle.dependencies:read` |
| GET | `/api/v1/lifecycle/objects/:objectType/:objectId/eligibility` | `iam.data_lifecycle.eligibility:read` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/state` | `iam.data_lifecycle.objects:execute` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/retention` | `iam.data_lifecycle.objects:execute` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/tier` | `iam.data_lifecycle.objects:execute` |

Object registration body:
`{ object_type, object_id, object_ref?, current_state?, classification?, subtype?, organization_id?, plant_id?, retention_anchor?, retention_basis?, data_tier? }`.
Registration is idempotent and never silently resets an existing object's state.

## Eligibility engine

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/api/v1/lifecycle/eligibility/check` | `iam.data_lifecycle.eligibility:read` |
| POST | `/api/v1/lifecycle/eligibility/batch` | `iam.data_lifecycle.eligibility:read` |
| GET | `/api/v1/lifecycle/eligibility/due` | `iam.data_lifecycle.eligibility:read` |

`/check` body: `{ object_type, object_id, action, force? }` where `action` is one
of `INACTIVE`, `ARCHIVE`, `COLD_STORAGE`, `PURGE`. It returns an explainable
result (`result`, `eligible`, `blocked`, `reasons[]`, resolved policy, retention
window, legal holds, dependencies and quality gate).

## Legal holds

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/legal-holds` | `iam.data_lifecycle.legal_holds:read` |
| POST | `/api/v1/lifecycle/legal-holds` | `iam.data_lifecycle.legal_holds:create` |
| GET | `/api/v1/lifecycle/legal-holds/:ref` | `iam.data_lifecycle.legal_holds:read` |
| POST | `/api/v1/lifecycle/legal-holds/:ref/release` | `iam.data_lifecycle.legal_holds:execute` |
| POST | `/api/v1/lifecycle/legal-holds/:ref/cancel` | `iam.data_lifecycle.legal_holds:execute` |

Create body: `{ code, name, reason?, scope_type, object_type?, object_ids?[],
scopes?[] }`. A legal hold blocks archive, purge and deletion until released or
cancelled.

## Dependencies

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/dependencies` | `iam.data_lifecycle.dependencies:read` |
| POST | `/api/v1/lifecycle/dependencies` | `iam.data_lifecycle.dependencies:create` |
| POST | `/api/v1/lifecycle/dependencies/refresh` | `iam.data_lifecycle.dependencies:execute` |
| POST | `/api/v1/lifecycle/dependencies/:id/resolve` | `iam.data_lifecycle.dependencies:execute` |

## Archive, restore, recovery and purge

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/archives` | `iam.data_lifecycle.archive:read` |
| POST | `/api/v1/lifecycle/archives` | `iam.data_lifecycle.archive:execute` |
| GET | `/api/v1/lifecycle/archives/:ref` | `iam.data_lifecycle.archive:read` |
| POST | `/api/v1/lifecycle/archives/:ref/verify` | `iam.data_lifecycle.archive:execute` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/archive` | `iam.data_lifecycle.archive:execute` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/cold-storage` | `iam.data_lifecycle.archive:execute` |
| GET | `/api/v1/lifecycle/restores` | `iam.data_lifecycle.restore:read` |
| POST | `/api/v1/lifecycle/restores` | `iam.data_lifecycle.restore:execute` |
| GET | `/api/v1/lifecycle/restores/:ref` | `iam.data_lifecycle.restore:read` |
| POST | `/api/v1/lifecycle/restores/:ref/execute` | `iam.data_lifecycle.restore:execute` |
| POST | `/api/v1/lifecycle/objects/:objectType/:objectId/restore` | `iam.data_lifecycle.restore:execute` |
| GET | `/api/v1/lifecycle/recoveries` | `iam.data_lifecycle.recovery:read` |
| POST | `/api/v1/lifecycle/recoveries` | `iam.data_lifecycle.recovery:execute` |
| GET | `/api/v1/lifecycle/recoveries/:ref` | `iam.data_lifecycle.recovery:read` |
| POST | `/api/v1/lifecycle/recoveries/:ref/execute` | `iam.data_lifecycle.recovery:execute` |
| GET | `/api/v1/lifecycle/purges` | `iam.data_lifecycle.purge:read` |
| GET | `/api/v1/lifecycle/purges/summary` | `iam.data_lifecycle.purge:read` |
| GET | `/api/v1/lifecycle/purges/:ref` | `iam.data_lifecycle.purge:read` |
| POST | `/api/v1/lifecycle/purges/evaluate` | `iam.data_lifecycle.purge:read` |
| POST | `/api/v1/lifecycle/purges` | `iam.data_lifecycle.purge:execute` |

Archive/restore/purge operations are blocked by legal holds and (for archive and
purge) by the optional quality gate. Restore verifies the archive checksum and
honours `conflict_strategy` (`FAIL`, `SKIP`, `RENAME`,
`OVERWRITE_IF_UNCHANGED`). Recovery is separate from restore: it targets data
after failure, corruption or storage loss.

## History, catalog integration and configuration

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/history` | `iam.data_lifecycle.objects:read` |
| GET | `/api/v1/lifecycle/catalog-types` | `iam.data_lifecycle.overview:read` |
| POST | `/api/v1/lifecycle/snapshots` | `iam.data_lifecycle.overview:read` |
| GET | `/api/v1/lifecycle/configuration` | `iam.data_lifecycle.admin:read` |
| PUT | `/api/v1/lifecycle/configuration/:key` | `iam.data_lifecycle.admin:update` |

`lifecycleSnapshot` exposes state, tier, retention, archive state, legal hold and
policy to the Data Catalog **without duplicating** catalog data.

## Jobs

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/lifecycle/jobs` | `iam.data_lifecycle.jobs:read` |
| GET | `/api/v1/lifecycle/jobs/:ref` | `iam.data_lifecycle.jobs:read` |
| POST | `/api/v1/lifecycle/jobs/evaluate` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/archive` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/cold-storage` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/restore` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/purge` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/recovery` | `iam.data_lifecycle.jobs:execute` |
| POST | `/api/v1/lifecycle/jobs/maintenance` | `iam.data_lifecycle.jobs:execute` |

Job submissions return `202` with the submitted platform job. They are executed
by the shared job worker, which registers the lifecycle handlers and runs a
periodic maintenance sweep.
