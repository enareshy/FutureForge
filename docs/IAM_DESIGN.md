# Helix IAM — Users, Groups & Roles

Platform identity fabric. Future enterprise modules consume this submodule through REST APIs (`/api/users`, `/api/groups`, `/api/roles`, `/api/iam/principals/:id/access`).

## Stack

- Runtime: Node.js (ESM), Express
- Store: SQLite (`node:sqlite`) — zero extra DB infrastructure
- Admin UI: Vite + React, reverse-proxied `/api` to the IAM service
- Auth: central Authentication, SSO & MFA submodule (`docs/AUTHENTICATION_DESIGN.md`); opaque session tokens; passwords hashed with scrypt
- Tests: Node.js built-in test runner

## Data model

```
organizations  1--* users
organizations  1--* groups (optional scope)
groups         *--* users          (group_members)
groups         tree via parent_id  (hierarchy)
roles          tree via parent_id  (inheritance)
users          *--* roles          (user_roles + optional organization_id)
groups         *--* roles          (group_roles + optional organization_id)
password_policy (singleton)
password_history
audit_logs
```

### Users
`username`, `email`, `employee_id`, `display_name`, `status` (`active` | `inactive` | `locked`), `organization_id`, password metadata (`failed_login_attempts`, `locked_until`). No hard delete — activate / deactivate / lock / unlock.

### Groups
Named collections with optional parent (tree) and optional owning organization. Members inherit roles assigned to a group **and its ancestor groups**.

### Roles
Named authorizations with optional parent. Effective roles = assigned role + all ancestors. Assignments may be global (`organization_id` null) or site/org-specific.

### Password policy
Singleton: length, character classes, max age, history count, lockout threshold/duration. Enforced on create, reset, and login.

### Effective access (platform API)
`GET /api/iam/principals/:userId/access` returns the principal, membership groups (plus ancestors), and resolved roles with source (`user` | `group`), inheritance flags, and organization scope. Other modules must use this rather than joining tables themselves.

## API surface

| Area | Routes |
|------|--------|
| Auth | `POST /api/authentication/login` (also `/api/auth/login`), sessions, MFA, SSO — see `docs/AUTHENTICATION_DESIGN.md` |
| Users | CRUD-lite under `/api/users` plus activate/deactivate/lock/unlock/reset-password and nested groups/roles |
| Groups | `/api/groups` plus members and roles |
| Roles | `/api/roles` plus assignments |
| Policy | `GET/PUT /api/password-policy` |
| Orgs | `/api/organizations` plus typed collections from Super Admin hierarchy (see `docs/ORGS_DESIGN.md`, `docs/PLATFORM_PROPERTIES.md`) |
| Audit | `GET /api/audit-logs` |
| Consume | `GET /api/iam/principals/:userId/access` |

Mutations write audit rows (`actor`, `action`, `resource`, JSON details).

## UI

Admin console: login, dashboard, users (search/filter/pagination), user profile + assignments, groups (tree, members), roles (inheritance, org-scoped assignment), password policy, audit log.
