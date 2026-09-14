# Helix IAM — Users, Groups, Roles & Authorization

Enterprise identity and authorization fabric. Future platform modules consume principals and `checkPermission` through REST APIs.

## Stack

- Node.js + Express
- SQLite (`node:sqlite`)
- Vite + React administration console
- Node.js test runner

## Run

```bash
# Install dependencies
npm install

# Start API (3001) and admin UI (5173)
npm run dev
```

Default operator: `admin` / `HelixAdmin!42`

## APIs

- `/api/users` — create, profile update, activate, deactivate, lock, unlock, password reset, search
- `/api/groups` — hierarchy, membership
- `/api/roles` — inheritance, user/group assignment, organization scope
- `/api/permissions` — catalog and matrix
- `/api/roles/:id/permissions` — role grants (allow/deny, org-scoped)
- `/api/authorization/check` — `checkPermission(user, resource, action, context)`
- `/api/authorization/effective/:userId` — flattened allow set
- `/api/iam/principals/:userId/access` — effective groups and roles for other modules
- `/api/organizations` — tree, move, members, `/tree`, `/context` (tenant-scoped)
- `/api/tenants` — tenant administration, context switch, tenant-scoped config
- `/api/config` — effective configuration; System → Tenant → Organization precedence
- `/api/hierarchy` — Super Admin–defined org levels (operators)
- `/api/platform/hierarchy` `/api/platform/settings` — Super Admin feature properties
- `/api/companies` `/api/business-units` `/api/plants` `/api/sites` `/api/departments` — typed collections
- `/api/password-policy`, `/api/audit-logs`
- `/api/authentication` — login, providers, settings, password reset
- `/api/sessions` — current sessions; `/api/sessions/admin` for operators
- `/api/mfa` — TOTP enroll/verify/disable, challenge, admin reset
- `/api/sso` — start/callback/metadata for SAML and OIDC providers

IAM APIs are fail-safe: session plus `checkPermission`. Unauthorized callers receive 403.

In-process (future modules): `import { checkPermission, organizationContext } from "./server/platform.js"`

Design notes: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`, `docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`, `docs/AUTHENTICATION_DESIGN.md`

## Tests

```bash
npm test
```
