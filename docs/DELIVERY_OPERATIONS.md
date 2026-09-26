# Communication & Delivery Services Operations Guide

This guide covers day-2 operation of the delivery services module: running the
queue worker and schedulers, configuring providers, monitoring health,
recovering dead-lettered requests, managing alerts, and troubleshooting.

The module is pull-based by design. Nothing runs on a hidden timer: an operator,
scheduler or dedicated process must invoke the queue processor and the
reminder/escalation sweeps. This keeps the platform predictable and avoids
surprise background traffic.

## 1. What must be scheduled

| Action | Service call | HTTP endpoint |
| --- | --- | --- |
| Process the delivery queue | `processDue(db, { limit })` | `POST /api/delivery/process` |
| Reminder sweep | `sweepReminders(db, { limit })` | `POST /api/delivery/reminders/sweep` |
| Escalation sweep | `sweepEscalations(db, { limit })` | `POST /api/delivery/escalations/sweep` |

In development, `npm run dev` starts the API and web console; the console's
**Process queue** and **Sweep due schedules** buttons invoke the same calls, so
you can operate delivery interactively.

## 2. Running a schedule

### Option A: cron / external scheduler

Call the endpoints as an authenticated platform/admin principal. Keep the
interval short enough for your latency target (a queue can be processed every
minute; sweeps every minute is also fine because they are idempotent).

```bash
# Process the delivery queue every minute
* * * * * curl -s -X POST http://localhost:3001/api/delivery/process -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"limit":200}' >/dev/null

# Sweep reminders and escalations every minute
* * * * * curl -s -X POST http://localhost:3001/api/delivery/reminders/sweep -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"limit":200}' >/dev/null
* * * * * curl -s -X POST http://localhost:3001/api/delivery/escalations/sweep -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"limit":200}' >/dev/null
```

### Option B: in-process worker loop

For a single dedicated process, use `createWorker`. It runs `processDue` on an
interval, unrefs its timer (so it never keeps a process alive by itself) and
supports graceful shutdown.

```js
import { openDatabase, migrate } from "./server/db.js";
import { ensureDefaultProviders } from "./server/services/delivery.js";
import { createWorker } from "./server/services/delivery/worker.js";

const db = openDatabase(process.env.IAM_DB || "data/iam.db");
migrate(db);
ensureDefaultProviders(db);

const worker = createWorker(db, { intervalMs: 15000, batchSize: 100 });
worker.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await worker.stop();
    process.exit(0);
  });
}
```

The sweeps are not started by `createWorker`; schedule them separately with the
same pattern (`setInterval`) or use the cron endpoints above. Always confirm the
queue is drained and there are no open alerts after enabling a worker.

## 3. Provider configuration

Providers are admin-only. Configure them in the console under
**Delivery services -> Providers**, or through the API.

1. Create or edit a provider: channel, type, priority, optional default, rate
   limit, max attempts, backoff and timeout.
2. Fill the transport config (host/port/from, webhook URL, region, endpoint).
3. Enter secrets (password, api key, token, client secret). Secrets are
   encrypted at rest and are never returned by the API - leave a field blank to
   keep the stored value.
4. Run **Test** to validate configuration completeness. The result and timestamp
   are recorded as `last_test_status` / `last_tested_at` and shown in provider
   health.
5. Keep inactive channels disabled (`status = inactive`) until credentials are
   ready. Seeded examples `teams-webhook` and `slack-webhook` are inactive by
   default.

At most one default provider per channel and tenant. Setting a new default
clears the previous one automatically.

## 4. Rate limits

- Set `rate_limit_per_minute` per provider to cap throughput. `0` means
  unlimited.
- The worker checks the provider's sliding-window bucket before dispatching. If
  the limit is reached it treats the attempt as a transient `rate_limited`
  failure and moves to the next provider in the chain, or retries with backoff.
- `POST /api/delivery/providers/:id/test` and bulk submissions are also rate
  limited. Adjust limits during bulk campaigns and after incident recovery;
  `pruneRateEvents` (available as a service call) removes old buckets.

## 5. Monitoring

The **Overview** tab (`/delivery/admin`) and the monitoring endpoints provide:

- **Throughput/counters**: total, queued, processing, sent, failed, retrying,
  cancelled, dead-lettered.
- **Latency**: average and maximum attempt duration, average queue seconds.
- **Provider health**: availability percentage, available/total providers,
  per-provider status, failure counts and last test.
- **Alerts**: open alert count and the recent alert list.
- **Timeseries**: daily total/sent/failed.

Suggested alerting thresholds:

| Signal | Warning | Critical |
| --- | --- | --- |
| Open critical alerts | >= 1 | >= 3 |
| Provider availability | < 90% | < 50% |
| Dead-lettered in a window | > 0 | rising trend |
| Average queue seconds | > 120 | > 600 |

`GET /api/delivery/provider-failures` lists individual failures with a
`permanent` flag; `providerFailureSummary` groups counts by provider.

## 6. Dead-letter recovery

Requests land in `dead_lettered` when they exhaust `max_attempts`. To recover:

1. Inspect the request and its attempts in **Requests -> View**. The attempt
   table shows the provider, error code/message and duration per attempt.
2. Fix the root cause: correct an invalid recipient, fix provider credentials or
   endpoint, lift a rate limit, re-enable a disabled provider.
3. Retry the request with `POST /api/delivery/requests/:id/retry` (the
   **Retry** button) which requeues it for the next worker pass.
4. Confirm it reaches `sent`/`delivered` and acknowledge any related alert.

Permanent failures (`invalid_recipient`, `auth_failed`, `bounced`, `blocked`,
`invalid_content`, `unsubscribed`, `provider_not_configured`) will not succeed
until the underlying data or configuration is corrected.

## 7. Reminders and escalations

- Schedules are created by producers (or the console) and executed only by
  `sweepReminders` / `sweepEscalations`.
- Repeating reminders reschedule themselves until `max_repeats`; escalations
  raise their level until `max_level`.
- When a referenced object completes, call
  `completeRemindersForObject` / `completeEscalationsForObject` so pending
  schedules stop (stop-on-complete is the default).
- Every execution is visible under **Execution history** and in `delivery_runs`.
- Sweeps are idempotent via dedupe keys, so a missed or double cron run is
  harmless.

## 8. Alerts and acknowledgement

Dead-lettering and provider failures raise alerts (`info`/`warning`/`critical`).

1. Review open alerts in **Overview -> Recent alerts** or `GET /api/delivery/alerts`.
2. Resolve the underlying cause.
3. Acknowledge with `POST /api/delivery/alerts/:id/acknowledge` (the
   **Acknowledge** button). The actor and timestamp are recorded and audited.

## 9. Security and tenancy in operations

- Provider configuration and all monitoring routes require the corresponding
  `iam.delivery.*` permission; secrets never cross the API boundary.
- Tenant scoping is enforced on every query. The **All tenants** toggle sends
  `?all=true` and only has an effect for platform admins.
- All administrative changes are written to the Audit & History framework;
  review them under `/audit`.

## 10. Retention and backups

- Delivery history grows with volume. Archive or prune `delivery_requests`,
  `delivery_attempts`, `delivery_provider_failures`, `delivery_rate_events`,
  `delivery_runs` and acknowledged `delivery_alerts` on a schedule that matches
  your compliance policy. Prune rate events aggressively (hours), keep delivery
  history longer (for trend reporting), and keep the audit trail per policy.
- Include the delivery tables in database backups alongside the rest of the
  platform data. Provider secrets are encrypted with the platform key, so back
  up that key material separately; without it, stored credentials are
  unrecoverable.

## 11. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Requests stay `queued` | No worker/scheduler is running | Run `POST /api/delivery/process` or start the worker loop |
| `provider_not_configured` | Missing transport config or secret, or no enabled provider | Complete provider configuration and run Test; ensure a provider is enabled for the channel |
| Repeated `rate_limited` | Provider limit reached | Raise `rate_limit_per_minute`, add a failover provider, or slow the producer |
| Everything fails for a channel | Default provider unhealthy/disabled | Check provider health, enable or switch the default, retry affected requests |
| `invalid_recipient` | Bad address or missing email recipient | Correct the recipient; this is permanent, do not expect retries to fix it |
| Alerts keep re-opening | Root cause unresolved | Fix the provider/recipient, then retry and acknowledge |
| Reminders never fire | Sweep not scheduled | Schedule `sweepReminders` and confirm `next_execution`/`due_at` |
| Cross-tenant rows unexpected | Platform admin with **All tenants** enabled | Uncheck **All tenants** (`?all=true` removed) |

For any delivery outage, first check open alerts and provider health, then the
queue counters and recent attempts; the attempt trail usually identifies the
broken hop.
