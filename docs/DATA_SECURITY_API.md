# Data Security & Entitlement API

All routes require a bearer token and the permission listed against them.
Responses are JSON. Errors use `{ error, code?, details? }`.

## Vocabulary and overview

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/security/vocabulary` | `iam.security.console:read` | Actions, scopes, subjects, classifications, field effects, masking strategies and reason codes |
| GET | `/api/v1/security/overview` | `iam.security.console:read` | Counts per rule family, enforcement distribution and recent decision summary |
| POST | `/api/v1/security/cache/invalidate` | `iam.security.console:execute` | Bump the tenant cache epoch (`{ scope }`) |

## Object type registration

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/object-types` | `iam.security.objecttypes:read` |
| POST | `/api/v1/security/object-types` | `iam.security.objecttypes:create` |
| PUT | `/api/v1/security/object-types/:objectType` | `iam.security.objecttypes:update` |
| POST | `/api/v1/security/object-types/:objectType/status` | `iam.security.objecttypes:update` |

Body: `{ object_type, enforcement: tenant|entitlement|policy, permission_resource?, description? }`.

## Policies

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/policies` | `iam.security.policies:read` |
| GET | `/api/v1/security/policies/:id` | `iam.security.policies:read` |
| POST | `/api/v1/security/policies` | `iam.security.policies:create` |
| PUT | `/api/v1/security/policies/:id` | `iam.security.policies:update` |
| POST | `/api/v1/security/policies/:id/status` | `iam.security.policies:update` |

Create body:

```json
{
  "code": "sso_only_report",
  "name": "SSO only report access",
  "scope": "object_type",
  "subject_type": "everyone",
  "subject_id": 0,
  "resource_type": "report",
  "action": "read",
  "effect": "allow",
  "priority": 500,
  "condition": { "field": "request.authentication_method", "operator": "eq", "value": "sso" },
  "rules": [{ "rule_type": "masking", "field": "attributes.cost", "masking_strategy": "REDACT" }]
}
```

## Entitlements

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/entitlements` | `iam.security.entitlements:read` |
| POST | `/api/v1/security/entitlements` | `iam.security.entitlements:create` |
| PUT | `/api/v1/security/entitlements/:id` | `iam.security.entitlements:update` |
| POST | `/api/v1/security/entitlements/:id/status` | `iam.security.entitlements:update` |

Body: `{ subject_type, subject_id, resource_type, resource_id?, action, effect, scope, classification?, priority?, condition? }`.

## Field security and masking

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/field-rules` | `iam.security.fields:read` |
| POST | `/api/v1/security/field-rules` | `iam.security.fields:create` |
| PUT | `/api/v1/security/field-rules/:id` | `iam.security.fields:update` |
| POST | `/api/v1/security/field-rules/:id/status` | `iam.security.fields:update` |
| GET | `/api/v1/security/masking-rules` | `iam.security.fields:read` |
| POST | `/api/v1/security/masking-rules` | `iam.security.fields:create` |
| POST | `/api/v1/security/masking-rules/:id/status` | `iam.security.fields:update` |

Create field rule body:

```json
{
  "object_type": "object",
  "field_name": "attributes.cost",
  "action": "read",
  "subject_type": "group",
  "subject_id": 4,
  "effect": "mask",
  "masking_strategy": "PARTIAL",
  "masking_config": { "visible_start": 2, "visible_end": 0, "mask_char": "*" }
}
```

## Classification security

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/classification-rules` | `iam.security.classifications:read` |
| POST | `/api/v1/security/classification-rules` | `iam.security.classifications:create` |
| POST | `/api/v1/security/classification-rules/:id/status` | `iam.security.classifications:update` |

Body: `{ classification, subject_type, subject_id?, action, resource_type?, effect, priority? }`.

## Organization and plant security

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/api/v1/security/organization-rules` | `iam.security.organizations:read` |
| POST | `/api/v1/security/organization-rules` | `iam.security.organizations:create` |
| POST | `/api/v1/security/organization-rules/:id/status` | `iam.security.organizations:update` |
| GET | `/api/v1/security/plant-rules` | `iam.security.organizations:read` |
| POST | `/api/v1/security/plant-rules` | `iam.security.organizations:create` |
| POST | `/api/v1/security/plant-rules/:id/status` | `iam.security.organizations:update` |

Organization body: `{ subject_type, subject_id?, resource_type?, action, organization_id, scope_mode, include_descendants, effect, priority? }`.

Plant body: `{ subject_type, subject_id?, resource_type?, action, plant_id, include_descendants, effect, priority? }`.

## Authorization debugger

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/security/decisions` | `iam.security.decisions:read` | Recent decisions (`?user_id`, `?decision`, `?limit`) |
| GET | `/api/v1/security/context/:userId` | `iam.security.decisions:read` | Effective security context for a user (`?organization_id`) |
| POST | `/api/v1/security/evaluate` | `iam.security.decisions:read` | Explain a decision |
| POST | `/api/v1/security/evaluate/batch` | `iam.security.decisions:read` | Explain up to 500 decisions in one call |
| POST | `/api/v1/authorization/check` | `iam.security.decisions:read` | Canonical single check (`subject`, `action`, `resource`) |
| POST | `/api/v1/authorization/batch-check` | `iam.security.decisions:read` | Canonical batch check |

Evaluate body:

```json
{
  "user_id": 7,
  "action": "read",
  "resource_type": "object",
  "resource_id": "OBJ-1",
  "organization_id": 3,
  "classification": "confidential"
}
```

Response:

```json
{
  "allowed": false,
  "decision": "deny",
  "reason": "CLASSIFICATION_DENIED",
  "message": "Classification rules deny access to this resource",
  "enforcement": "entitlement",
  "steps": [
    { "step": "tenant", "passed": true, "reason": null },
    { "step": "rbac", "passed": true, "reason": "RBAC_ALLOWED" },
    { "step": "classification", "passed": false, "reason": "CLASSIFICATION_DENIED" }
  ],
  "fields": [{ "field": "attributes.cost", "effect": "mask", "strategy": "PARTIAL" }],
  "cached": false,
  "durationMs": 4
}
```

## Batch authorization

Lists, exports and dashboards evaluate many resources at once. Batch endpoints run each request through the same deterministic engine and preserve input order, so results can be zipped straight back to rows. A batch is capped at 500 requests.

```http
POST /api/v1/security/evaluate/batch
POST /api/v1/authorization/batch-check
```

```json
{
  "requests": [
    { "action": "read", "resource_type": "object", "resource_id": "OBJ-1" },
    { "action": "read", "resource_type": "object", "resource_id": "OBJ-2" }
  ]
}
```

Response:

```json
{
  "count": 2,
  "decisions": [
    { "allowed": true, "decision": "allow", "reason": "RBAC_ALLOWED", "resource": { "type": "object", "id": "OBJ-1" } },
    { "allowed": false, "decision": "deny", "reason": "CLASSIFICATION_DENIED", "resource": { "type": "object", "id": "OBJ-2" } }
  ]
}
```

The canonical `/api/v1/authorization/check` and `/api/v1/authorization/batch-check` surfaces accept `{ "subject": <user id>, "action": "read", "resource": { "type": "object", "id": "OBJ-1" } }` and delegate to the same engine. RBAC actions are case-insensitive; rules store lower-case actions.

## Canonical entitlement aliases

`GET`/`POST /api/v1/entitlements` and `PUT /api/v1/entitlements/:id` are aliases for `/api/v1/security/entitlements`.

## Programmatic use

```js
import * as security from "./services/security/index.js";

const decision = security.authorizeRequest(db, actor, {
  action: "read",
  resource: { type: "object", id, organizationId, classification },
  options: { tenantId, correlationId },
});

if (!decision.allowed) throw Object.assign(new Error(decision.message), { status: 403 });

const safe = security.maskWithDecision(document, decision);
```
