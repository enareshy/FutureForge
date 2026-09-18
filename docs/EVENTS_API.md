# Event & Messaging Framework — API Reference

Consolidated reference for every HTTP endpoint the Event & Messaging Framework exposes.
For the architecture see `docs/EVENTS_DESIGN.md`; for day-2 procedures see
`docs/EVENTS_OPERATIONS.md`.

## Conventions

| Item | Value |
| --- | --- |
| Base path | `/api/events` |
| Versioned alias | `/api/v1/events/*` (identical routes) |
| Auth | `Authorization: Bearer <token>` on every route |
| Content type | `application/json` for request bodies |
| Tenant scope | Inferred from the caller; never trust a client-supplied tenant to widen scope |
| Pagination | `?page=1&pageSize=20` (max 100) on list endpoints |
| Search/filter | `?search=`, `?status=`, `?eventTypeCode=`, `?sourceModule=`, etc. per endpoint |

Successful responses return JSON. Errors use the platform envelope:

```json
{ "error": "Event type not found", "details": null }
```

| Status | Meaning |
| --- | --- |
| `200` | Read or synchronous mutation succeeded |
| `201` | Resource created |
| `202` | Event accepted for asynchronous delivery |
| `207` | Batch partially applied (per-item results in the body) |
| `400` | Validation failed (payload/schema, bad filter, non-retryable action) |
| `401` / `403` | Missing/invalid token, or missing `iam.events.*` permission |
| `404` | Resource not found |
| `409` | Conflict (duplicate code or idempotency key) |

## Permission resources

Every route is guarded by one `iam.events.*` resource. The action names map to
create/read/update/delete (`execute` maps to update). Resources are granted to the
`platform` and `iamAdmin` roles by default.

| Resource | Governs |
| --- | --- |
| `iam.events` | Meta/vocabulary endpoint |
| `iam.events.registry` | Event types and schema versions |
| `iam.events.publish` | Records, publish, outbox |
| `iam.events.subscriptions` | Subscriptions |
| `iam.events.topology` | Topics, queues, consumer groups |
| `iam.events.deliveries` | Deliveries and attempts |
| `iam.events.deadletters` | Dead letters and bulk retry |
| `iam.events.replay` | Replay previews and batches |
| `iam.events.retention` | Retention policies and application |
| `iam.events.monitoring` | Monitoring, traceability and handlers |

## Meta

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/meta` | `iam.events:read` | Categories, statuses, retry vocabularies, bus providers, handler registry and event-type index |

## Event registry and schemas

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/event-types` | `registry:read` | List event types |
| `POST` | `/event-types` | `registry:create` | Create an event type |
| `GET` | `/event-types/:code` | `registry:read` | Get one event type (with active schema) |
| `PATCH` | `/event-types/:code` | `registry:update` | Update metadata/defaults |
| `DELETE` | `/event-types/:code` | `registry:delete` | Delete an unused type |
| `GET` | `/event-types/:code/versions` | `registry:read` | List schema versions |
| `POST` | `/event-types/:code/versions` | `registry:create` | Publish a new schema version |
| `PATCH` | `/event-types/:code/versions/:version` | `registry:update` | Activate/deprecate a version |
| `POST` | `/event-types/:code/compatibility` | `registry:read` | Compare two versions for breaking changes |

Create body:

```json
{
  "code": "ProductReleased",
  "name": "Product released",
  "category": "product",
  "source_module": "objects",
  "description": "A product revision was released",
  "ordering_scope": "object",
  "ordering_required": true,
  "security_classification": "internal",
  "retention_days": 365,
  "replay_policy": "controlled",
  "schema": { "type": "object", "required": ["id"], "properties": { "id": { "type": "string" } } },
  "example": { "id": "prd_1042" }
}
```

Version body: `{ "schema": {...}, "example": {...}, "status": "active", "notes": "..." }`.
Compatibility body: `{ "from_version": 1, "to_version": 2 }` (returns `compatible` plus
breaking reasons). See "Schema contract" in `docs/EVENTS_DESIGN.md`.

## Publishing and event records

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` | `publish:read` | List/search event records |
| `POST` | `/` | `publish:create` | Publish an event (alias of `/publish`) |
| `POST` | `/publish` | `publish:create` | Publish an event |
| `POST` | `/batch` | `publish:create` | Publish many events |
| `POST` | `/validate` | `publish:read` | Validate + build the envelope without persisting |
| `POST` | `/serialize` | `publish:read` | Serialize an envelope to the wire form |
| `GET` | `/:ref` | `publish:read` | Get an event record (with payload) |
| `POST` | `/:ref/route` | `publish:create` | Re-run routing for a stored record |
| `GET` | `/:ref/deliveries` | `deliveries:read` | List deliveries for an event |

Publish body:

```json
{
  "event_type_code": "ProductReleased",
  "payload": { "id": "prd_1042", "revision": "B" },
  "source_module": "objects",
  "source_object_type": "product",
  "source_object_id": "prd_1042",
  "source_object_revision": "B",
  "correlation_id": "corr_release_1042",
  "causation_id": null,
  "trace_id": "4f9c1e...",
  "partition_key": "prd_1042",
  "priority": "normal",
  "security_classification": "internal",
  "idempotency_key": "release:prd_1042:B",
  "metadata": { "site": "helix-plant-1" },
  "occurred_at": "2026-09-18T07:38:00.000Z"
}
```

- `POST /publish` returns `202` with `{ id, event_ref, duplicate, routed, outbox_id }`.
  A repeated `idempotency_key` returns the existing event with `duplicate: true`.
- `POST /batch` returns `207` with per-item `created`/`duplicate`/`error` entries. Body:
  `{ "events": [ { ...publish body... } ] }`.
- `POST /` and `/publish` accept `?immediate=1` (or `"immediate": true`) to route
  synchronously and `"async": false` to bypass the outbox for a single call.

## Subscriptions

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/subscriptions` | `subscriptions:read` | List subscriptions |
| `POST` | `/subscriptions` | `subscriptions:create` | Create a subscription |
| `GET` | `/subscriptions/:code` | `subscriptions:read` | Get one subscription |
| `PATCH` | `/subscriptions/:code` | `subscriptions:update` | Update subscription |
| `DELETE` | `/subscriptions/:code` | `subscriptions:delete` | Delete subscription |
| `POST` | `/subscriptions/:code/status` | `subscriptions:update` | Activate/pause (`{ "status": "active" }`) |
| `POST` | `/subscriptions/:code/validate` | `subscriptions:read` | Validate handler + filter wiring |
| `POST` | `/subscriptions/:code/test` | `subscriptions:read` | Dry-run against a sample payload |
| `GET` | `/subscriptions/:code/stats` | `subscriptions:read` | Per-subscription delivery counters |

Create body:

```json
{
  "code": "search.product-released",
  "name": "Reindex released products",
  "event_type_code": "ProductReleased",
  "handler": "search.index",
  "queue_code": "default",
  "consumer_group_code": "default",
  "status": "active",
  "filter": { "source_module": "objects", "payload": { "status": "Released" } },
  "retry_policy": { "max_attempts": 5, "backoff": "exponential", "base_seconds": 5 },
  "dead_letter_policy": "capture",
  "ordering_required": true
}
```

Filter keys: `event_type_code`, `tenant_id`, `organization_id`, `site_id`, `module`,
`object_type`, `object_id`, `payload.*` and `metadata.*`.

## Topology — topics, queues, consumer groups

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET`/`POST` | `/topics` | `topology:read` / `topology:create` | List / create topics |
| `GET`/`PATCH`/`DELETE` | `/topics/:code` | `topology:*` | Read / update / delete a topic |
| `GET`/`POST` | `/queues` | `topology:read` / `topology:create` | List / create queues |
| `GET`/`PATCH`/`DELETE` | `/queues/:code` | `topology:*` | Read / update / delete a queue |
| `GET` | `/queues/:code/stats` | `topology:read` | Queue depth and counters |
| `GET`/`POST` | `/consumer-groups` | `topology:read` / `topology:create` | List / create consumer groups |
| `GET`/`PATCH`/`DELETE` | `/consumer-groups/:code` | `topology:*` | Read / update / delete a group |

Topic body: `{ "code", "name", "description", "provider", "partitions", "retention_days", "config" }`.
Queue body: `{ "code", "name", "description", "topic_code", "provider", "max_attempts", "visibility_timeout_seconds", "config" }`.
Consumer group body: `{ "code", "name", "description", "queue_code", "consumer_count", "config" }`.

## Deliveries

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/deliveries` | `deliveries:read` | List deliveries (status/type/handler filters) |
| `GET` | `/deliveries/stats` | `deliveries:read` | Delivery counters |
| `GET` | `/deliveries/:id` | `deliveries:read` | Delivery detail with payload and attempts |
| `POST` | `/deliveries/:id/retry` | `deliveries:update` | Requeue a delivery |
| `POST` | `/deliveries/:id/skip` | `deliveries:update` | Force-complete without invoking the handler |
| `GET` | `/deliveries/:id/attempts` | `deliveries:read` | Attempt history |

## Outbox

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/outbox` | `publish:read` | List outbox rows |
| `GET` | `/outbox/stats` | `publish:read` | Outbox counters |
| `POST` | `/outbox/process` | `publish:update` | Publish pending rows now (`{ "limit": 50 }`) |
| `POST` | `/outbox/:id/retry` | `publish:update` | Reset a failed outbox row to pending |

## Dead letters

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/dead-letters` | `deadletters:read` | List dead letters |
| `GET` | `/dead-letters/stats` | `deadletters:read` | Dead-letter counters |
| `POST` | `/dead-letters/bulk-retry` | `deadletters:update` | Bulk requeue by ids or filters |
| `GET` | `/dead-letters/:id` | `deadletters:read` | Dead-letter detail |
| `POST` | `/dead-letters/:id/resolve` | `deadletters:update` | Resolve (`retry`, `close`, `ignore`) |

Bulk retry body (ids **or** filters; tenant-scoped):

```json
{
  "ids": [12, 13, 14],
  "status": "open",
  "eventTypeCode": "ProductReleased",
  "handler": "search.index",
  "queueCode": "default",
  "limit": 100,
  "reason": "handler hotfix 2026-09-18"
}
```

`limit` is clamped to 1-500. Each requeued item is audited as
`event.dead_letter.bulk_retry`. Response:

```json
{ "matched": 3, "retried": 3, "skipped": 0, "items": [ { "id": 12, "status": "retried" } ] }
```

Resolve body: `{ "action": "retry" | "close" | "ignore", "reason": "..." }`.

## Replay

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/replays` | `replay:read` | List replays |
| `POST` | `/replays/preview` | `replay:read` | Preview matching events (no side effects) |
| `POST` | `/replays` | `replay:create` | Create a replay batch |
| `GET` | `/replays/stats` | `replay:read` | Replay counters |
| `GET` | `/replays/:ref` | `replay:read` | Replay detail and progress |
| `POST` | `/replays/:ref/run` | `replay:update` | Execute a created replay |
| `POST` | `/replays/:ref/cancel` | `replay:update` | Cancel an in-flight replay |

Create body:

```json
{
  "name": "Re-drive released products",
  "event_type_code": "ProductReleased",
  "source_module": "objects",
  "from": "2026-09-01T00:00:00.000Z",
  "to": "2026-09-18T00:00:00.000Z",
  "subscription_codes": ["search.product-released"],
  "rate_limit_per_second": 25,
  "dry_run": false
}
```

`dry_run: true` (or `/preview`) matches without emitting. Event types with
`replay_policy: denied` (for example `SecurityAccessDenied`) are rejected.

## Retention

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET`/`POST` | `/retention-policies` | `retention:read` / `retention:create` | List / create policies |
| `GET`/`PATCH`/`DELETE` | `/retention-policies/:code` | `retention:*` | Read / update / delete a policy |
| `POST` | `/retention-policies/:code/apply` | `retention:update` | Apply one policy (`{ "dry_run": true }`) |
| `POST` | `/retention/apply` | `retention:update` | Apply all policies for the tenant |
| `GET` | `/retention/stats` | `retention:read` | Retention counters |

Policy body: `{ "code", "name", "event_type_code", "retention_days", "action": "archive" | "purge", "enabled": true }`.

## Monitoring and traceability

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/monitoring/dashboard` | `monitoring:read` | Registry/topology/delivery/dead-letter/replay summary |
| `GET` | `/monitoring/throughput` | `monitoring:read` | Published/delivered time series |
| `GET` | `/monitoring/failures` | `monitoring:read` | Failure breakdown by category/handler/type |
| `GET` | `/monitoring/latency` | `monitoring:read` | Delivery latency percentiles |
| `GET` | `/monitoring/health` | `monitoring:read` | Provider/queue health |
| `GET` | `/monitoring/ordering` | `monitoring:read` | Ordering buffers and gaps |
| `GET` | `/monitoring/traceability` | `monitoring:read` | End-to-end trace by correlation/trace id |

Traceability query: `?correlationId=...` or `?traceId=...`.

## Handler monitoring

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/handlers` | `monitoring:read` | Registered handlers |
| `GET` | `/handlers/stats` | `monitoring:read` | Per-handler/type activity; `?window=` and `slow` list |
| `GET` | `/handlers/:code` | `monitoring:read` | Handler detail with recent deliveries |

## End-to-end example

```bash
# 1. Publish a release event (idempotent)
curl -sS -X POST http://localhost:3001/api/events/publish \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event_type_code":"ProductReleased","source_object_type":"product","source_object_id":"prd_1042","payload":{"id":"prd_1042","revision":"B"},"idempotency_key":"release:prd_1042:B"}'

# 2. Inspect the resulting deliveries
curl -sS "http://localhost:3001/api/events/deliveries?eventTypeCode=ProductReleased" \
  -H "Authorization: Bearer $TOKEN"

# 3. Re-drive any dead letters from the same handler
curl -sS -X POST http://localhost:3001/api/events/dead-letters/bulk-retry \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"handler":"search.index","status":"open","limit":100}'

# 4. Trace the whole operation
curl -sS "http://localhost:3001/api/events/monitoring/traceability?correlationId=corr_release_1042" \
  -H "Authorization: Bearer $TOKEN"
```
