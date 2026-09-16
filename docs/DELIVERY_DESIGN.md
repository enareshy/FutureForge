# Communication & Delivery Services Design

The Communication & Delivery Services module is the platform's centralized
outbound delivery infrastructure. It takes an already-rendered message (or a
schedule to produce one) and owns everything from that point on: the delivery
request record, provider selection and failover, the queue and worker,
retry/backoff, dead-letter handling, delivery tracking, reminder and escalation
execution, provider configuration, and operational monitoring.

It is deliberately **not** a second notification engine. Notification rules,
templates, recipient resolution and user preferences stay in the Notification
Management module (`docs/NOTIFICATIONS_DESIGN.md`). That module (or any other
producer) hands off a finished request; this module delivers it.

```
   producers                         delivery services                     storage
+----------------------+      +-------------------------------+   +-----------------------+
| Notification module  |      |  submitRequest / ingestNotify |   | delivery_requests     |
| Workflow / Lifecycle |----->|   - validate + idempotency    |-->| delivery_attempts     |
| other business mods  |      |   - recipient + channel       |   | delivery_provider_... |
+----------------------+      +-------------------------------+   | delivery_rate_events  |
                                             |                     | delivery_reminders    |
                                             v                     | delivery_escalations  |
                              +-------------------------------+   | delivery_runs         |
                              |  processDue (worker)          |   | delivery_alerts       |
                              |   - provider chain + failover |   +-----------------------+
                              |   - rate limit per provider   |
                              |   - transport dispatch        |
                              |   - classify failure          |
                              |   - backoff / dead letter     |
                              |   - record attempts / alerts  |
                              +-------------------------------+
                                             |
                                             v
                              +-------------------------------+
                              |  tracking / monitoring        |
                              |   metrics stats timeseries    |
                              |   provider health + alerts    |
                              |   reminder/escalation sweeps  |
                              +-------------------------------+
```

## 1. Layers

- **Vocabulary** (`server/services/delivery/validation.js`) - statuses, labels,
  channels, priorities, provider types, retry tuning, failure classification,
  backoff math and shared channel/provider guards re-exported from the
  Notification module so the two never drift.
- **Provider layer** (`providers.js`) - provider CRUD/config, encrypted secrets,
  public (secret-free) serialization, default selection, an ordered provider
  chain for failover, the failure log and provider health.
- **Request layer** (`requests.js`) - the canonical request record and its full
  tracking lifecycle, idempotent submission, listing/filtering, cancellation,
  retry, attempt history and the notification hand-off (`ingestNotification`).
- **Transport layer** (`transports.js`) - a registry mapping provider type (or
  channel) to a dispatch handler. Built-ins cover in-app, email, SMTP, SendGrid,
  Mailgun, Postmark, SES, Graph, webhook, Teams, Slack, Twilio, FCM, SMS, push
  and `custom`. New providers register a handler without touching the engine.
- **Worker layer** (`worker.js`) - pull-based `processDue` that claims due
  requests by priority and schedule, dispatches through the provider chain,
  classifies failures, applies exponential backoff, dead-letters, and raises
  alerts. An optional `createWorker` loop is provided but never started
  implicitly.
- **Rate-limit layer** (`ratelimit.js`) - per-tenant/provider sliding-window
  buckets used for bulk sends and test-sends.
- **Tracking layer** (`tracking.js`) - metrics, compact stats, daily
  timeseries, provider failure summary and queue/latency aggregates.
- **Reminder layer** (`reminders.js`) - durable reminder schedules and the
  `sweepReminders` executor, plus `completeRemindersForObject`.
- **Escalation layer** (`escalations.js`) - level-based escalation schedules and
  the `sweepEscalations` executor.
- **Alert layer** (`alerts.js`) - operational alerts raised on dead-lettering
  and provider failure, with acknowledgement.
- **Storage** (`schema.sql`, migration `014_delivery`) - the eight delivery
  tables plus dedicated delivery columns on the shared `notification_providers`
  table.
- **API / console** (`server/app.js`, `web/src/pages/DeliveryAdminPage.jsx`) -
  `/api/delivery/*` routes and the admin console.

### Design principles

- **Single responsibility.** Delivery owns scheduling and execution of outbound
  work; it owns no business rules, no templates and no preference evaluation.
- **Producers never touch the queue.** They call `submitRequest` (or the
  notification hand-off) and are done.
- **Delivery never breaks the caller.** Submission is a fast insert; all
  external I/O happens later in the worker. Worker errors are caught per
  request and logged, never thrown into a producer.
- **Idempotent by construction.** Unique idempotency, dedupe and hand-off keys
  make replays and sweeps safe.
- **Secure by default.** Provider secrets are encrypted at rest and never
  serialized to clients; provider configuration is admin-only.
- **Multi-tenant everywhere.** Every query and command is tenant-scoped;
  platform admins may opt into cross-tenant views with `?all=true`.
- **Configuration-driven and extensible.** Providers, retry tuning, rate
  limits and schedules are data; transports are a registry.

## 2. Data model

| Table | Purpose |
| --- | --- |
| `delivery_requests` | The canonical outbound unit: recipient, channel, provider, rendered content, priority, schedule, full lifecycle timestamps, error state, correlation/idempotency keys and object references. Unique `idempotency_key`. |
| `delivery_attempts` | One row per provider attempt: provider, status, error, response, latency and start/finish timestamps. Feeds latency and attempt metrics. |
| `delivery_provider_failures` | Provider failure log with a `permanent` flag. Feeds "view provider failures" and alerts. |
| `delivery_rate_events` | Sliding-window buckets (`bucket`, `tenant_id`, `provider_id`, `action`) for bulk/test-send rate limits. |
| `delivery_reminders` | Durable reminder schedules: recipient, kind (`due`/`overdue`/`repeat`), due/next-run, repeat config, status, level, escalation config and dedupe key. |
| `delivery_escalations` | Level-based escalation schedules with `after_minutes`, `max_level`, priority, recipient definition and dedupe key. |
| `delivery_runs` | Reminder/escalation execution history: kind, source, level, status, resulting request and detail. |
| `delivery_alerts` | Operational alerts (type, severity, provider, request, channel, message, `open`/`acknowledged`). |
| `notification_providers` (extended) | Shared provider table, now carrying delivery settings: `tenant_id`, `organization_id`, `is_default`, `priority`, `rate_limit_per_minute`, `max_attempts`, `backoff_seconds`, `timeout_ms`, `credential_ref`, `status`, `last_tested_at`, `last_test_status`, `last_test_message`. Transport settings live in `config_json`; secrets in `secrets_enc`. |

## 3. Request lifecycle

Statuses are stored lower-case and exposed upper-case (`status_label`):

```
CREATED -> QUEUED -> PROCESSING -> SENT -> DELIVERED
                                  \-> FAILED -> RETRYING -> (PROCESSING ...)
                                                 \-> DEAD_LETTERED
CREATED/QUEUED/PROCESSING/RETRYING -> CANCELLED
```

- `OPEN_STATUSES` = created, queued, processing, retrying.
- `TERMINAL_STATUSES` = delivered, cancelled, dead_lettered.
- `SUCCESS_STATUSES` = sent, delivered.

`submitRequest` validates the payload (channel, priority, non-empty content,
email address) and inserts in `queued` with `scheduled_at` set from
`scheduled_at` or `delay_seconds`. It is idempotent on `idempotency_key`:
resubmitting returns the existing request with `duplicate: true`.

The worker selects `status IN ('queued','retrying') AND dead_letter = 0 AND
scheduled_at <= now`, ordered by priority (`urgent` first) then schedule, then
ID. `getRequest`/`listRequests` accept a numeric id or the `request_ref` UUID.

## 4. Providers, routing and failover

- A provider declares channel, type, priority, default flag, rate limit, retry
  tuning, timeout, transport config and encrypted secrets.
- `resolveProviderChain` returns enabled providers for a channel, default first,
  then by priority. The worker prepends the request's requested
  `provider_code` when present and walks the chain on failure, so a single
  unhealthy provider does not block delivery.
- `clearOtherDefaults` (invoked on create/update) enforces at most one default
  per channel/tenant.
- Secrets (`password`, `api_key`, `token`, `client_secret`) are encrypted via
  the shared `crypto.js` helper. `publicDeliveryProvider` returns only
  non-secret config plus `secrets_configured` flags - secret values are never
  returned by the API or the console.
- `testDeliveryProvider` validates configuration completeness and records
  `last_tested_at`, `last_test_status` and `last_test_message`.

## 5. Retry, backoff and dead-lettering

- `classifyFailure` marks a failure `permanent` when the provider says so
  (`permanent: true`) or the error code is in `PERMANENT_ERROR_CODES`
  (`invalid_recipient`, `provider_not_configured`, `auth_failed`,
  `unsubscribed`, `bounced`, `blocked`, `invalid_content`). Everything else is
  transient.
- Transient failures retry with exponential backoff:
  `min(3600, base * 2^(attempt-1))` seconds, where `base` defaults to 30s and
  can be overridden per provider.
- When a request exhausts `max_attempts` (default 5, max 50) it becomes
  `dead_lettered` with `dead_letter = 1` and raises a `delivery_alerts` row.
- `retryRequest` requeues a failed or dead-lettered request by resetting the
  schedule; `cancelRequest` moves an open request to `cancelled`.
- Every attempt is recorded in `delivery_attempts`, and each provider failure is
  recorded in `delivery_provider_failures`, so operator views have a full trail.

## 6. Reminders and escalations

- `scheduleReminder` stores a durable schedule (recipient, kind, `due_at` or
  `delay_minutes`, optional `repeat_minutes`/`max_repeats`, dedupe key) without
  executing anything.
- `sweepReminders` selects due, pending reminders, submits a delivery request
  for each, then either reschedules (repeat) or completes. It returns
  `{ processed, fired, rescheduled, escalated, skipped, requests }` and is safe
  to call from a scheduler.
- `scheduleEscalation` and `sweepEscalations` do the same for level-based
  escalation: a due escalation fires a request to its recipient definition, then
  raises its level until `max_level`.
- `completeRemindersForObject` / `completeEscalationsForObject` cancel pending
  schedules once the referenced object is done, and stop-on-complete is the
  default (`stop_on_complete`).
- Every execution is written to `delivery_runs`; per-run dedupe keys
  (`reminder:{id}:{repeat_count}:{recipient}`) keep sweeps idempotent.

## 7. Tracking, metrics and alerts

`deliveryMetrics` returns totals, per-status counts (with `sent` folding in
`delivered` and `queued` folding in `created`), retry/attempt counts, average
and maximum attempt latency, average queue seconds, per-channel and per-provider
breakdowns, a daily timeseries and provider health. `deliveryStats` is the
compact shape for widgets; `deliveryTimeseries` returns the daily series;
`providerFailureSummary` groups failures by provider.

`providerHealth` reports each provider's availability, status, failure count and
last test. Dead-lettering and provider failures create `delivery_alerts`
(info/warning/critical); operators acknowledge them through the API, which
records the actor and timestamp.

## 8. Hand-off from Notification Management

`notifications/delivery.js` calls `ingestNotification` here. The hand-off
copies the recipient, channel, rendered subject/body, priority, object
references and correlation/idempotency data into a delivery request, keyed
`notification:{id}` so replays dedupe. When the notification module is asked to
deliver via the delivery service (`deliverVia = "delivery"`) it ingests and
marks the notification `processing`; otherwise it keeps its own lightweight
queue. Both paths share the same `notification_providers` table, so provider
configuration is common.

## 9. Authorization, tenancy and audit

Permissions are `iam.delivery.providers`, `iam.delivery.requests`,
`iam.delivery.reminders` and `iam.delivery.monitoring`, each with
read/create/update/delete/execute. `platform.admin` and `iam.admin` are seeded
with full access; `app.reader` gets read where appropriate.

`deliveryScope(req)` resolves the tenant filter: platform admins with
`?all=true` receive `null` (no filter), everyone else is pinned to
`req.tenantId` (or `-1`, a value that matches nothing, when absent). Cross-tenant
rows are therefore invisible by default, and a scoped lookup for another
tenant's request returns 404 rather than 403. Provider configuration changes,
request create/cancel/retry, reminder/escalation changes and alert
acknowledgements are written to the Audit & History framework.

## 10. API and console

- `GET /api/delivery/meta` - statuses, labels, channels, priorities, provider
  and transport types.
- Requests: `GET/POST /api/delivery/requests`, `GET /requests/:id`,
  `/requests/:id/attempts`, `POST /requests/:id/cancel`,
  `/requests/:id/retry`, `POST /api/delivery/process`.
- Providers: `GET/POST /api/delivery/providers`, `GET/PUT/DELETE
  /providers/:id`, `PUT /providers/:id/status`, `POST /providers/:id/test`,
  `GET /api/delivery/provider-failures`, `/api/delivery/provider-health`.
- Reminders: `GET/POST /api/delivery/reminders`, `GET/PUT /reminders/:id`,
  `POST /reminders/:id/cancel`, `POST /api/delivery/reminders/sweep`.
- Escalations: `GET/POST /api/delivery/escalations`, `GET /escalations/:id`,
  `POST /escalations/:id/cancel`, `POST /api/delivery/escalations/sweep`.
- Monitoring: `/api/delivery/metrics`, `/stats`, `/timeseries`, `/alerts`,
  `/alerts/:id/acknowledge`, `/runs`.

The console adds **Delivery services** (`/delivery/admin`) under the
Communication section, with Overview (metrics, provider health, alerts,
throughput), Requests (queue, submit, retry, cancel, attempt detail),
Providers (configuration, secrets, connection test, recent failures) and
Reminders & escalations (schedules, sweeps, execution history).

## 11. Testing

`server/tests/delivery.test.js` exercises the services (idempotent submission,
in-app delivery, webhook failure and dead-lettering, backoff, provider
failover, reminders/escalations and sweeps, rate limits, alerts and metrics).
`server/tests/delivery-api.test.js` exercises the REST surface, authorization
and tenant isolation. Run everything with `npm test`.
