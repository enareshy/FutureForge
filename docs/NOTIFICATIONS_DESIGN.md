# Notification & Communication Framework Design

The Notification & Communication Framework is a shared, tenant-aware platform
capability that turns business events into the right message, on the right
channel, for the right recipients, at the right time. It is not a mail helper
bolted onto one module: it is an event pipeline, a rule and template engine, a
recipient resolver, a preference engine, a delivery queue with retry, a reminder
and escalation scheduler, a per-user in-app inbox, and an admin console. Other
modules publish an event and the framework does the rest.

It is intentionally generic. The Workflow Engine (task assignment, task
overdue), Lifecycle (state changes, approvals, releases) and future modules all
feed the same event model, so behaviour is uniform and configurable without
touching the calling domain.

## 1. Architecture

```
   domain services                publish pipeline                  storage
 +-------------------+   +----------------------------+   +----------------------+
 | workflow/tasks    |   |  publish(event)            |   | notification_events  |
 | workflow/escal.   |-->|   - resolve rules          |-->| notification_rules   |
 | lifecycle/apply   |   |   - resolve recipients     |   | notification_templates
 | lifecycle/approv. |   |   - filter by preferences  |   | notifications        |
 +-------------------+   |   - render templates       |   | notification_deliveries
                         |   - enqueue deliveries     |   | notification_reminders
                         +----------------------------+   | notification_providers
                                       |                  | notification_preferences
                                       v                  +----------------------+
                         +----------------------------+            |
                         |  processQueue()            |            | reminders
                         |   - backoff + dead letter  |            v
                         +----------------------------+   +----------------------+
                                                          | notification_reminders
        +----------------- query / admin ----------------+ +----------------------+
        | listInbox  unreadCount  markRead  archive       |
        | listHistory  deliveryStats  retryDelivery        |
        | listReminders  sweepReminders  preview/testSend  |
        +--------------------------------------------------+
```

Layers:

- **Publish layer** (`server/services/notifications/events.js`) - the public
  `publish(event)` entry point plus `notifyUser`, `notifyGroup`, `notifyRole`
  and `simulateRule`. `publish()` never throws into the caller: failures are
  logged and swallowed so notifications can never break a business write.
- **Rule layer** (`rules.js`) - maps `event_type` (+ optional `source_module`
  and a condition) to recipients, a template, channels, priority, delivery mode
  and scheduling. Multiple rules may match a single event and all are applied.
- **Recipient layer** (`recipients.js`, `validation.js`) - resolves recipient
  definitions (users, roles, groups, organizations, object owner/creator,
  workflow/task assignee, initiator, manager, event payload, ...) into concrete
  users, with tenant scoping and initiator include/exclude handling.
- **Template layer** (`templates.js`) - versioned subject/HTML/text templates
  with a strictly allow-listed `{{root.path}}` placeholder engine, HTML
  sanitization, preview, version snapshots and test-send.
- **Preference layer** (`preferences.js`) - per-user channel toggles, frequency,
  quiet hours, self-notify, per-event overrides and administrator-mandatory
  events that bypass opt-outs.
- **Delivery layer** (`delivery.js`) - a pull-based queue with exponential
  backoff, retry, dead-lettering, direct delivery (`deliverDirect`) and
  statistics. Providers (`providers.js`) hold encrypted credentials.
- **Reminder layer** (`reminders.js`) - schedules reminders and escalations from
  rule config, sweeps due rows, repeats up to `max_repeats`, escalates to
  additional recipients and cancels reminders for completed objects.
- **Inbox layer** (`inbox.js`) - the recipient-scoped in-app inbox plus the
  administrator cross-recipient history view.
- **Storage layer** (`schema.sql`, migration `013_notifications`) - the nine
  tables listed above with idempotency and scoping indexes.
- **API/console** (`app.js`, `web/src/pages/NotificationsPage.jsx`,
  `NotificationAdminPage.jsx`) - self-service routes, admin routes, the bell and
  the admin console.

### Design principles

- **Events, not coupling.** Business modules publish a domain event; they never
  know which channels, templates or recipients exist. This keeps workflow and
  lifecycle free of communication logic.
- **Never break the business write.** `publish()` and its helpers catch and log
  their own errors.
- **Secure by default.** Templates use an allow-listed placeholder root set and
  sanitized HTML; provider secrets are encrypted at rest and never serialized;
  the inbox is strictly recipient-scoped (non-owners receive 404).
- **Multi-tenant everywhere.** Every query and command is scoped by tenant,
  organization and recipient; platform admins may opt into cross-tenant views
  with `?all=true`.
- **Configuration-driven.** Templates, rules, providers, preferences and
  reminders are data, not code.

## 2. Data model

| Table | Purpose |
| --- | --- |
| `notification_events` | Immutable record of every published event, its payload, recipients count and processing status. Idempotency key dedupes replays. |
| `notification_rules` | Event-to-recipient mapping: condition, recipient definition, template, channels, priority, delivery mode, delay, reminder and escalation config. |
| `notification_templates` | Channel/locale templates with subject, HTML, text and version. Global rows (`tenant_id` NULL) are shared; tenants can override. |
| `notification_template_versions` | Immutable snapshot written on every template create/update. |
| `notification_preferences` | Per-user channel toggles, frequency, language, quiet hours, self-notify, per-event overrides. |
| `notifications` | The rendered notification instance for a recipient (subject, body, links, object reference, read/archived/deleted state). |
| `notification_deliveries` | One queue row per channel attempt with status, attempt count, backoff schedule, error and dead-letter flag. |
| `notification_reminders` | Scheduled reminder/escalation rows with level, due/fired timestamps and status. |
| `notification_providers` | Channel provider configuration and encrypted secrets. |

## 3. The publish pipeline

```
publish(event)
  -> insert notification_events row (or return the existing idempotent row)
  -> matchRules(event)                 active rules for event_type/source_module
  -> buildRuleContext(event)           merge event + related + payload
  -> for each rule:
       - evaluateCondition(rule.condition, context)
       - resolveRecipients(rule.recipient, context, tenantId)
       - evaluatePreference(user, rule, event)   -> in_app / email / skip
       - findTemplateForEvent + renderTemplateRow (sanitize HTML)
       - enqueue(notification, deliveries)        backoff schedule per channel
       - scheduleReminderForRule(...)             when rule.reminder configured
  -> update event status, rule_count, notification_count
```

`deliverDirect()` is the bypass used by reminders, escalations and template
test-sends: it creates a notification and queues deliveries without consulting
rules, but still honours idempotency keys so repeats and sweeps are safe.

## 4. Templates and safety

- Placeholders must match `{{ root.path }}` where `root` is in
  `TEMPLATE_ROOTS` (recipient, initiator, actor, object, workflow, task,
  approval, event, tenant, organization, dueDate, reason, applicationUrl,
  priority, link, status, data, payload, context). Expressions, function calls
  and unknown roots are rejected at write time.
- Every write validates subject/HTML/text, extracts variables, rejects script
  tags and stores a sanitized HTML body plus an immutable version snapshot.
- `previewTemplate()` merges a sample context; `testSendTemplate()` renders and
  delivers to a real user for verification.

## 5. Preferences, reminders and escalations

- Preferences default to in-app + email, immediate frequency, no quiet hours and
  self-notify enabled. Rows are created lazily on first read.
- Quiet hours apply to email only and may be limited to selected weekdays.
- `mandatory` rules produce mandatory event types; `mandatoryEvents()` lists
  them so the UI can explain why they cannot be turned off.
- Reminders fire after `reminder.delay_minutes`, repeat while
  `level < max_repeats`, and escalate to `escalation.to` when configured.
  Dedupe keys (`reminder:{rule}:{event}:{recipient}:{level}` and
  `escalation:...`) make the sweep idempotent.
- `sweepReminders()` is safe to call from a scheduler; it returns
  fired/escalated/skipped counts.

## 6. Delivery, retry and providers

- Deliveries are pull-based: `processQueue()` claims queued rows, attempts
  delivery, and on failure schedules a retry with exponential backoff up to
  `MAX_ATTEMPTS`, then dead-letters. `retryDelivery()` requeues a failed or
  dead-lettered row.
- Provider secrets (password, api_key, token, client_secret) are encrypted with
  the shared `crypto.js` helper. `publicProvider()` returns only non-secret
  config plus `secrets_configured` flags.
- Provider types: `store`, `smtp`, `sendgrid`, `graph`, `webhook`.
  `testProvider()` validates configuration completeness without making network
  calls.

## 7. Authorization and tenancy

Self-service inbox and preference routes require `iam.notifications.inbox` and
`iam.notifications.preferences`. Template, rule, provider and history routes
require the matching `iam.notifications.templates / .rules / .providers /
.history` permission. Seed grants give `platform.admin` and `iam.admin` full
access and `app.reader` read/update on inbox and preferences.

The inbox is always scoped to the authenticated user and tenant; mutating a
notification that is not yours returns 404, never 403, to avoid leaking
existence. Administrative history and delivery views are tenant-scoped and can
span tenants only for platform admins with `?all=true`.

## 8. Integration

Business modules publish events and never implement their own notification
logic:

- `workflow/tasks.js` publishes `task.assigned` when a task is assigned.
- `workflow/escalations.js` publishes `task.overdue` when a task escalates.
- `lifecycle/apply.js` publishes `lifecycle.state.changed` on transitions.
- `lifecycle/approvals.js` publishes `approval.requested` for each approver and
  `change.request.rejected` when an approval is rejected.

New integrations follow the same shape:

```js
publish({
  event_type: "bom.released",
  source_module: "objects",
  object_type: "bom",
  object_id: String(bom.id),
  object_name: bom.name,
  payload: { version: bom.version },
  idempotency_key: `bom-released:${bom.id}:${bom.version}`,
});
```

## 9. API and console

Self-service: `/api/notifications` (inbox), `/unread-count`, `/meta`,
`mark-all-read`, `archive-all-read`, per-id read/unread/archive/delete, and
`/api/notification-preferences` (+ `/mandatory`).

Administration: `/api/notification-templates` (+ `/variables`, `/versions`,
`/preview`, `/test-send`, `/status`), `/api/notification-rules` (+ `/status`,
`/simulate`), `/api/notification-providers` (+ `/test`),
`/api/notification-history`, `/api/notification-events` (+ `/publish`),
`/api/notification-deliveries` (+ `/stats`, `/process`, `/:id/retry`) and
`/api/notification-reminders` (+ `/sweep`).

The web console adds a bell with an unread badge in the sidebar, an **Inbox**
page (`/notifications`) with tabs, filters, detail drawer, archive and
preferences, and a **Notification admin** page (`/notifications/admin`) with
templates, rules, providers and the delivery monitor.

## 10. Testing

`server/tests/notifications.test.js` exercises the services (template engine and
safety, recipient resolution, preference evaluation, publish pipeline, inbox
scoping, delivery queue and backoff, reminders/escalations, providers and
secret masking). `server/tests/notifications-api.test.js` exercises the REST
surface, authorization and tenant isolation. Run everything with `npm test`.
