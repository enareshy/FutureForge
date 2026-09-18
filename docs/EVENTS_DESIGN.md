# Event & Messaging Framework — Design

The Event & Messaging Framework is the platform's event-driven backbone. It gives
every module one way to publish, route and consume domain events without wiring
point-to-point integrations. It deliberately reuses existing foundations instead of
re-implementing them: long-running work is scheduled by the Background Job engine,
auditing is delegated to the Audit service, notifications and discovery consume events
as subscribers, and outbound delivery to external partners is handed to the Integration
Hub.

## Goals

- One registry for event types and versioned payload schemas.
- A single publish API with batching, async publishing, correlation and validation.
- A provider-independent bus with topics, queues and consumer groups.
- Subscription management with declarative filters.
- Transactional outbox so events survive transaction rollback and process crashes.
- Ordered, at-least-once delivery with idempotent handlers.
- Retry with backoff, dead-letter capture and controlled replay.
- Retention policies (archive/purge) and full monitoring/traceability.
- Security: tenant scoping, permission checks, classification-aware masking and
  authorization on replay.

## Architecture

```
                    ┌──────────────────────────── UI (React) ───────────────────────────┐
                    │  Event framework: overview · registry · subscriptions · deliveries  │
                    │  dead letters · replay · retention · topics & queues               │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │ /api/events, /api/v1/events
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │ Express router (server/app.js) — auth + can("iam.events.*")        │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │
        ┌───────────────┬───────────────┬───────────┼───────────┬───────────────┐
        ▼               ▼               ▼           ▼           ▼               ▼
   Registry        Publisher        Router      Consumer     Replay        Retention
   Schemas         Outbox           Topics      Deliveries   Dead-letter   Monitoring
        │               │               │           │           │               │
        └───────────────┴───────────────┴─────┬─────┴───────────┴───────────────┘
                                              ▼
                          Bus providers · Handlers · Ordering · Idempotency
                                              │
                                              ▼
                     Job engine · Audit · Notifications · Search · Integration
```

### Service layout

Event services mirror the Search, Audit and Integration module conventions: a facade
plus granular files.

| File | Responsibility |
| --- | --- |
| `server/services/events.js` | Facade re-exporting namespaces and the flat `Events` helper |
| `validation.js` | Categories, statuses, retry policy/backoff, JSON-Schema subset, masking, event-type code rules |
| `repository.js` | DTO mappers and query helpers (records, deliveries, attempts) |
| `hooks.js` | Audit, structured logging, error classification and correlation |
| `bus.js` | Provider registry (`database`, `memory`, pluggable), topics/queues/consumer groups |
| `registry.js` | Event types, schema versions, compatibility checks, default catalogue |
| `outbox.js` | Transactional outbox write/claim/process, idempotency keys |
| `subscriptions.js` | Subscribers, filters, activation, validation, test delivery |
| `handlers.js` | Handler registry and built-in bridges (search, notifications, workflow, integration) |
| `ordering.js` | Per-partition sequence numbers and out-of-order buffering |
| `publisher.js` | `publishEvent`, batch/async/correlated publish, validation, serialization, routing |
| `router.js` | Fan-out from records to deliveries/messages; `enqueueMessage` |
| `consumer.js` | Delivery claiming, handler invocation, retry/skip, attempt history |
| `deadletter.js` | Dead-letter capture, inspection and resolution |
| `replay.js` | Replay preview/creation/run/cancel with policy checks |
| `monitoring.js` | Dashboard, throughput, failures, latency, health, ordering, traceability |
| `retention.js` | Retention policies and archive/purge application |
| `jobs.js` | Worker handler registrations and the maintenance sweep |

## Data model

Migration `021_event_messaging_framework` adds the following tables:

- **Registry** — `event_registry`, `event_schemas`.
- **Records** — `event_records`, `event_records_archive`.
- **Reliability** — `event_outbox`, `event_idempotency`, `event_deliveries`,
  `event_delivery_attempts`, `event_dead_letters`.
- **Topology** — `event_topics`, `event_queues`, `event_consumer_groups`,
  `event_subscriptions`.
- **Operations** — `event_replays`, `event_retention_policies`.

All business tables carry `tenant_id` and are scoped through the same tenant filters as
the rest of the platform. Event-type codes are PascalCase domain names; all other codes
are lowercase and unique.

## Event registry and schema management

`ensureDefaultEventTypes` seeds the default catalogue across categories `object`,
`product`, `bom`, `document`, `change`, `workflow`, `lifecycle`, `manufacturing`,
`quality`, `project`, `user`, `security`, `integration` and `analytics` — for example
`ProductCreated`, `ProductReleased`, `BOMReleased`, `DocumentReleased`,
`ChangeRequestCreated`, `WorkflowStarted`, `LifecycleStateChanged` and
`ItemStatusChanged`.

Each event type declares `category`, `source_module`, optional `ordering_scope` /
`ordering_required`, `security_classification`, `retention_days` and `replay_policy`.
Schemas are versioned in `event_schemas` (JSON-Schema subset). Publishing a new version
runs `compareSchemas`, which flags breaking changes (`removed_property`, `type_changed`,
`added_required`) as incompatible; `POST /event-types/:code/compatibility` exposes the
same check to operators.

## Publishing and the transactional outbox

`publishEvent` is the primary integration point. Call it inside your business
transaction and the outbox guarantees delivery:

1. resolve (or auto-register, if enabled) the event type,
2. validate the payload against the active schema,
3. mask classified fields for logging/metadata,
4. insert `event_records` plus an `event_outbox` row (idempotent on `idempotency_key`;
   duplicates return `{ duplicate: true }`),
5. when `useOutbox` is false, route immediately.

`publishBatch`, `publishAsync` and `publishWithCorrelation` support bulk, fire-and-forget
and trace-correlated publishing. `processOutbox` claims pending rows and routes them,
retrying with backoff. The worker runs this on every maintenance sweep.

## Bus, topics, queues and consumer groups

`bus.js` exposes `registerBusProvider`, `resolveBus`, `createTopic`, `createQueue` and
`createConsumerGroup`. `database` and `memory` providers are built in; Kafka, RabbitMQ,
Azure Service Bus and AWS SNS/SQS plug in through `registerBusProvider` without changing
the publisher. `ensureDefaultTopology` installs the default topic, queue and consumer
group.

## Subscriptions and routing

`createSubscription` registers a subscriber with an optional JSON filter over event type,
tenant, organization, site, module, object and payload/metadata. `router.js` fans a
stored record out to every matching active subscription, creating `event_deliveries` for
internal subscribers and `event_messages`-style queue rows where applicable. Filters are
validated up front and can be exercised with `POST /subscriptions/:code/test`.

## Delivery, ordering and idempotency

`consumer.processDeliveries`/`processDelivery` claim due deliveries, resolve the handler
from the handler registry, invoke it and record an `event_delivery_attempts` row.
- **At-least-once**: deliveries are only marked delivered after the handler succeeds.
- **Ordering**: `ordering.js` assigns per-partition sequence numbers for types with
  `ordering_scope`; out-of-order deliveries are buffered until the gap fills or a timeout
  elapses.
- **Idempotency**: handlers can rely on the delivery `idempotency_key`; repeated
  processing is a no-op.
- **Retry**: `normalizeRetryPolicy`/`computeBackoffSeconds` drive exponential backoff;
  non-retryable error categories fail fast.
- **Skip**: `skipDelivery` force-completes a delivery without invoking the handler.

## Dead letters, replay and retention

- `deadletter.js` captures deliveries that exhaust retries into `event_dead_letters`;
  operators inspect and `resolveDeadLetter` (requeue as retry, or close).
- `replay.js` previews and creates replay batches. Replay deliveries carry a distinct
  `replay_ref` so uniqueness constraints do not suppress them; they run oldest-first and
  are rate limited. `assertReplayAllowed` blocks event types whose `replay_policy` is
  `denied` (for example `SecurityAccessDenied`).
- `retention.js` manages `event_retention_policies` (per event type, `archive` or
  `purge`). `applyRetention` moves expired records to `event_records_archive` or deletes
  them, and reports counts.
- `event_replays` tracks replay batches and their progress/statistics.

## Monitoring and traceability

`monitoring.dashboardSummary` aggregates registry, topology, delivery, dead-letter and
replay health. `healthCheck` reports bus/provider and queue depth. Dedicated endpoints
expose throughput, failures, latency percentiles, ordering state and end-to-end
traceability by correlation id.

## Job engine integration

Worker handlers (registered in `events/jobs.js`) run the framework:

| Handler | Purpose |
| --- | --- |
| `EVENT_OUTBOX_PUBLISH` | Claim and route pending outbox records |
| `EVENT_CONSUME` | Process due event deliveries |
| `EVENT_REPLAY` | Execute a replay batch |
| `EVENT_RETENTION` | Apply retention policies |
| `EVENT_MAINTENANCE` | Periodic convergence sweep (outbox, deliveries, ordering) |

## Security

- Every route is authenticated and authorized through `iam.events.*` resources.
- Tenant/organization scoping is enforced by `eventTenant`/repository filters.
- Payloads classified `confidential` or `restricted` are masked before logging and
  metadata exposure.
- Replay honors `replay_policy` and permission checks.
- Outbound propagation to external systems is delegated to the Integration Hub, which
  applies its own signing and SSRF guards.
- Every mutation is written to the audit framework under `events.*` actions.

## Permissions

The seed registers `iam.events` and nine child resources (`registry`, `publish`,
`subscriptions`, `topology`, `deliveries`, `deadletters`, `replay`, `retention`,
`monitoring`), each with create/read/update/delete (+ execute where relevant). They are
granted to the `platform` and `iamAdmin` roles by default.

## Frontend

`web/src/pages/EventsPage.jsx` is a tabbed console backed by
`web/src/components/events/EventsPanels.jsx`: overview/monitoring, event registry,
subscriptions, deliveries, dead letters, replay, retention and topics & queues. It reuses
the shared integration UI primitives (`common.jsx`). `web/src/api.js` exposes the
`events` namespace for all framework routes.

## Integration with other modules

- **Audit** — `hooks.js` writes `events.*` audit entries.
- **Notifications / Search / Workflow** — built-in handlers bridge events to these
  modules through the handler registry (`handlers.js`).
- **Integration Hub** — `integration.forward` republishes events to external systems.
- **Job engine** — all heavy/scheduled work runs as background jobs, never inline.
