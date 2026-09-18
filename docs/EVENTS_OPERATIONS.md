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
3. **Subscribe** — create a subscription with a handler code and an optional JSON filter
   (event type, tenant, organization, site, module, object, payload/metadata). Validate,
   test and activate it from **Subscriptions**.
4. **Watch deliveries** — **Deliveries** shows pending/failed rows with attempt history.
   Retry or skip individual deliveries; **Dead letters** captures rows that exhausted
   retries.
5. **Recover** — resolve dead letters (retry or close), then re-run affected work. For a
   controlled re-drive of history, create a **Replay** (preview first); denied-policy
   event types such as `SecurityAccessDenied` cannot be replayed.
6. **Govern** — tune **Retention** policies (archive/purge per event type) and monitor
   the **Overview** dashboard, throughput, latency, ordering and traceability views.

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
