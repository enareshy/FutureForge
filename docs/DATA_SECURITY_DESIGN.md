# Data Security & Entitlement Model Design

The Data Security & Entitlement Model is the single centralized authorization
platform service. It extends the existing role based permission model
(`docs/AUTHORIZATION_DESIGN.md`) with object, field, row, organization, plant
and classification security plus data masking, and exposes ABAC-ready policy
extension points. Business modules register their object types and consume the
decision API; they never implement their own authorization engine and never
duplicate security filtering.

Related documents: `docs/AUTHORIZATION_DESIGN.md`, `docs/IAM_DESIGN.md`,
`docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`,
`docs/SEARCH_FOUNDATION_DESIGN.md`, `docs/AUDIT_DESIGN.md` and the HTTP
reference `docs/DATA_SECURITY_API.md`.

## 1. Module boundaries

| Concern | Owner |
| --- | --- |
| Security context derivation, decisions, policies, entitlements | Data Security service |
| Roles, permissions, resource catalogue, grants | IAM / Authorization |
| Organization, plant and site hierarchy | Organization Management |
| Active directory / SSO identity | Authentication |
| Audit trail of denials and administration | Audit & History |
| Security domain events | Event & Messaging framework |
| Object type registration and row filtering | consuming module + Search/Object Framework |

## 2. Decision model

Every authorization request is a tuple **Subject + Action + Resource +
Context** and resolves to one of `ALLOW`, `DENY` or `MASK`.

```
SecurityContext
  tenantId              server-derived tenant
  userId                subject
  roles[]               effective role codes (with organization)
  groups[]              effective group ids
  organizations[]       organization ids including ancestors
  plants[]              plant / site ids
  permissions[]         effective permission codes
  authenticationMethod  password | sso | api-key | ...
  sessionId             session reference
  clientApplication     calling application
  correlationId         request correlation id
  attributes{}          trusted extra attributes (employee id, email, ...)
```

The context is always rebuilt from the session/user record. Client supplied
tenant, role, permission or organization claims are ignored.

### 2.1 Conflict resolution

Deterministic and documented:

```
explicit DENY  >  explicit ALLOW  >  inherited / RBAC ALLOW  >  default DENY
```

An explicit `ALLOW` with a strictly higher priority than every matching `DENY`
overrides it. Decisions carry a stable `reason` code:

`TENANT_DENIED`, `RBAC_DENIED`, `RBAC_ALLOWED`, `ORGANIZATION_DENIED`,
`PLANT_DENIED`, `OBJECT_DENIED`, `CLASSIFICATION_DENIED`, `FIELD_DENIED`,
`POLICY_ALLOWED`, `POLICY_DENIED`, `ENTITLEMENT_ALLOWED`,
`ENTITLEMENT_DENIED`, `DEFAULT_DENY`.

Every decision returns the ordered evaluation `steps` so an auditor can
reconstruct exactly which dimension passed or failed.

## 3. Security dimensions

1. **RBAC** — delegated to `checkPermission` (resource + action + organization
   ancestry). The object type registration maps to an IAM permission resource.
2. **Object security** — explicit entitlements at object type or single object
   (`scope = object`) granularity, allow or deny.
3. **Organization security** — rules with `scope_mode` `own`, `specific`,
   `self_and_descendants`, `include_descendants` or `cross`. A resource in an
   organization that no applicable rule covers is denied only when allowance is
   not established by another explicit layer.
4. **Plant security** — the same model keyed by plant/site (`site_id` on the
   search index).
5. **Classification security** — rules over `public`, `internal`,
   `confidential`, `restricted`, optionally scoped to an object type.
6. **Field security** — per object type/field/action rules with effects
   `allow`, `deny`, `hide` or `mask`.
7. **Masking** — strategies `HIDE`, `NULL`, `PARTIAL`, `REDACT`, `HASH`,
   `FIXED_MASK`, `CUSTOM`. Masking runs server-side before serialization and
   supports dotted field paths (`attributes.cost`).
8. **Row security** — a SQL predicate built from entitlements, organization,
   plant and classification rules and pushed down to the data layer.
9. **Policies (ABAC-ready)** — the rule container: subject, resource type,
   action, effect, priority, validity window and an optional attribute
   condition over the evaluation context (`request.authentication_method`,
   `subject.roles`, `resource.classification`, ...).

## 4. Object type enforcement

Each object type is registered with an enforcement mode:

| Mode | Behaviour |
| --- | --- |
| `tenant` | tenant isolation only (backward-compatible default) |
| `entitlement` | apply entitlements / organization / plant / classification predicates; RBAC remains the inherited allow |
| `policy` | strict: at least one explicit allow is required, otherwise rows are filtered out |

The Security Foundation bootstraps registrations from the search object type
registry so existing types are immediately administrable.

## 5. Data model

New tables (migration `027_security_model`, mirrored in `server/schema.sql`):

- `security_object_types` — enforcement registration per tenant/object type.
- `security_policies` + `security_policy_rules` — ABAC-ready policies.
- `security_entitlements` — object type / object / attribute entitlements.
- `security_field_rules` — field security and inline masking.
- `security_classification_rules` — classification security.
- `security_organization_rules` / `security_plant_rules` — scope security.
- `security_masking_rules` — reusable named masking configurations.
- `security_decisions` — optional decision journal for the inspector.
- `security_cache_epoch` — cross-process cache invalidation epochs.

## 6. Enforcement at the data layer

Search and object consumers apply security in two places:

1. **Row predicate** (`buildSearchSecurityPredicate`) — appended to the
   provider `WHERE` clause so unauthorized rows are never fetched. Counts,
   facets, pagination and suggestions are therefore computed from authorized
   data only.
2. **Field masking** (`maskDocumentsByType`) — applied to the result DTOs after
   authorization. Facet fields with a `deny`/`hide` rule are removed so facet
   counts cannot disclose protected values.

## 7. Batch evaluation and performance

Decision throughput matters for lists, exports and dashboards, which authorize
many resources per request. `/api/v1/security/evaluate/batch` and
`/api/v1/authorization/batch-check` evaluate up to 500 requests through the same
engine, reuse the decision cache within the call, and preserve input order so
results map directly back to rows. The engine is deterministic: a decision is a
pure function of the security context, the target resource and the active rule
set, and never depends on evaluation order.

## 8. Caching and invalidation

Decisions are cached in-process keyed by tenant, subject, action, resource type
and resource id. Every administrative mutation bumps the tenant epoch in
`security_cache_epoch` and clears the process cache; other processes observe the
new epoch and stop serving stale decisions. `POST /api/v1/security/cache/invalidate`
allows an explicit flush.

## 9. Security events and audit

- Denied decisions write an `authz.deny` audit event and emit the
  `SecurityAccessDenied` domain event.
- Administrative changes emit `SecurityPolicyChanged`.
- The decision journal (`POST /api/v1/security/evaluate`, `GET /decisions`)
  supports debugging without re-deriving state by hand.

## 10. Extension points

- Register masking handlers with `registerMaskingHandler(name, fn)`.
- Add condition operators in `server/services/security/conditions.js`.
- Add resource dimensions by extending `SECURITY_SCOPES` and the engine's
  matching functions; existing modules are unaffected.

## 11. Security guarantees

- Default deny: absence of a valid entitlement never grants access.
- Tenant isolation is always applied first.
- Frontend state is never trusted for authorization.
- Masked, hidden or denied fields are removed before the payload leaves the
  server, including search results, reports, exports, bulk responses and the
  audit surface.
