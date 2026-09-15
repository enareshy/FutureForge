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
- `/api/metadata` — reusable configuration & metadata: types, attributes, LOVs, dynamic forms, rules, scoped artifact config
- `/api/objects` — metadata-typed business objects: CRUD, search, `/summary`, `/bulk`, `/versions`, `/status`, `/checkout`, `/checkin`, `/locks`, `/restore`, `/tree`, `/graph`, `/relationships`, `/dependencies`, `/safe-delete`
- `/api/object-types` — object types available to the current tenant
- `/api/relationship-types` — typed, cardinality-aware relationship definitions
- `/api/relationships` — object relationships: list, create, `/validate`, update, delete
- `/api/references` — strong/weak/external references, plus `/orphans`
- `/api/dependencies` — direct dependencies, `/impact` analysis and `/cycles` detection
- `/api/statuses` — configurable lifecycle statuses (categories, legacy mapping, type availability)
- `/api/lifecycle-definitions` — versioned lifecycle state machines: `/versions`, `/validate`, `/publish`
- `/api/lifecycle-states` `/api/lifecycle-transitions` `/api/lifecycle-assignments` — state machines and object-type bindings
- `/api/release-rules` `/api/approval-rules` — approval rules with sequential/parallel steps and quorums
- `/api/objects/:id/lifecycle` `/transitions` `/status-history` `/release` `/releases` `/approvals/:approvalId` — per-object transition engine and release/approval workflow
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

Design notes: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`, `docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`, `docs/AUTHENTICATION_DESIGN.md`, `docs/METADATA_DESIGN.md`, `docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/LIFECYCLE_DESIGN.md`

The admin console exposes metadata under `/metadata` (types, attributes, LOVs, forms, rules, record builder, scoped config) and lifecycle configuration under `/lifecycles`. Object lifecycle state, transitions, approvals and status history appear on the object detail page. The reusable client renderer is `web/src/components/FormRenderer.jsx`.

## Tests

```bash
npm test
```
