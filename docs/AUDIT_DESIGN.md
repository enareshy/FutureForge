# Audit & History Framework Design

The Audit & History Framework is a shared, tenant-aware platform capability that
records *who did what, when, to which object, and with what before/after values*
across every Helix module. It is not an isolated log table: it is an event
capture pipeline, a policy engine, a query/export/retention API, and an admin
console that other modules integrate with through a single service seam.

It is intentionally generic. IAM, Metadata, Objects, Lifecycle and the Workflow
Engine all feed the same event model, so the audit trail is uniform and
queryable even though the domains are very different.

## 1. Architecture

```
   domain services              capture pipeline                 storage
 +-------------------+   +--------------------------+   +---------------------+
 | objects           |   |  capture(db, event)      |   | audit_logs          |
 | iam / users       |-->|   - normalize            |-->| audit_event_changes |
 | metadata          |   |   - resolve policy       |   +---------------------+
 | lifecycle         |   |   - diff + mask          |             |
 | workflow          |   |   - insert (append-only) |             | retention
 +-------------------+   +--------------------------+             v
        ^                            ^                    +---------------------+
        |                            |                    | audit_logs_archive  |
   recordObjectChange()        auditRoute() middleware     +---------------------+
   writeAudit()               captureApiFailures()

 +---------------------------- query / admin ----------------------------+
 | listEvents  objectHistory  userActivity  summary  facets               |
 | exportEvents (CSV / Excel)     runRetention     policies CRUD          |
 +------------------------------------------------------------------------+
```

Layers:

- **Capture layer** (`server/services/audit/events.js`, `hooks.js`) -
  `capture()`, the back-compat `writeAudit()`, the domain-oriented
  `recordObjectChange()`, the express `auditContext()` / `captureApiFailures()`
  middleware, and the `auditRoute()` decorator that records an event around a
  mutating route.
- **Policy layer** (`policies.js`) - per tenant/object-type configuration that
  decides whether an event is recorded, which attributes are tracked, masked or
  ignored, how long it is retained, and who may read an object's history.
- **Storage layer** (`schema.sql`, migration `012_audit`) - `audit_logs` (rich,
  append-only), `audit_event_changes` (attribute deltas), `audit_policies`,
  `audit_retention_runs`, `audit_logs_archive`, and the `audit_guard` flag that
  gates deletion.
- **Query layer** (`query.js`, `export.js`, `retention.js`) - filtering,
  pagination, object/user views, aggregates, export and retention.

### Design principles

- **Append-only by construction.** Database triggers reject `UPDATE`/`DELETE`
  on `audit_logs`; the application never exposes a mutation path.
- **Never break the business write.** `capture()` swallows and logs its own
  failures so auditing can never fail a transaction it observes.
- **Secure by default.** Unknown object types inherit a safe policy; sensitive
  attribute names are masked even if no policy says so.
- **Configuration-driven.** Customers change what is captured, tracked, masked
  and retained entirely through policies, never through code.
- **Tenant isolation first.** Every read is tenant-scoped unless the caller is a
  platform administrator explicitly asking for a global view.

## 2. Data model

### `audit_logs` (live events)

The table grew from a minimal log into a rich event store. Columns added by
migration `012_audit`:

| Group | Columns |
|---|---|
| Tenant scope | `tenant_id`, `organization_id`, `plant_id`, `site_id`, `department_id` |
| Actor | `actor_id`, `actor_username`, `user_display_name` |
| Event | `action`, `event_type`, `source`, `status`, `error_message`, `reason` |
| Object | `resource_type`, `resource_id`, `object_name` |
| Change | `changed_fields`, `before_values`, `after_values`, `related_json` |
| Correlation | `correlation_id`, `request_id`, `parent_event_id` |
| Context | `ip`, `device`, `duration_ms` |
| Time | `created_at` |

`changed_fields`, `before_values`, `after_values`, `related_json` and `details`
store JSON; the query layer parses them into structured objects.

Indexes cover tenant, actor, action, event type, status, correlation, object and
source so the console stays fast on large volumes.

### `audit_event_changes` (attribute deltas)

One row per changed attribute per event, with `old_value`, `new_value`,
`value_type` and a `masked` flag. This powers the attribute diff view without
re-parsing JSON on every render and makes per-attribute queries cheap. Rows are
removed with their parent event (`ON DELETE CASCADE`) and only during retention.

### `audit_policies`

| Column | Meaning |
|---|---|
| `tenant_id` | `NULL` = system policy; otherwise tenant override |
| `object_type` | specific type or `*` wildcard |
| `record_success` / `record_failure` | whether to capture those outcomes |
| `capture_reads` / `capture_views` / `capture_downloads` | read-side capture |
| `actions_json` | allow-list of actions; empty = all |
| `track_attributes_json` | restrict the diff to these; empty = all |
| `masked_attributes_json` | extra attributes to mask |
| `ignored_attributes_json` | attributes never diffed |
| `retention_days` | archival window |
| `visibility` | `user` / `manager` / `admin` - who may read this object's history |

A unique index on `(COALESCE(tenant_id,0), object_type)` guarantees one policy
per scope.

### `audit_retention_runs`, `audit_logs_archive`, `audit_guard`

- `audit_retention_runs` records every retention execution (dry-run or real),
  its cutoff and how many rows were archived/purged.
- `audit_logs_archive` mirrors the event shape and is written only by retention.
- `audit_guard` holds a single row with `allow_delete`. The delete trigger fires
  unless this flag is `1`, which the retention service sets and resets inside a
  single transaction.

```sql
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
WHEN (SELECT allow_delete FROM audit_guard WHERE id = 1) <> 1
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
```

## 3. Event model

An event has a stable identity and a rich, typed payload:

- **action** - dotted domain verb, e.g. `object.update`, `auth.session.create`,
  `audit.export`.
- **event_type** - coarse category derived from the action
  (`CREATE`, `UPDATE`, `DELETE`, `READ`, `VIEW`, `DOWNLOAD`, `LOGIN`, `LOGOUT`,
  `PERMISSION`, `EXPORT`, `ACCESS_DENIED`, ...). Used for colour, aggregation
  and filtering in the UI.
- **source** - `api`, `ui`, `system`, `job`, `integration`.
- **status** - `success`, `failure`, `denied`.
- **object** - `resource_type` (object type code), `resource_id`, `object_name`.
- **change** - `changed_fields` plus the before/after maps and the normalised
  `audit_event_changes` rows.
- **correlation** - `correlation_id` groups a cascade (for example a release
  that starts a workflow and updates an object), `parent_event_id` links a child
  event to the one that caused it, `request_id` links to the HTTP request.
- **context** - IP, device/user-agent, duration, reason, error message.

`publicEvent()` (`events.js`) is the single serialisation boundary. It parses
the JSON columns and normalises names so the REST API and the UI never see raw
storage.

## 4. Capture pipeline

`capture(db, input)` runs the same steps regardless of caller:

1. **Normalise** action, source, status, event type and the object identifiers,
   accepting both rich (`object_type`/`object_id`) and legacy
   (`resource_type`/`resource_id`) field names.
2. **Resolve the effective policy** for the tenant and object type.
3. **Gate** - skip if the policy is disabled, if the outcome is not configured
   (`record_success`/`record_failure`), if the event type is read/view/download
   and capture is off, or if an action allow-list excludes the action.
4. **Diff** the raw before/after snapshots (`diffValues`) so a change is detected
   even for attributes that will be masked.
5. **Mask** the changed before/after maps (`maskObject`): sensitive attribute
   names are always masked; policy attributes are masked additionally.
6. **Insert** the event and its attribute changes in the caller's connection.

Because step 6 uses the passed `db`, the audit row participates in the business
transaction when one is active, and standalone otherwise.

### Domain integration helpers

- `recordObjectChange(db, {...})` - used by `server/services/objects/objects.js`
  for object create/update/status/checkout/checkin/delete/restore. Passes
  `before`/`after` snapshots and an `auditAttributes()` flattener so changes are
  recorded at the business-attribute level (`part.name`, `part.status`, ...).
- `writeAudit(db, {actor, action, resourceType, resourceId, details, ip})` -
  the original signature, preserved for every pre-existing module. It maps onto
  `capture()` so old call sites gain the rich model for free.
- `auditRoute(db, {action, objectType, objectId, objectName, reasonFrom})` -
  wraps a mutating route; on success it records the event, and it can also
  capture failures.
- `captureApiFailures(db)` - global middleware that records denied and failed
  API calls (including unauthenticated `access.unauthenticated` events) so
  denied attempts are never invisible.

## 5. Policies and resolution

`resolvePolicy(db, tenantId, objectType)` walks a cascade and returns the first
match, plus the scope that matched:

1. tenant + object type
2. tenant + `*`
3. system + object type
4. system + `*`
5. built-in safe default (`enabled`, records success/failure, downloads on,
   reads/views off, `visibility = admin`, 7-year retention)

`ensureDefaultPolicies()` idempotently seeds the system `*` baseline and a
system `object` policy (`visibility = user`) so business object history is
readable out of the box. Tenants can then add narrower overrides - the seed
ships a tenant `part` policy that turns on views, tracks named attributes,
masks `part.supplier`, and sets `visibility = user`.

Policy CRUD is exposed through the admin API and the console's **Policies** tab.

## 6. Sensitive data

Two independent mechanisms guarantee secrets never land in the audit store:

- **Regex masking by name.** `isSensitiveKey()` matches
  `pass|secret|token|key|credential|authorization|mfa|hash|salt|ssn|card|...`.
  Any attribute whose name matches is replaced with `***`, regardless of policy.
- **Policy masking.** `masked_attributes` adds tenant-specific attributes.

Masking is applied *after* the diff, so a changed secret still registers as a
change (the fact that it changed is auditable) while the stored value is `***`.
Audit events never contain passwords, tokens, session identifiers or full
credentials.

## 7. Query, export and retention

### Query

`query.js` exposes:

- `buildEventFilters(filters, scope)` - a single source of truth for filtering
  (tenant scope, organisation, object type/id, actor, action, event type,
  source, status, correlation, parent, date range and free text `q`).
- `listEvents` - paginated, sortable list.
- `getEvent` - one event with its `changes`.
- `objectHistory` - one object's timeline.
- `userActivity` - one actor's activity.
- `eventFacets` - distinct actions, sources and event types with counts.
- `auditSummary` - totals by status, by type, by source, top actors, top
  objects and activity by day.

### Export

`export.js` renders the current filter to **CSV** or **Excel** (SpreadsheetML)
and the export itself is audited (`audit.export`). Unknown formats are rejected.

### Retention

`runRetention()` iterates active policies, computes each cutoff from
`retention_days`, and (unless dry-run) copies matching rows to
`audit_logs_archive`, flips the guard flag, deletes the live rows and resets the
flag - all inside one transaction. Every run is recorded in
`audit_retention_runs`, so archival is as auditable as the events themselves.

## 8. REST API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/audit/events` | Filtered, paginated event stream |
| POST | `/api/audit/events` | Record an event manually |
| GET | `/api/audit/events/:id` | One event with attribute changes |
| GET | `/api/audit/summary` | Aggregates for the current filter |
| GET | `/api/audit/facets` | Distinct actions/sources/event types |
| GET | `/api/audit/objects/:objectType/:objectId/history` | Object timeline |
| GET | `/api/audit/users/:userId/activity` | Actor timeline |
| POST | `/api/audit/export` | Export current filter (csv/excel) |
| GET/POST | `/api/audit/policies` | List / create policies |
| GET/PUT/DELETE | `/api/audit/policies/:id` | Read / update / delete a policy |
| GET | `/api/audit/retention/runs` | Retention run history |
| POST | `/api/audit/retention/run` | Run retention (optionally dry-run) |

The legacy `GET /api/audit-logs` endpoint remains for back-compat.

### IAM permissions

Audit is a first-class IAM resource subtree:

- `iam.audit.events` (`read`, `create`)
- `iam.audit.history` (`read`)
- `iam.audit.policies` (`read`, `create`, `update`, `delete`)
- `iam.audit.export` (`execute`)
- `iam.audit.retention` (`read`, `execute`)

`platform.admin` holds all of them; `app.reader` gets `iam.audit.history:read`.
Grants are never placed on the `iam.audit` module itself, because permission
ancestry would let a module grant implicitly widen to every sub-permission.

### Visibility gate

Reading an object's history passes the route permission *and* a per-object gate
derived from the effective policy:

- `admin` - caller needs `iam.audit.events:read`
- `manager` - caller needs `iam.objects.instances:read`
- `user` - any caller with `iam.audit.history:read`; rows stay tenant-scoped

Platform administrators bypass the gate.

## 9. Frontend

The console (`web/src/pages/AuditPage.jsx`, `web/src/components/`) provides:

- **Event stream** - filters (search, action, type, status, object type, actor,
  date range), an interactive timeline, a details drawer with the attribute diff
  and related/correlation context, and pagination.
- **Overview** - status totals, events by type, activity by day, top actors and
  top objects.
- **Policies** - create/edit/delete policies, choose visibility, retention,
  tracked/masked/ignored attributes and capture flags.
- **Retention** - run retention (dry-run or real) and review past runs.
- **Export** - download the current filter as CSV or Excel.
- **Object history** - a **History** tab on the object detail page renders the
  same timeline and drawer for a single object.

All API access goes through the `audit` client in `web/src/api.js`; downloads go
through `apiDownload()` so the bearer token is sent as a header, not a URL.
Every panel handles empty, loading, error and 403 (no permission) states.

`server/platform.js` re-exports `recordAuditEvent`, `writeAudit`,
`recordObjectChange`, `resolveAuditPolicy`, `listAuditEvents`,
`auditObjectHistory`, `objectHistory`, `exportAuditEvents` and
`runAuditRetention` so other in-process modules can integrate without importing
internals.

## 10. Integration guide

To audit a new business action:

```js
import { recordObjectChange } from "../audit.js";

recordObjectChange(db, {
  actor,                       // { id, username, display_name, tenant_id }
  tenantId,
  organizationId,
  action: "invoice.approve",   // dotted verb
  objectType: "invoice",       // drives policy resolution
  objectId: invoice.id,
  objectName: invoice.number,
  before: previousSnapshot,    // plain object
  after: nextSnapshot,         // plain object
  reason: body.comment,
  ip,
});
```

The call never throws; it resolves the `invoice` policy (or the system
fallback), diffs and masks the snapshots, and stores one event plus one change
row per attribute. To also expose a read-side view, add a policy with the
appropriate `visibility`.

## 11. Testing

- `server/tests/audit.test.js` - capture, masking, correlation, policy
  resolution, immutability, querying, export and retention.
- `server/tests/audit-api.test.js` - authentication, filters, manual creation,
  object history with attribute diffs, per-object visibility, policy CRUD,
  export self-auditing, retention, tenant isolation, automatic failed-access
  capture and read-only event enforcement.

Both suites run under the standard `npm test` Node test runner.

## 12. Security invariants

- Audit records are immutable through all normal application paths; only
  retention, inside a guard-gated transaction, may remove them.
- No cross-tenant reads: queries are tenant-scoped unless a platform
  administrator asks for a global view.
- No secrets are persisted; sensitive names are masked unconditionally.
- Failed and denied actions are recorded, not silently dropped.
- The framework never bypasses existing authorization; it layers on top of it.
