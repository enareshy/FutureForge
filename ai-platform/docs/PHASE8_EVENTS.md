# Phase 8 - Event streaming and background processing

Phase 8 gives the AI layer a durable, versioned domain-event pipeline and a
background consumer, so AI activity is observable, replayable, and decoupled
from request handling. It reuses the same shared PostgreSQL as the rest of the
platform; Kafka is an optional transport, not a requirement.

## Model

**Durable DB outbox is the source of truth.** An event is written to
`ai.events` exactly once (unique `event_id`), then delivered to each consumer
group tracked in `ai.event_deliveries`. Delivery is at-least-once and made
idempotent per `(event_id, consumer_group)`. Retries are bounded by
`AI_EVENT_MAX_ATTEMPTS`; exhausted events are copied to
`ai.event_dead_letters` and can be replayed.

```text
service -> EventPublisher.publish(envelope)
  -> ai.events (durable, versioned, jsonschema-validated)
  -> EventConsumer.poll()  (per consumer group, idempotent, bounded retries)
       delivered -> ai.event_deliveries(status=delivered)
       failed    -> attempts++ ; when max_attempts reached -> ai.event_dead_letters
```

Kafka (`EVENT_BUS_PROVIDER=kafka`, requires the optional `aiokafka` dependency)
is a fan-out transport layered on top of the durable store; when it is
unavailable the DB path still records and delivers events. `memory` is used by
the test suite.

## Event types

AI event types (version `v1`, payloads validated with JSON Schema):

| Type | Emitted when |
| --- | --- |
| `KnowledgeSourceRegistered` | A knowledge source is created |
| `KnowledgeIndexRequested` | An index/ingest job is enqueued |
| `KnowledgeIndexCompleted` | An index job succeeds |
| `KnowledgeIndexFailed` | An index job fails |
| `AIRequestCompleted` | A chat/RAG/embed operation completes |
| `AIEvaluationCompleted` | An evaluation run completes |

`ENTERPRISE_EVENT_TYPES` in `domain/events.py` reserves the enterprise catalogue
(e.g. `ProductCreated`) for **future** integration. The AI platform does not
fabricate or emit enterprise events it does not own.

Every envelope carries `tenant_id` (always), and optional `actor_id`,
`correlation_id`, `request_id`, `subject_type`/`subject_id`, and
`idempotency_key`. Events are **tenant-scoped on read**.

## Endpoints

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/ai/events` | `ai.audit:read` | List events (tenant-scoped) |
| `GET` | `/api/v1/ai/events/dead-letters` | `ai.audit:read` | List dead-lettered events |
| `GET` | `/api/v1/ai/events/stats` | `ai.audit:read` | Per-group pending/delivered/failed/dead |
| `POST` | `/api/v1/ai/events/{event_id}/replay` | `ai.audit:read` | Reset a delivery for re-processing |

Replay is bounded by `AI_EVENT_REPLAY_MAX_AGE_DAYS` (default 7).

## Consumer worker

```bash
# Drain the current backlog once (idempotent, safe to re-run)
python -m ai_api.workers.event_consumer --once

# Poll continuously
python -m ai_api.workers.event_consumer --watch
```

The consumer records `event.observed` per event and a `event.batch_processed`
summary, propagates correlation IDs, and shuts down gracefully.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVENT_BUS_PROVIDER` | `database` | `database` / `kafka` / `memory` |
| `KAFKA_BOOTSTRAP_SERVERS` | `127.0.0.1:9092` | Kafka transport |
| `AI_EVENT_TOPIC` | `ai.platform.events` | Kafka topic |
| `AI_EVENT_CONSUMER_GROUP` | `ai-api-events` | Default consumer group |
| `AI_EVENT_MAX_ATTEMPTS` | `5` | Retries before dead-lettering |
| `AI_EVENT_BATCH_SIZE` | `20` | Events per poll |
| `AI_EVENT_POLL_SECONDS` | `5` | Idle poll interval |
| `AI_EVENT_REPLAY_MAX_AGE_DAYS` | `7` | Replay window |

## Verification

- `tests/test_events.py` - registry/validation, publisher, idempotent consumer,
  retries, dead-lettering, replay, memory store.
- `tests/test_api_v1.py::test_event_observability_endpoints` - HTTP surface.
- Migration `0006_ai_events.sql`; rolled-back DB check
  (`/tmp/opencode/phase8_repo_verify.py`) prints `PHASE8 REPO VERIFY: OK`.

Live check performed against the shared PostgreSQL: register a source + ingest
produced `KnowledgeSourceRegistered`, `KnowledgeIndexRequested`,
`KnowledgeIndexCompleted` (shared correlation ID); the consumer drained
`pending: 3 -> delivered: 3`, a second run delivered `0` (idempotent), and
replaying one event returned `pending: 1` and was re-delivered.
