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

The first start automatically creates `data/iam.db`, applies all migrations (`001_iam_core` through `021_event_messaging_framework`) and seeds demo data.

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

Workers shut down gracefully on `SIGTERM`. See `docs/JOB_EXECUTION_OPERATIONS.md` for tuning, dead letters and troubleshooting. Workers also run the integration housekeeping sweep (queued messages, event fan-out and outbound webhooks); see `docs/INTEGRATION_OPERATIONS.md`. Workers drive the Event & Messaging Framework (outbox publish, delivery consumption, replay and retention); see `docs/EVENTS_OPERATIONS.md`. Workers also expire overdue number reservations and prune stale idempotency records; see `docs/NUMBERING_OPERATIONS.md`. Workers also expire ended effectivity and prune resolution bookkeeping; see `docs/VERSIONING_OPERATIONS.md`. Workers also process content security scans, renditions and retention, and run a content housekeeping sweep (expired upload sessions, stale check-out locks, retention evaluation and search reindexing); see `docs/CONTENT_MANAGEMENT_OPERATIONS.md`.

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
- Documents section, **File browser** (`/files`): folder navigation, metadata search/filter/sort, upload, download, delete/restore; **File administration** (`/files/admin`): storage/processing metrics, locks, upload sessions, permissions and events. File details (`/files/:ref`) cover metadata, versions, access control, associations and processing. The same section exposes the underlying **Content library** (`/content`) for provider-independent content with direct/resumable uploads, security status, renditions, versions, associations and retention, plus **Content administration** (`/content/admin`) for storage footprint, processing pipelines, security scanning and retention policies.
- Search section, **Search & Discovery** (`/search`): centralized global/advanced search across registered object types and documents with suggestions, type/tag filters, facets, highlights, saved searches, recent searches and exports; **Search administration** (`/search/admin`): index health and queue, object-type registration, per-tenant configuration and telemetry.
- Integration section, **Integration hub** (`/integration`): connect external systems, manage credentials/adapters, define and run integrations, publish/subscribe events, configure inbound/outbound webhooks, operate message queues and dead letters, run imports/exports and object mappings, and govern the API catalog, clients and usage.
- Integration section, **Event framework** (`/events`): the platform event backbone — event-type registry and schema versions, subscriptions, deliveries, dead letters, controlled replay, retention policies and topics/queues with monitoring dashboards.
- Identifiers section, **Numbering service** (`/numbering`): the centralized numbering and identifier capability — schemes with patterns/tokens, live generate/preview/reserve, allocation history with consume/release/cancel, sequence utilisation and service health.
- Versioning section, **Effectivity & versioning** (`/versioning`): the revision/effectivity kernel — deterministic as-of resolution across date/serial/plant/model/variant/configuration dimensions, revision lifecycle and relationships, resolution policies, baselines, historical snapshots and configuration contexts.
- Reference data section, **Enterprise reference data** (`/reference-data`): governed master/reference values — the mandatory domain catalogue, ownership and stewardship, versioned governance policies, multi-scope values with precedence, alternate codes, aliases, translations, hierarchy, relationships, effective dating, approvals, import/export and monitoring.
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
- `/api/audit/events` — immutable audit event stream: filtered list, manual capture, `/batch` capture, `/summary`, `/facets`, `/metrics`, read-only single event with attribute changes
- `/api/audit/objects/:objectType/:objectId/history` — per-object history timeline with before/after attribute diffs
- `/api/audit/attributes/:objectType/:objectId/history` `/api/audit/relationships/:objectType/:objectId/history` — single-attribute value timeline and relationship history
- `/api/audit/users/:userId/activity` — per-actor activity timeline
- `/api/audit/security` `/workflows` `/lifecycle` `/configuration` `/approvals` `/documents` `/integrations` `/background-jobs` — category-scoped activity views
- `/api/audit/export` — export the current filter to CSV or Excel (the export is itself audited)
- `/api/audit/exports` — asynchronous, trackable exports: request, list, inspect and `/download`
- `/api/audit/policies` (+ `/validate`) — per tenant/object-type capture, masking, retention and visibility policies
- `/api/audit/action-types` — dotted action registry with category, event type and mandatory flag
- `/api/audit/filters` — reusable, owner-scoped saved filters
- `/api/audit/retention/runs` `/api/audit/retention/run` — archival/purge runs with dry-run support
- `/api/audit/retention/policies` `/api/audit/retention/execute` — dedicated retention policies (with legal hold) and execution
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
- `/api/content` — provider-independent physical content: list/search/facets, `/meta` `/health` `/metrics` `/storage/summary`, direct upload, and per content `/:ref` get/update/delete `/restore` `/download` `/events` `/retention`
- `/api/content/uploads` — resumable upload sessions (initiate, append parts, complete, abort) with checksum, MIME and virus-scan verification
- `/api/content/:ref/versions` `/renditions` `/processing` `/security` `/lifecycle` `/archive` — immutable content versions, derived renditions, background processing, scan history/quarantine and state transitions
- `/api/content/:ref/lock` `checkout` `checkin` `unlock` and `/api/content/locks` — exclusive check-out leases with expiry and privileged force-release
- `/api/content/associations` — generic object↔content associations (roles, primary, sequence, effectivity); `/api/content/objects/:objectType/:objectId/content` — content attached to any object
- `/api/content/retention-policies` and `/api/content/:ref/legal-hold` (+ `/release`) — retention governance and legal holds; `/api/content/download/:token` streams signed, short-lived downloads
- `/api/search` — centralized search & discovery: global `GET`/`POST` search, `/meta`, `/suggestions`, `/facets`, `/advanced`, `/by-type/:objectType`, `/by-attributes`, `/by-relationship`
- `/api/search/saved` — saved searches (`/:reference`, `/:reference/run`); `/api/search/history` — per-user search history; `/api/search/exports` (+ `/:reference/download`) — JSON/CSV result exports
- `/api/search/object-types` — searchable object-type registry; `/api/search/indexes` (`/status` `/failures` `/retry` `/drain` `/reindex` `/prune` `/jobs`) — index administration; `/api/search/configuration` `/metrics` `/health` — configuration and telemetry
- `/api/integration/meta` — hub vocabulary: integration/adapter/direction/auth/error enums, adapters, handler and transfer registries
- `/api/integration/definitions` (+ `/:code`, `/status`, `/versions`, `/versions/:version/restore`, `/run`) — versioned integrations and manual execution
- `/api/integration/executions` (+ `/:ref`, `/retry`, `/cancel`) — execution history and step timelines
- `/api/integration/credentials` (+ `/:code`) — encrypted credentials (secrets never returned); `/api/integration/systems` (+ `/:code`, `/test`, `/health`) — external systems, connectivity tests and health
- `/api/integration/endpoints` (+ `/:code`) — integration API endpoint registry; `/api/integration/transformations` (+ `/:code`, `/test`) — declarative data mapping; `/api/integration/mappings` (+ `/stats`, `/:id`) — external↔internal identity mapping with conflict detection
- `/api/integration/schedules` (+ `/:code`, `/status`, `/run`) — scheduled integrations executed by the job engine
- `/api/integration/event-types` (+ `/:code`) — event catalogue; `/api/integration/subscriptions` (+ `/:code`, `/status`) — filtered subscribers; `/api/integration/events` (+ `/:ref`, `/replay`) and `/api/integration/deliveries` (+ `/:id/retry`) — publish, replay and delivery monitoring
- `/api/integration/webhooks/inbound` (+ `/:code`, `/status`, `/receipts`) — inbound receivers; `POST /api/v1/integration/webhooks/receive/:code` — public, signature-authenticated receiver; `/api/integration/webhooks/outbound` (+ `/:code`, `/status`, `/test`, `/deliveries`) — signed outbound webhooks with retry/auto-disable
- `/api/integration/messages` (+ `/:ref`, `/retry`, `/cancel`) and `/api/integration/queues` — durable message queues; `/api/integration/dead-letters` (+ `/stats`, `/:id`, `/inspect`, `/retry`, `/resolve`, `/bulk-retry`) — dead-letter recovery
- `/api/integration/transfers` (+ `/handlers`, `/import`, `/import/preview`, `/export`, `/:ref`, `/:ref/download`, `/:ref/cancel`) — handler-driven import/export
- `/api/integration/monitoring` (`/overview`, `/executions`, `/deliveries`, `/systems`, `/systems/:code/uptime`, `/health-checks/run`, `/api-usage`) — operational dashboards, health probes and API metrics
- `/api/integration/api-catalog` (+ `/:code`, `/status`) and `/api/integration/api-clients` (+ `/:code`, `/rotate`, `/revoke`) — API governance: catalog, hashed client keys and rotation; `/api/integration/api-usage` — metering
- `/api/v1/integration/*` — versioned alias of the entire integration router
- `/api/events/meta` — event category/status/retry vocabularies and the handler registry
- `/api/events/event-types` (+ `/:code`, `/versions`, `/versions/:version`, `/compatibility`) — event type registry and versioned schemas
- `POST /api/events/publish` `/batch` `/validate` `/serialize` and `GET /api/events` (+ `/:ref`, `/:ref/route`, `/:ref/deliveries`) — publish, validate, serialize, inspect and route events
- `/api/events/subscriptions` (+ `/:code`, `/status`, `/validate`, `/test`, `/stats`) — filtered subscribers and handler wiring
- `/api/events/topics` `/queues` `/consumer-groups` (+ `/:code`, `/stats`) — bus topology
- `/api/events/deliveries` (+ `/stats`, `/:id`, `/retry`, `/skip`, `/attempts`) — delivery monitoring and recovery
- `/api/events/outbox` (+ `/stats`, `/process`, `/:id/retry`) and `/api/events/dead-letters` (+ `/stats`, `/bulk-retry`, `/:id`, `/resolve`) — transactional outbox and dead-letter recovery
- `/api/events/replays` (+ `/stats`, `/preview`, `/:ref`, `/run`, `/cancel`) and `/api/events/retention-policies` (+ `/:code`, `/apply`) `/retention` (`/apply`, `/stats`) — controlled replay and retention
- `/api/events/monitoring` (`/dashboard`, `/throughput`, `/failures`, `/latency`, `/health`, `/ordering`, `/traceability`) and `/api/events/handlers` (+ `/stats`, `/:code`) — operational dashboards, traceability and handler monitoring
- `/api/v1/events/*` — versioned alias of the entire event router
- `/api/numbering/meta` — numbering vocabularies, token registry and scopes
- `/api/numbering/object-types` (+ `/:code/status`) and `/api/numbering/tokens` (+ `/scopes`) — numbering foundation
- `/api/numbering/schemes` (+ `/:ref`, `/versions`, `/validate`, `/clone`, `/activate`, `/deactivate`, `/retire`) — versioned scheme administration
- `/api/numbering/generate` `/reserve` `/preview` `/validate` — issue, reserve, preview and validate identifiers (supports `Idempotency-Key`)
- `/api/numbering/allocations` (+ `/:ref`, `/:ref/consume`, `/:ref/release`, `/:ref/cancel`) — allocation history and lifecycle
- `/api/numbering/sequences` (+ `/:id`, `/:id/reset`) and `/api/numbering/metrics` `/dashboard` `/health` (+ `/health/live`, `/health/ready`) — sequence administration and monitoring
- `/api/v1/numbering/*` — versioned alias of the entire numbering router
- `/api/versioning/meta` `/effectivity-types` — versioning vocabularies and the effectivity-type catalogue
- `/api/versioning/revisions` (+ `/:ref`, `/activate`, `/supersede`, `/retire`, `/default`, `/history`, `/relationships`, `/compare/:other`) — revision lifecycle and relationships
- `/api/versioning/revisions/:ref/versions` / `/api/versioning/versions` (+ `/:ref`, `/activate`, `/supersede`, `/default`, `/compare/:other`) — version lifecycle
- `/api/versioning/effectivities` (+ `/:ref`, `/validate`, `/:ref/assignments`) `/assignments` and `/api/versioning/effectivity/inspect` — effectivity definitions, assignments and overlap/gap inspection
- `/api/versioning/effectivity/resolve` `/resolve/bulk` `/validate` — deterministic as-of resolution (single and non-N+1 bulk)
- `/api/versioning/resolution-policies` (+ `/:ref`) — configurable precedence, ambiguity strategy and overlap handling
- `/api/versioning/baselines` (+ `/:ref`, `/objects`, `/freeze`, `/restore`, `/compare/:other`) — immutable baselines
- `/api/versioning/snapshots` (+ `/:ref`, `/archive`, `/reconstruct`, `/compare/:other`) — historical snapshots
- `/api/versioning/variants` (+ `/:ref`, `/options`, `/rules`, `/evaluate`, `/history`) and `/api/versioning/configuration-contexts` (`/:ref`) — variant rules and configuration contexts
- `/api/versioning/metrics` `/dashboard` `/health/ready` `/health/live` — monitoring and health
- `/api/v1/versioning/*` and `/api/v1/revisions|effectivity/*` — versioned aliases of the versioning router
- `/api/reference-data/meta` `/health/live` `/health/ready` — reference data vocabularies and health
- `/api/reference-data/domains` (+ `/:ref`, `/status`, `/governance`, `/ownership-history`, `/tree`, `/reindex`) — domain catalogue, governance and ownership
- `/api/reference-data/items` (+ `/:ref`, `/status`, `/submit`, `/approve`, `/activate`, `/inactivate`, `/retire`, `/reject`, `/versions`, `/relationships`, `/codes`, `/aliases`, `/translations`, `/approvals`) — governed value lifecycle and metadata
- `/api/reference-data/codes` `/aliases` `/translations` `/hierarchy` `/relationships` `/versions` — value metadata administration
- `/api/reference-data/scope-policies` (+ `/:ref`) — configurable scope precedence
- `/api/reference-data/resolve` `/resolve/bulk` `/lookup` `/validate` `/values` `/search` — consumption, resolution, validation and search
- `/api/reference-data/approvals` (+ `/:ref`, `/decide`) and `/change-requests` (+ `/:ref`) — approval and change governance
- `/api/reference-data/imports` (+ `/:ref`, `/commit`) and `/exports` (+ `/:ref`, `/download`) — import/export
- `/api/reference-data/metrics` `/dashboard` — monitoring; `/api/v1/reference-data/*` — versioned alias of the reference data router
- `scripts/job-worker.js` (`npm run worker`) — durable worker process; `--queues`, `--concurrency`, `--demo` and graceful `SIGTERM` shutdown; also drains the search index queue and expires search exports
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

Design notes: `docs/IAM_DESIGN.md`, `docs/AUTHORIZATION_DESIGN.md`, `docs/ORGS_DESIGN.md`, `docs/ORGANIZATION_ADMIN_DESIGN.md`, `docs/AUTHENTICATION_DESIGN.md`, `docs/METADATA_DESIGN.md`, `docs/OBJECT_FRAMEWORK_DESIGN.md`, `docs/LIFECYCLE_DESIGN.md`, `docs/WORKFLOW_ENGINE_DESIGN.md`, `docs/AUDIT_DESIGN.md`, `docs/NOTIFICATIONS_DESIGN.md`, `docs/DELIVERY_DESIGN.md`, `docs/JOB_MANAGEMENT_DESIGN.md`, `docs/JOB_EXECUTION_DESIGN.md`, `docs/FILE_MANAGEMENT_DESIGN.md`, `docs/CONTENT_MANAGEMENT_DESIGN.md`, `docs/SEARCH_DISCOVERY_DESIGN.md`, `docs/INTEGRATION_DESIGN.md`, `docs/EVENTS_DESIGN.md`, `docs/NUMBERING_DESIGN.md`, `docs/VERSIONING_DESIGN.md`, `docs/REFERENCE_DATA_DESIGN.md` and the day-2 guides `docs/DELIVERY_OPERATIONS.md`, `docs/JOB_MANAGEMENT_OPERATIONS.md`, `docs/JOB_EXECUTION_OPERATIONS.md`, `docs/FILE_MANAGEMENT_OPERATIONS.md`, `docs/CONTENT_MANAGEMENT_OPERATIONS.md`, `docs/SEARCH_DISCOVERY_OPERATIONS.md`, `docs/AUDIT_OPERATIONS.md`, `docs/INTEGRATION_OPERATIONS.md`, `docs/EVENTS_OPERATIONS.md`, `docs/NUMBERING_OPERATIONS.md`, `docs/VERSIONING_OPERATIONS.md` and `docs/REFERENCE_DATA_OPERATIONS.md`; the event, numbering, versioning, reference data and content HTTP references are `docs/EVENTS_API.md`, `docs/NUMBERING_API.md`, `docs/VERSIONING_API.md`, `docs/REFERENCE_DATA_API.md` and `docs/CONTENT_MANAGEMENT_API.md`

The admin console exposes metadata under `/metadata` (types, attributes, LOVs, forms, rules, record builder, scoped config), lifecycle configuration under `/lifecycles`, **Workflow Engine** under `/workflows/templates` (the Configuration section where admins create and design workflow templates), **Audit & history** under `/audit` (event stream with saved filters, overview, metrics, security/workflow/lifecycle/configuration category views, object history, exports, retention and policies, and an action-type registry), and **Notification admin** under `/notifications/admin` (templates with preview/test-send, rules with simulation, channel providers and the delivery monitor). Operators get a **Delivery services** console under `/delivery/admin` for the outbound queue, provider routing and failover, retry/dead-letter recovery, reminders and escalations, and operational monitoring. The **Jobs** section provides a **Job dashboard** (`/jobs`), a searchable **Jobs** list (`/jobs/list`) for submitting and controlling background work (cancel/retry/pause/resume) and an administrator **Job types** registry (`/jobs/admin`). The **Documents** section provides a **File browser** (`/files`) for folders, uploads, search and downloads, a file detail page (`/files/:ref`) for metadata, versions, access control, associations and processing, and an administrator **File administration** page (`/files/admin`) for storage/processing metrics, locks, upload sessions, permissions and events. The **Search** section provides a **Search & Discovery** page (`/search`) for global/advanced search with suggestions, facets and saved searches, and an administrator **Search administration** page (`/search/admin`) for index health, object-type registration, configuration and telemetry. The **Versioning** section provides an **Effectivity & versioning** console (`/versioning`) for revision/version lifecycle, effectivity definitions and assignments, as-of resolution, resolution policies, baselines, snapshots, variants and configuration contexts. The **Reference data** section provides an **Enterprise reference data** console (`/reference-data`) for the domain catalogue and governance, governed values with lifecycle and scope, cross-domain resolution and validation, approvals, and import/export. Operators get an execution engine view with **Execution** (`/jobs/execution`), **Workers** (`/jobs/workers`) and **Dead letters** (`/jobs/dead-letter`), and administrators get **Queues** (`/jobs/queues`) and **Schedules** (`/jobs/schedules`). Every user gets an **Inbox** under `/notifications` with a bell/unread badge, plus personal notification preferences. End users get **My tasks & approvals** under `/workflows` (My Tasks, Team Tasks, Approvals and the instance monitor). Object lifecycle state, transitions, approvals, status history and a **History** tab appear on the object detail page. The reusable client renderer is `web/src/components/FormRenderer.jsx` and the visual workflow designer is `web/src/components/WorkflowDesigner.jsx`. Administrators and platform operators also get the **Integration hub** under `/integration` for external systems, credentials, integration definitions and executions, event types/subscriptions, inbound and outbound webhooks, message queues and dead letters, import/export transfers, object mappings, health/monitoring dashboards and API catalog/client governance. The **Event framework** console under `/events` exposes the platform event backbone: event-type registry and schema versions, subscriptions, deliveries, dead letters, controlled replay, retention policies and topics/queues with monitoring dashboards.

## Tests

```bash
npm test
```
