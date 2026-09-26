# Integration & API Framework — Operations

Day-2 guide for running, monitoring and recovering the Integration Hub.

## Prerequisites

- Schema migration `020_integration_framework` applied automatically on start
  (`server/db.js`). Migrations are idempotent.
- At least one worker running so scheduled integrations, queued messages, event
  fan-out, webhook deliveries, transfers and health probes complete:

```bash
# Start a worker (all queues, 4-way concurrency)
npm run worker

# Only the integration queue
node scripts/job-worker.js --queues=INTEGRATION --concurrency=4
```

The worker registers the integration handlers and runs a housekeeping sweep every
15 seconds (configurable, see below).

## Worker handlers

| Handler | Purpose |
| --- | --- |
| `INTEGRATION_SYNC` | Execute a scheduled/manual integration definition |
| `INTEGRATION_MESSAGE` | Claim and process a queued message |
| `INTEGRATION_EVENT_DISPATCH` | Deliver pending internal event subscriptions |
| `INTEGRATION_TRANSFER` | Run import/export transfers |
| `INTEGRATION_HEALTH_CHECK` | Probe external-system connectivity |
| `INTEGRATION_DEAD_LETTER_RETRY` | Retry eligible dead-letter entries |

The periodic maintenance sweep (`runIntegrationMaintenance`) converges due event
deliveries, outbound webhook deliveries and queued messages so asynchronous work
continues without an operator submitting jobs manually.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `IAM_DB` | `data/iam.db` | Database file shared by API and worker |
| `HELIX_AUTH_SECRET` | — | Key for AES-256-GCM credential encryption and HMAC signing |
| `INTEGRATION_MAINTENANCE_MS` | `15000` | Worker housekeeping interval |
| `INTEGRATION_ALLOW_PRIVATE_HOSTS` | `false` | Allow SSRF guard to call private/internal hosts |

Restart the worker after changing environment variables.

## Operating the hub

1. **Register connectivity** — create credentials (secrets are encrypted and never
   shown again), then external systems, and use **Test connection**.
2. **Define integrations** — create a definition with type/direction/adapter and JSON
   configuration (`handler_code` for internal adapters, or `url` for REST/SOAP).
   Activate it.
3. **Schedule or run** — add a schedule (`interval`, `cron`, `daily`, …) or use **Run**.
   Each run appears under **Executions** with a step timeline.
4. **Wire events** — event types ship pre-seeded; create subscriptions with optional
   JSON filters. Internal subscribers target a handler; webhook subscribers target an
   outbound webhook code.
5. **Inbound webhooks** — create an inbox, choose auth (`signature`, `api_key`, `basic`,
   `none`) and the event type to publish. Point senders at
   `POST /api/v1/integration/webhooks/receive/<code>`.
6. **Transfers** — register importer/exporter handlers from business modules, then use
   **Import / Export**; preview before importing and download completed exports.

## Monitoring and alerts

- **Overview** shows definition, execution, schedule, system, event, queue, dead-letter
  and API-usage counters, success rate, p95 duration and errors by category.
- **Run health checks** probes all active systems; history is available per system.
- **Deliveries** and **Messages** expose per-item status, attempts and last error.

Signals worth alerting on:

- `executions.success_rate` dropping, or `errors_by_category` concentrating on
  `authentication`/`network`.
- Growing `message_queues.due` or `dead_letters.open`.
- `systems_health` reporting `down`/`degraded`.
- Outbound webhooks auto-disabling after repeated failures (`failure_count`).

## Retries, backoff and dead letters

Retry policy is normalised per integration/webhook and uses exponential backoff with a
cap (`computeBackoffSeconds`). When attempts are exhausted:

- Messages move to `integration_dead_letters`; retry or resolve from the UI or
  `POST /api/integration/dead-letters/:id/retry` / `/resolve`.
- Event and webhook deliveries remain retryable via
  `POST /api/integration/deliveries/:id/retry`.
- Outbound webhooks that exceed `failure_threshold` are disabled automatically;
  re-enable after fixing the endpoint.

## Replay and idempotency

- `publishEvent` accepts an `idempotency_key`; duplicate publishes return the original
  reference with `duplicate: true`.
- `POST /api/integration/events/:ref/replay` re-fans-out an event to current
  subscribers.
- Inbound webhooks deduplicate by signature and enforce a replay window
  (`replay_window_seconds`, default 300).

## Security notes

- Give the worker the same `HELIX_AUTH_SECRET` as the API or credentials cannot be
  decrypted.
- Outbound webhook and adapter URLs are validated against the SSRF guard; only set
  `INTEGRATION_ALLOW_PRIVATE_HOSTS=true` for trusted on-premise connectors.
- API client keys are hashed; rotate or revoke from the UI. The plaintext key is shown
  only once at creation/rotation.
- Review integration activity under Audit → category **Integration**
  (`/api/audit/integrations`).

## Troubleshooting

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| Integrations never run to completion | no worker running | start `npm run worker` and confirm the `INTEGRATION` queue |
| `missing_configuration` on internal adapter | `handler_code` not registered | register the handler in the owning module before starting the worker |
| Webhook shows `signature mismatch` | wrong secret or body mutated by a proxy | verify the HMAC secret and send the raw body unchanged |
| Messages pile up as `dead_letter` | handler throwing or credential invalid | inspect the dead-letter payload, fix, then retry |
| System health `degraded` with "no stored secret" | credential created without a secret | update the credential with the secret |
| API client `401`/rate limited | revoked key or exceeded `rate_limit_per_minute` | rotate the key or raise the limit |

## Verification

```bash
# Full backend suite
npm test

# Frontend build
npx vite build
```

Backend integration coverage lives in `server/tests/integration.test.js` (services) and
`server/tests/integration-api.test.js` (REST + permissions + public receiver).
