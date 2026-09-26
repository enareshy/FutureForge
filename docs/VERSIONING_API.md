# Effectivity & Versioning Kernel — HTTP API

All routes are mounted under `/api/versioning` with a versioned alias at
`/api/v1/versioning`; the core revision/version/effectivity/resolution routes are
also reachable directly under `/api/v1`. Every route except the health probes
requires a bearer token. Permission resources follow the `iam.versioning.*`
catalogue; the action required is shown per route.

## Metadata

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/meta` | `iam.versioning:read` | Enums, effectivity types and core precedence |
| GET | `/effectivity-types` | `iam.versioning:read` | List the effectivity-type catalogue (`dimension`, `status`) |

## Revisions

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/revisions` | `iam.versioning.revisions:read` | List revisions (`objectType`, `objectId`, `status`, paging) |
| POST | `/revisions` | `iam.versioning.revisions:create` | Create a revision |
| GET | `/revisions/:ref` | `iam.versioning.revisions:read` | Revision by reference or id |
| PUT/PATCH | `/revisions/:ref` | `iam.versioning.revisions:update` | Update revision metadata |
| DELETE | `/revisions/:ref` | `iam.versioning.revisions:delete` | Delete a revision |
| POST | `/revisions/:ref/activate` | `iam.versioning.revisions:execute` | Activate a revision |
| POST | `/revisions/:ref/supersede` | `iam.versioning.revisions:execute` | Supersede a revision |
| POST | `/revisions/:ref/retire` | `iam.versioning.revisions:execute` | Retire a revision |
| POST | `/revisions/:ref/default` | `iam.versioning.revisions:execute` | Mark a revision as the object default |
| GET | `/revisions/:ref/history` | `iam.versioning.revisions:read` | Audit history |
| GET | `/revisions/:ref/compare/:other` | `iam.versioning.revisions:read` | Compare two revisions |
| GET | `/revisions/:ref/relationships` | `iam.versioning.revisions:read` | List revision relationships |
| POST | `/revisions/:ref/relationships` | `iam.versioning.revisions:update` | Create a relationship |
| DELETE | `/revisions/:ref/relationships/:id` | `iam.versioning.revisions:update` | Delete a relationship |

## Versions

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/revisions/:ref/versions` | `iam.versioning.versions:read` | List versions of a revision |
| POST | `/revisions/:ref/versions` | `iam.versioning.versions:create` | Create a version |
| GET | `/versions/:ref` | `iam.versioning.versions:read` | Version by reference or id |
| PUT/PATCH | `/versions/:ref` | `iam.versioning.versions:update` | Update a version |
| DELETE | `/versions/:ref` | `iam.versioning.versions:delete` | Delete a version |
| POST | `/versions/:ref/activate` | `iam.versioning.versions:execute` | Activate a version |
| POST | `/versions/:ref/supersede` | `iam.versioning.versions:execute` | Supersede a version |
| POST | `/versions/:ref/default` | `iam.versioning.versions:execute` | Mark a version as default |
| GET | `/versions/:ref/history` | `iam.versioning.versions:read` | Audit history |
| GET | `/versions/:ref/compare/:other` | `iam.versioning.versions:read` | Compare two versions |

## Effectivities

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/effectivities` | `iam.versioning.effectivities:read` | List definitions (`dimension`, `typeCode`, paging) |
| POST | `/effectivities` | `iam.versioning.effectivities:create` | Create a definition |
| POST | `/effectivities/validate` | `iam.versioning.effectivities:read` | Validate a definition without saving |
| GET | `/effectivities/:ref` | `iam.versioning.effectivities:read` | Definition by reference or id |
| PUT/PATCH | `/effectivities/:ref` | `iam.versioning.effectivities:update` | Update a definition |
| DELETE | `/effectivities/:ref` | `iam.versioning.effectivities:delete` | Delete a definition and its assignments |
| GET | `/effectivities/:ref/assignments` | `iam.versioning.effectivities:read` | Assignments of a definition |
| POST | `/effectivities/:ref/assignments` | `iam.versioning.effectivities:update` | Assign a definition to an object/revision/version |
| GET | `/assignments` | `iam.versioning.effectivities:read` | List all assignments |
| DELETE | `/assignments/:ref` | `iam.versioning.effectivities:delete` | Remove an assignment |
| GET | `/effectivity/inspect` | `iam.versioning.effectivities:read` | Inspect overlaps, gaps and open-ended ranges |

## Resolution

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| POST | `/effectivity/resolve` | `iam.versioning.resolve:execute` | Resolve one object as-of a context |
| POST | `/effectivity/resolve/bulk` | `iam.versioning.resolve:execute` | Resolve many objects without N+1 queries |
| POST | `/effectivity/validate` | `iam.versioning.effectivities:read` | Validate an effectivity payload |

Resolve request body:

```json
{
  "objectType": "Part",
  "objectId": "PART-1000",
  "policy": "default",
  "context": {
    "asOfDate": "2026-08-01",
    "serialNumber": "0750",
    "plantId": "PLANT02",
    "modelId": "MODEL-Z",
    "variantId": "VEHICLE",
    "configurationId": "CFG-DEMO-2026"
  }
}
```

The response carries `resolutionStatus`
(`RESOLVED | AMBIGUOUS | NOT_FOUND | INVALID_CONTEXT | CONFLICT`),
`resolutionReason`, the resolved `revisionCode`/`versionNumber`, the candidate
scores and any conflicts. Non-resolved outcomes include a stable `code` such as
`NO_APPLICABLE_REVISION`, `AMBIGUOUS_RESOLUTION`, `EFFECTIVITY_CONFLICT` or
`INVALID_EFFECTIVITY_CONTEXT`.

## Resolution policies

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/resolution-policies` | `iam.versioning.policies:read` | List policies |
| POST | `/resolution-policies` | `iam.versioning.policies:create` | Create a policy |
| GET | `/resolution-policies/:ref` | `iam.versioning.policies:read` | Policy by code or id |
| PUT/PATCH | `/resolution-policies/:ref` | `iam.versioning.policies:update` | Update a policy |
| DELETE | `/resolution-policies/:ref` | `iam.versioning.policies:delete` | Delete a non-default policy |

## Baselines

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/baselines` | `iam.versioning.baselines:read` | List baselines |
| POST | `/baselines` | `iam.versioning.baselines:create` | Create and capture a baseline |
| GET | `/baselines/:ref` | `iam.versioning.baselines:read` | Baseline by reference or id |
| DELETE | `/baselines/:ref` | `iam.versioning.baselines:delete` | Delete a baseline |
| POST | `/baselines/:ref/objects` | `iam.versioning.baselines:update` | Add objects |
| DELETE | `/baselines/:ref/objects/:objectType/:objectId` | `iam.versioning.baselines:update` | Remove an object |
| POST | `/baselines/:ref/freeze` | `iam.versioning.baselines:execute` | Freeze (lock) a baseline |
| GET | `/baselines/:ref/compare/:other` | `iam.versioning.baselines:read` | Compare two baselines |
| GET | `/baselines/:ref/restore` | `iam.versioning.baselines:read` | Reproduce the captured pairs |

## Snapshots

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/snapshots` | `iam.versioning.snapshots:read` | List snapshots |
| POST | `/snapshots` | `iam.versioning.snapshots:create` | Capture an immutable snapshot |
| GET | `/snapshots/:ref` | `iam.versioning.snapshots:read` | Snapshot by reference or id |
| DELETE | `/snapshots/:ref` | `iam.versioning.snapshots:delete` | Delete a snapshot |
| POST | `/snapshots/:ref/archive` | `iam.versioning.snapshots:update` | Archive a snapshot |
| GET | `/snapshots/:ref/compare/:other` | `iam.versioning.snapshots:read` | Compare two snapshots |
| GET | `/snapshots/:ref/reconstruct` | `iam.versioning.snapshots:read` | Reconstruct the captured state |

## Variants

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/variants` | `iam.versioning.variants:read` | List variants |
| POST | `/variants` | `iam.versioning.variants:create` | Create a variant with options/rules |
| GET | `/variants/:ref` | `iam.versioning.variants:read` | Variant by reference or id |
| PUT/PATCH | `/variants/:ref` | `iam.versioning.variants:update` | Update a variant |
| POST | `/variants/:ref/options` | `iam.versioning.variants:update` | Add/update an option |
| POST | `/variants/:ref/rules` | `iam.versioning.variants:update` | Add/update a rule |
| POST | `/variants/:ref/evaluate` | `iam.versioning.variants:read` | Evaluate applicability |
| GET | `/variants/:ref/history` | `iam.versioning.variants:read` | Audit history |

## Configuration contexts

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/configuration-contexts` | `iam.versioning.configurations:read` | List contexts |
| POST | `/configuration-contexts` | `iam.versioning.configurations:create` | Create a context |
| GET | `/configuration-contexts/:ref` | `iam.versioning.configurations:read` | Context by reference or id |
| PUT/PATCH | `/configuration-contexts/:ref` | `iam.versioning.configurations:update` | Update a context |
| DELETE | `/configuration-contexts/:ref` | `iam.versioning.configurations:delete` | Delete a context |

## Monitoring

| Method | Path | Permission | Description |
| ------ | ---- | ---------- | ----------- |
| GET | `/metrics` | `iam.versioning.metrics:read` | Resolution/revision/baseline counters and latency |
| GET | `/dashboard` | `iam.versioning.metrics:read` | Aggregated operational dashboard |
| GET | `/health/live` | none | Liveness probe |
| GET | `/health/ready` | none | Readiness probe; `503` until ready |

## Errors

Errors use the platform envelope. Versioning failures include a stable `code` such
as `REVISION_NOT_FOUND`, `VERSION_NOT_FOUND`, `INVALID_REVISION`,
`INVALID_VERSION`, `INVALID_EFFECTIVITY`, `INVALID_EFFECTIVITY_CONTEXT`,
`INVALID_SERIAL_RANGE`, `EFFECTIVITY_OVERLAP`, `EFFECTIVITY_CONFLICT`,
`NO_APPLICABLE_REVISION`, `AMBIGUOUS_RESOLUTION`, `BASELINE_NOT_FOUND`,
`BASELINE_IMMUTABLE`, `SNAPSHOT_NOT_FOUND`, `VARIANT_NOT_FOUND`,
`INVALID_RESOLUTION_POLICY`, `INVALID_RELATIONSHIP` or `UNAUTHORIZED_OPERATION`.

```json
{
  "error": "Effectivity ranges overlap where overlap is not permitted",
  "code": "EFFECTIVITY_OVERLAP",
  "details": { "definition": "SERIAL-B", "conflicts_with": "SERIAL-A", "dimension": "serial" }
}
```
