# Helix IAM — Users, Groups, Roles & Authorization

Enterprise identity and authorization fabric. Future platform modules consume principals and `checkPermission` through REST APIs.

## Stack

- Node.js + Express
- SQLite (`node:sqlite`)
- Vite + React administration console
- Node.js test runner

## Deploy on your laptop

### Prerequisites

- Node.js 22.22+ (tested on `v22.22.0`) or Node.js 24 LTS. The platform uses the built-in `node:sqlite`, so older Node 22.x builds may need `--experimental-sqlite`.
- npm (ships with Node) and git.
- No database server required. SQLite is embedded and the database file is created automatically on first start.

```bash
node -v
npm -v
git --version
```

### 1. Get the code

```bash
# Clone the repository
git clone https://github.com/enareshy/FutureForge.git

# Enter the project
cd FutureForge

# Check out the branch with the workflow engine work
git checkout 260915-feat-workflow-engine
```

If you received a package instead of a git clone, unzip it and open the folder:

```bash
# Unzip and enter the folder
unzip FutureForge.zip
cd FutureForge
```

### 2. Install dependencies

```bash
# Install all runtime and dev dependencies
npm install
```

### 3. Run in development mode (recommended)

```bash
# Start API on 3001 and the web console on 5173
npm run dev
```

The first start automatically creates `data/iam.db`, applies all migrations (`001_iam_core` through `011_workflow`) and seeds demo data.

- Web console: http://localhost:5173
- API: http://localhost:3001

### 4. Log in

- Super admin: `admin` / `HelixAdmin!42`
- End user: `j.patel` / `HelixUser!42`

Where things live in the UI:

- Configuration section, Workflow Engine (`/workflows/templates`): admins design workflow templates.
- My tasks & approvals (`/workflows`): end user inbox for tasks, team tasks, approvals and instances.
- Object detail page: Graph tab for relationships and the workflow progress graph.

### 5. Production-style single port

The Express server serves the built console when `web/dist` exists, so everything can run on one port.

```bash
# Build the web console (outputs to web/dist)
npx vite build

# Start the API plus the built UI on port 3001
npm start
```

Then open http://localhost:3001.

### 6. Configuration

- `PORT` — API port, default `3001`.
- `IAM_DB` — database file path, default `data/iam.db`.

```bash
# Run on a different port and database file
PORT=4000 IAM_DB=./data/local.db npm start
```

On Windows PowerShell:

```powershell
$env:PORT="4000"; npm start
```

### 7. Reset the database

Stop the server, then remove `data/iam.db` (and any `data/iam.db-wal` / `data/iam.db-shm`). The next start recreates and seeds it. Migrations are safe to re-run and never drop data. To re-seed an existing database:

```bash
# Re-run the idempotent seed
npm run seed
```

### 8. Access from other devices on your network

The dev server binds to `0.0.0.0`, so other devices can reach it via your laptop IP, for example `http://192.168.x.x:5173`. Vite allows `localhost`, IP addresses and `*.monkeycode-ai.live`; add more hostnames to `server.allowedHosts` in `vite.config.js` if needed.

### 9. Troubleshooting

- Port already in use (`EADDRINUSE`): stop the other process, or change `PORT` and update `server.port` plus the `/api` proxy target in `vite.config.js`.
- Blank page after `npm start`: run `npx vite build` first so `web/dist` exists.
- `ExperimentalWarning: SQLite is an experimental feature`: harmless Node notice.
- Login fails against an old database: reset it as described in step 7.

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
- `/api/workflow-templates` — versioned, immutable workflow templates with `/versions`, `/validate`, `/publish`, `/clone` and a `/designer` graph editor (`/nodes`, `/transitions`, `/auto-layout`, `/validate`)
- `/api/workflow-instances` — runtime engine: start, inspect `/nodes` and `/history`, `cancel`, `pause`, `resume`, `retry`
- `/api/tasks` — task inbox: list by scope, `complete`, `assign`, `claim`, `delegate`, `status`, plus `/comments`, `/attachments`, `/subtasks`
- `/api/workflow-approvals` — approval inbox and decisions (`/decision`, `/approve`, `/reject`, `/request-changes`)
- `/api/workflow-routing-rules` `/api/workflow-escalation-rules` `/api/workflow-escalations/sweep` — assignment routing and escalation sweeps
- `/api/workflow-notifications` `/api/workflow-notification-templates` `/api/workflow-bindings` `/api/workflow-delegations` — notifications, event bindings and out-of-office delegation
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

Design notes: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`, `docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`, `docs/AUTHENTICATION_DESIGN.md`, `docs/METADATA_DESIGN.md`, `docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/LIFECYCLE_DESIGN.md`, `docs/WORKFLOW_ENGINE_DESIGN.md`

The admin console exposes metadata under `/metadata` (types, attributes, LOVs, forms, rules, record builder, scoped config), lifecycle configuration under `/lifecycles`, and **Workflow Engine** under `/workflows/templates` (the Configuration section where admins create and design workflow templates). End users get **My tasks & approvals** under `/workflows` (My Tasks, Team Tasks, Approvals and the instance monitor). Object lifecycle state, transitions, approvals and status history appear on the object detail page. The reusable client renderer is `web/src/components/FormRenderer.jsx` and the visual workflow designer is `web/src/components/WorkflowDesigner.jsx`.

## Tests

```bash
npm test
```
