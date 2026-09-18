# Event & Messaging Framework — Operations

Day-2 guide for running, monitoring and recovering the Event & Messaging Framework.

## Prerequisites

- Schema migration `021_event_messaging_framework` applied automatically on start
  (`server/db.js`). Migrations are idempotent.
- At least one worker running so outbox records are published, deliveries are consumed,
  replays run and retention is applied:

```bash
# Start a worker (all queues, 4-way concurrency)
npm run worker

# Only the events queue
node scripts/job-worker.js --queues=EVENTS --concurrency=4
```

The worker registers the event handlers and runs a housekeeping sweep every 15 seconds
(configurable, see below).

## Worker handlers

| Handler | Purpose |
| --- | --- |
| `EVENT_OUTBOX_PUBLISH` | Publish pending transactional-outbox events and fan out to subscriptions |
| `EVENT_CONSUME` | Claim and process due deliveries with retry, ordering and dead-letter handling |
| `EVENT_REPLAY` | Execute a validated, controlled replay |
| `EVENT_RETENTION` | Archive/purge events past their retention policy |
| `EVENT_MAINTENANCE` | Reclaim stale leases, prune published outbox rows and purge resolved dead letters |

The periodic maintenance sweep (`runEventMaintenance`) converges pending outbox rows,
due deliveries and ordering buffers, so asynchronous work continues without an operator
submitting jobs manually.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `IAM_DB` | `data/iam.db` | Database file shared by API and worker |
| `EVENT_MAINTENANCE_MS` | `15000` | Worker housekeeping interval |

Restart the worker after changing environment variables.

## Operating the framework

1. **Review the registry** — event types ship pre-seeded under **Event registry**. Add a
   schema version when a payload changes; run the compatibility check before activating
   a subscriber that depends on the new version.
2. **Publish** — call `Events.publish` from module code inside the business transaction,
   or use **Publish** in the console (`POST /api/events/publish`). The outbox guarantees
   the event is delivered even if the request process restarts.
3. **Subscribe** — event types ship pre-seeded, along with a small set of active default
   subscriptions (search reindex on lifecycle changes, workflow bindings, analytics, and
   release-event forwarding to the Integration Hub). Add your own subscription with a
   handler code and an optional JSON filter (event type, tenant, organization, site,
   module, object, payload/metadata). Validate, test and activate it from
   **Subscriptions**.
4. **Watch deliveries** — **Deliveries** shows pending/failed rows with attempt history.
   Retry or skip individual deliveries; **Dead letters** captures rows that exhausted
   retries.
5. **Recover** — resolve dead letters (retry or close), then re-run affected work. For a
   controlled re-drive of history, create a **Replay** (preview first); denied-policy
   event types such as `SecurityAccessDenied` cannot be replayed.
6. **Govern** — tune **Retention** policies (archive/purge per event type) and monitor
   the **Overview** dashboard, throughput, latency, ordering and traceability views.

## Deployment

The framework has no separate broker to install for the default configuration: events,
outbox rows, deliveries and topology live in the same SQLite database as the rest of the
platform, and the worker consumes them from the shared job queues.

| Component | Required | Notes |
| --- | --- | --- |
| API server (`npm start`) | Yes | Serves `/api/events` and writes the outbox transactionally with business data |
| Worker (`npm run worker`) | Yes | Publishes the outbox, consumes deliveries, runs replay/retention/maintenance |
| Database (`IAM_DB`) | Yes | API and every worker must point at the same file |

Start-up order and idempotency:

1. Start the API server. `migrate()` applies `021_event_messaging_framework` and the
   default registry/topology/subscriptions are seeded via `ensureEventFoundation`.
2. Start one or more workers. Each register the event handlers and begin the maintenance
   sweep. Restarting is safe: leases are reclaimed and outbox/idempotency rows prevent
   duplicate work.
3. Workers shut down gracefully on `SIGTERM`, draining in-flight handlers before exit.

Deployment checklist:

- Set `IAM_DB` to an absolute durable path on both API and worker.
- Run at least one worker (the API alone never publishes the outbox).
- Keep API and worker clocks in sync — retry/lease logic is timestamp based.
- If using the `memory` bus provider, remember it is process-local and non-durable; use
  `database` (the default) for production.
- Back up the database before enabling `purge` retention policies.
- Do not run `JOB_DEMO_HANDLERS=1` in production.

## Scaling

- **Workers are horizontally scalable.** Add more `npm run worker` processes to raise
  consumption throughput; delivery claiming uses leases so two workers never process the
  same delivery concurrently.
- **Scale outbox and delivery consumers independently** with queue restrictions:

```bash
# Dedicated event worker for publish + consume only
node scripts/job-worker.js --queues=EVENTS --concurrency=8
```

- **Ordering is per scope, not global.** `ordering_scope` of `object`/`partition` lets
  unrelated objects process in parallel; `global` scope serializes a type and should be
  used sparingly.
- **Partition keys spread load.** Supply `partition_key` on high-volume events so
  sequence work and buffering stay localized.
- **Bulk operations scale via the API.** `POST /api/events/batch` and
  `POST /api/events/dead-letters/bulk-retry` accept bounded batches (bulk retry is clamped
  to 1-500 per call); loop client-side rather than submitting unbounded payloads.
- **Replay is rate limited.** Large replays run as background jobs with a configured
  `rate_limit_per_second`; run them off-peak and watch delivery latency.
- **Retention and maintenance are cheap but not free.** Increase
  `EVENT_MAINTENANCE_MS` on very large databases so sweeps are less frequent.

Signals to watch before scaling:

| Signal | Action |
| --- | --- |
| Outbox depth rising | Add event workers or lower `EVENT_MAINTENANCE_MS` |
| Delivery backlog rising | Raise `--concurrency` or add workers |
| High `out_of_order` count | Check hot `global`-scoped types; prefer object/partition scope |
| Dead-letter rate rising | Fix handlers before scaling — more workers also multiply failures |

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Events stay `pending` in the outbox | No worker running, or `EVENT_MAINTENANCE_MS` too large | Start a worker / lower the interval; run `POST /api/events/outbox/process` |
| Deliveries repeatedly fail | Handler error or wrong handler code | Inspect attempts, fix the handler, retry; check dead letters |
| Out-of-order deliveries buffered | A gap in the partition sequence | Wait for the gap or timeout, or replay the missing events |
| Publish returns `duplicate: true` | Same `idempotency_key` already seen | Expected; the original event is preserved |
| Replay rejected | Event type `replay_policy` is `denied` or permission missing | Use an allowed type / grant `iam.events.replay` |
| Payload rejected on publish | Schema validation failed | Fix the payload or publish a compatible new schema version |

## Health

- `GET /api/events/monitoring/health` — provider/queue health.
- `GET /api/events/monitoring/dashboard` — registry, topology, delivery, dead-letter and
  replay summary.
- `GET /api/events/monitoring/throughput` / `failures` / `latency` / `ordering` /
  `traceability` — focused operational views.
- `GET /api/events/outbox/stats`, `/deliveries/stats`, `/dead-letters/stats`,
  `/replays/stats`, `/retention/stats` — per-area counters.

## Maintenance

```bash
# Publish pending outbox records now
curl -X POST http://localhost:3001/api/events/outbox/process -H "Authorization: Bearer <token>"

# Apply all retention policies now
curl -X POST http://localhost:3001/api/events/retention/apply -H "Authorization: Bearer <token>"
```

The worker performs both automatically on every sweep. See
`docs/EVENTS_DESIGN.md` for the architecture and `docs/INTEGRATION_OPERATIONS.md` for
external delivery.
