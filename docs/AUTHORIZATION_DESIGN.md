# Helix IAM — Permissions & Authorization

Configurable RBAC engine consumed by every future platform module.

Chain: `User → Group → Role → Permission → Resource`

Fail-safe default: **deny**. Missing user, inactive account, unknown resource, or no matching grant is denied.

## Reuse

Built on the existing identity fabric (`docs/IAM_DESIGN.md`):

- Users, groups, role assignments, org scope, role inheritance (`effectiveAccess`)
- Audit log, validation helpers, Express session auth
- No new runtime dependencies

## Catalog

| Entity | Purpose |
|--------|---------|
| Application | Module boundary (`iam`, `finance`, `site`) |
| Resource | Module or object in a tree (`iam.users` child of `iam`) |
| Permission | `(resource, action)` where action is `create` `read` `update` `delete` `execute` |
| Role grant | Role → permission with `allow` or `deny` and optional `organization_id` |

Role → user and role → group mappings stay in the identity module.

## Evaluation: `checkPermission(user, resource, action, context)`

```
1. Load user. Missing or not active → DENY (inactive / locked / unknown).
2. Resolve resource by code or id. Unknown → DENY.
3. Resource ancestry = resource + parents (permission inheritance).
4. Effective roles = existing identity resolution
   (direct + group membership + ancestor groups + ancestor roles),
   each with assignment organization.
5. Collect role_permissions for those roles.
6. A grant matches when:
   - permission.resource is in the resource ancestry
   - permission.action equals the requested action
   - role assignment org is global or an ancestor of context.organizationId
   - grant org is global or an ancestor of context.organizationId
   - If context has no organization, only global (org 0) scopes match
7. Decision:
   - any matching DENY → DENY (explicit deny wins)
   - else any matching ALLOW → ALLOW
   - else DENY
8. Write audit `authz.check` when the caller requests it (API checks).
```

Org/site scope uses organization parent links: a HQ grant applies at EMEA; an EMEA grant does not apply at APAC.

## Platform API

Future modules must call the engine rather than joining tables:

- In-process: `checkPermission(db, user, resource, action, context)`
- HTTP: `POST /api/authorization/check`
- Effective set: `GET /api/authorization/effective/:userId`

## HTTP surface

| Route | Role |
|-------|------|
| `/api/applications` | Module catalog |
| `/api/resources` | Resource tree |
| `/api/permissions` | Permission catalog + matrix |
| `/api/roles/:id/permissions` | Role → permission grants |
| `/api/authorization/check` | Evaluate one decision |
| `/api/authorization/effective/:userId` | Flattened allow set |

## Administration

Permission matrix: roles × (resource, action) cells are unset / allow / deny, including inherited grants. Authorization tester runs `checkPermission` against a principal.

## API enforcement

Every mutating and listing IAM route (except login, logout, `/api/auth/me`, password reset, SSO start/callback, MFA challenge verify, public provider list, and the authorization query endpoints) runs `requirePermission` after session auth.

`requirePermission(resource, action)` calls `checkPermission`. Failure is HTTP 403 and an `authz.deny` audit row. Unknown resource, inactive principal, or unmatched grant is deny.

| Resource | Routes |
|----------|--------|
| `iam.users` | `/api/users` |
| `iam.groups` | `/api/groups` |
| `iam.roles` | `/api/roles` |
| `iam.permissions` | `/api/permissions`, `/api/applications`, `/api/resources` |
| `iam.organizations` | `/api/organizations`, `/api/hierarchy` |
| `iam.platform` | `/api/platform/hierarchy`, `/api/platform/settings` (Super Admin) |
| `iam.authentication` | `/api/authentication/providers`, `/api/authentication/settings` |
| `iam.sessions` | `/api/sessions/admin` |
| `iam.policy` | `/api/password-policy` |
| `iam.audit` | `/api/audit-logs` |

`POST /api/authorization/check` remains callable by any authenticated principal so other modules can evaluate decisions.
