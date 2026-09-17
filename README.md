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

# Check out the branch with the job management and execution engine work
git checkout 260915-feat-audit-framework
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

The first start automatically creates `data/iam.db`, applies all migrations (`001_iam_core` through `017_files`) and seeds demo data.

- Web console: http://localhost:5173
- API: http://localhost:3001

### 4. Run a job worker

The execution engine runs in separate worker processes that share the same
database. Start at least one worker to execute queued and scheduled jobs:

```bash
# All queues, 4-way concurrency
npm run worker

# Restrict queues / raise concurrency
node scripts/job-worker.js --queues=IMPORT,REPORTING --concurrency=8

# Local demo with the bundled simulation handlers
node scripts/job-worker.js --demo
```

Workers shut down gracefully on `SIGTERM`. See `docs/JOB_EXECUTION_OPERATIONS.md` for tuning, dead letters and troubleshooting.

### 5. Log in

- Super admin: `admin` / `HelixAdmin!42`
- End user: `j.patel` / `HelixUser!42`

Where things live in the UI:

- Configuration section, Workflow Engine (`/workflows/templates`): admins design workflow templates.
- My tasks & approvals (`/workflows`): end user inbox for tasks, team tasks, approvals and instances.
- Communication section, Inbox (`/notifications`): end-user notification center (bell/unread badge, tabs, archive, deep links) and personal preferences.
- Communication section, Notification admin (`/notifications/admin`): templates, rules, channel providers and the delivery monitor.
- Communication section, Delivery services (`/delivery/admin`): centralized outbound queue, provider routing/failover, retries and dead-letters, reminders/escalations, provider configuration and operational monitoring.
- Jobs section, Job dashboard (`/jobs`), Jobs (`/jobs/list`) and Job types (`/jobs/admin`): centralized background job registry, submission, monitoring, control (cancel/retry/pause/resume), dependencies, history, results/artifacts and job-type administration.
- Jobs section, Execution engine: **Execution** (`/jobs/execution`), **Workers** (`/jobs/workers`) and **Dead letters** (`/jobs/dead-letter`) for operators, plus administrator **Queues** (`/jobs/queues`) and **Schedules** (`/jobs/schedules`).
- Documents section, **File browser** (`/files`): folder navigation, metadata search/filter/sort, upload, download, delete/restore; **File administration** (`/files/admin`): storage/processing metrics, locks, upload sessions, permissions and events. File details (`/files/:ref`) cover metadata, versions, access control, associations and processing.
- Object detail page: Graph tab for relationships and the workflow progress graph.

### 6. Production-style single port

The Express server serves the built console when `web/dist` exists, so everything can run on one port.

```bash
# Build the web console (outputs to web/dist)
npx vite build

# Start the API plus the built UI on port 3001
npm start
```

Then open http://localhost:3001.

### 7. Configuration

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

### 8. Reset the database

Stop the server, then remove `data/iam.db` (and any `data/iam.db-wal` / `data/iam.db-shm`). The next start recreates and seeds it. Migrations are safe to re-run and never drop data. To re-seed an existing database:

```bash
# Re-run the idempotent seed
npm run seed
```

### 9. Access from other devices on your network

The dev server binds to `0.0.0.0`, so other devices can reach it via your laptop IP, for example `http://192.168.x.x:5173`. Vite allows `localhost`, IP addresses and `*.monkeycode-ai.live`; add more hostnames to `server.allowedHosts` in `vite.config.js` if needed.

### 10. Troubleshooting

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
- `/api/audit/events` — immutable audit event stream: filtered list, manual capture, `/summary`, `/facets`, read-only single event with attribute changes
- `/api/audit/objects/:objectType/:objectId/history` — per-object history timeline with before/after attribute diffs
- `/api/audit/users/:userId/activity` — per-actor activity timeline
- `/api/audit/export` — export the current filter to CSV or Excel (the export is itself audited)
- `/api/audit/policies` — per tenant/object-type capture, masking, retention and visibility policies
- `/api/audit/retention/runs` `/api/audit/retention/run` — archival/purge runs with dry-run support
- `/api/workflow-templates` — versioned, immutable workflow templates with `/versions`, `/validate`, `/publish`, `/clone` and a `/designer` graph editor (`/nodes`, `/transitions`, `/auto-layout`, `/validate`)
- `/api/workflow-instances` — runtime engine: start, inspect `/nodes` and `/history`, `cancel`, `pause`, `resume`, `retry`
- `/api/tasks` — task inbox: list by scope, `complete`, `assign`, `claim`, `delegate`, `status`, plus `/comments`, `/attachments`, `/subtasks`
- `/api/workflow-approvals` — approval inbox and decisions (`/decision`, `/approve`, `/reject`, `/request-changes`)
- `/api/workflow-routing-rules` `/api/workflow-escalation-rules` `/api/workflow-escalations/sweep` — assignment routing and escalation sweeps
- `/api/workflow-notifications` `/api/workflow-notification-templates` `/api/workflow-bindings` `/api/workflow-delegations` — notifications, event bindings and out-of-office delegation
- `/api/notifications` — recipient-scoped in-app inbox: list with tabs/filters, `/unread-count`, `/meta`, `mark-all-read`, `archive-all-read`, read/unread/archive/delete a single notification
- `/api/notification-preferences` — per-user delivery preferences (channels, frequency, quiet hours, self-notify, per-event overrides, `/mandatory`)
- `/api/notification-templates` — versioned templates with `/variables`, `/versions`, `/preview`, `/test-send`, status toggling and validation (allow-listed `{{placeholders}}`, sanitized HTML)
- `/api/notification-rules` — event-to-recipient rules: conditions, recipient definitions, channels, priority, reminders, escalations, `/status`, `/simulate`
- `/api/notification-providers` — channel provider config (encrypted secrets, masked responses), `/test`
- `/api/notification-history` — administrator cross-recipient delivery history with status counts
- `/api/notification-events` `/api/notification-events/publish` — notification event stream and the reusable `publish()` entry point
- `/api/notification-deliveries` `/stats` `/process` `/:id/retry` — delivery queue monitoring, retry and backoff processing
- `/api/notification-reminders` `/sweep` — scheduled reminders and escalation sweeps
- `/api/delivery/requests` — canonical outbound delivery requests with `/attempts`, `/cancel`, `/retry`; `/api/delivery/process` runs the queue worker
- `/api/delivery/providers` `/provider-failures` `/provider-health` — provider configuration (encrypted secrets, masked responses), failover chain, failure log and health
- `/api/delivery/reminders` `/escalations` (+ `/sweep`, `/cancel`) — durable reminder and level-based escalation schedules and execution history (`/runs`)
- `/api/delivery/metrics` `/stats` `/timeseries` `/alerts` `/alerts/:id/acknowledge` — delivery tracking, operational metrics and alert acknowledgement
- `/api/jobs` — background job submission (immediate Job ID, idempotent), listing with search/filter/sort/pagination, `/meta`, and `/status` `/history` `/dependencies` `/children` `/:id/result` `/artifacts` per job
- `/api/jobs/:id/cancel` `/retry` `/pause` `/resume` `/progress` — job control operations; `/dependencies` `POST`/`DELETE` manage dependency edges
- `/api/job-types` (+ `/status`) — background job type registry (metadata + handler reference) that business modules register their asynchronous work in
- `/api/job-metrics` `/timeseries` — job dashboard counters, status/type breakdowns, queue depth, durations, recent failures and throughput
- `/api/job-queues` (+ `/meta`, `/:id`, `/:id/health`, `/:id/status`) — execution engine queue administration: concurrency, priority, rate limits, retry/timeout policy, enable/pause
- `/api/schedules` (+ `/:id`, `/:id/enable|disable|pause|resume|run-now`, `/:id/runs`) — recurring job schedules: interval/daily/weekly/monthly/cron, time zones, catch-up/concurrency/failure policies and run history
- `/api/job-execution` — engine observability and control: `/status` `/metrics` `/workers` `/handlers` `/audit`, `/dead-letter` (+ `/:id/retry` `/:id/discard`), `/jobs/:id/execute`, `/tick` and `/maintenance`
- `/api/files` — document & file metadata: list/search/filter/sort, `/meta`, `/metrics` (+ `/storage`, `/processing`), `/facets`, `/events`, per file `/:reference` get/update/delete `/restore` `/move` `/events` `/permissions` `/processing` (+ `/requeue`) `/download`
- `/api/files/:reference/versions` — immutable file versions: list, create, get, `/restore` and `/download`
- `/api/files/:reference/lock` `checkout` `checkin` `lock/release` `lock/force-release` and `/api/file-locks` — check-out/check-in locking and the tenant-wide lock view
- `/api/files/uploads` — resumable upload sessions (initiate, chunk, complete, abort); `/api/files/upload` is a single-request convenience endpoint; `/api/files/download/:token` streams signed, short-lived downloads
- `/api/files/permissions` — file/folder ACL administration layered on IAM
- `/api/file-associations` — links between files and business objects
- `/api/folders` — folder tree, contents, breadcrumb and membership; `/api/file-collections` — curated file collections
- `scripts/job-worker.js` (`npm run worker`) — durable worker process; `--queues`, `--concurrency`, `--demo` and graceful `SIGTERM` shutdown
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

Design notes: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`, `docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`, `docs/AUTHENTICATION_DESIGN.md`, `docs/METADATA_DESIGN.md`, `docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/LIFECYCLE_DESIGN.md`, `docs/WORKFLOW_ENGINE_DESIGN.md`, `docs/AUDIT_DESIGN.md`, `docs/NOTIFICATIONS_DESIGN.md`, `docs/DELIVERY_DESIGN.md`, `docs/JOB_MANAGEMENT_DESIGN.md`, `docs/JOB_EXECUTION_DESIGN.md`, `docs/FILE_MANAGEMENT_DESIGN.md` and the day-2 guides `docs/DELIVERY_OPERATIONS.md`, `docs/JOB_MANAGEMENT_OPERATIONS.md`, `docs/JOB_EXECUTION_OPERATIONS.md`, `docs/FILE_MANAGEMENT_OPERATIONS.md`

The admin console exposes metadata under `/metadata` (types, attributes, LOVs, forms, rules, record builder, scoped config), lifecycle configuration under `/lifecycles`, **Workflow Engine** under `/workflows/templates` (the Configuration section where admins create and design workflow templates), **Audit & history** under `/audit` (event stream, overview, policies, retention and export), and **Notification admin** under `/notifications/admin` (templates with preview/test-send, rules with simulation, channel providers and the delivery monitor). Operators get a **Delivery services** console under `/delivery/admin` for the outbound queue, provider routing and failover, retry/dead-letter recovery, reminders and escalations, and operational monitoring. The **Jobs** section provides a **Job dashboard** (`/jobs`), a searchable **Jobs** list (`/jobs/list`) for submitting and controlling background work (cancel/retry/pause/resume) and an administrator **Job types** registry (`/jobs/admin`). The **Documents** section provides a **File browser** (`/files`) for folders, uploads, search and downloads, a file detail page (`/files/:ref`) for metadata, versions, access control, associations and processing, and an administrator **File administration** page (`/files/admin`) for storage/processing metrics, locks, upload sessions, permissions and events. Operators get an execution engine view with **Execution** (`/jobs/execution`), **Workers** (`/jobs/workers`) and **Dead letters** (`/jobs/dead-letter`), and administrators get **Queues** (`/jobs/queues`) and **Schedules** (`/jobs/schedules`). Every user gets an **Inbox** under `/notifications` with a bell/unread badge, plus personal notification preferences. End users get **My tasks & approvals** under `/workflows` (My Tasks, Team Tasks, Approvals and the instance monitor). Object lifecycle state, transitions, approvals, status history and a **History** tab appear on the object detail page. The reusable client renderer is `web/src/components/FormRenderer.jsx` and the visual workflow designer is `web/src/components/WorkflowDesigner.jsx`.

## Tests

```bash
npm test
```
