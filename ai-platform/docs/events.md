# Events

The AI platform emits versioned domain events for its own lifecycle (ingestion,
indexing, agent execution, feedback, ML runs). The design is in
`PHASE8_EVENTS.md`; this is the operational summary.

## Transport and authority

- The **durable database outbox** (`EVENT_BUS_PROVIDER=database`, default) is the
  authority for delivery, retries, ordering and replay. Events are written in
  the same transaction as the state change.
- **Kafka** (`EVENT_BUS_PROVIDER=kafka`) is an optional transport for
  cross-service propagation. Enabling it does not remove the outbox.
- The AI platform does **not** fabricate enterprise domain events; enterprise
  events remain owned by the enterprise platform.

## Topic and schema

- Default topic: `AI_EVENT_TOPIC` (`ai.platform.events`).
- Consumer group: `AI_EVENT_CONSUMER_GROUP` (`ai-api-events`).
- Each event carries a type, version, tenant, occurrence time, correlation
  (request id) and a payload conforming to the platform's event schema.

## Processing

```mermaid
graph LR
    Producer["Service writes state + event (same tx)"] --> Outbox["ai event log (outbox)"]
    Outbox --> Consumer["event_consumer worker"]
    Consumer -->|success| Done["marked delivered"]
    Consumer -->|failure| Retry["retry with backoff"]
    Retry -->|exhausted| DLQ["dead letter"]
    DLQ --> Replay["operator replay"]
```

- The consumer runs in its own process:
  `python -m ai_api.workers.event_consumer --watch`.
- Attempts are bounded by `AI_EVENT_MAX_ATTEMPTS` with backoff; exhausted events
  move to the dead-letter set.
- Replay is bounded by age (`AI_EVENT_REPLAY_MAX_AGE_DAYS`, default 7) to avoid
  re-applying stale events.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/events` | List events. |
| GET | `/events/stats` | Counts by status/type. |
| GET | `/events/dead-letters` | Dead-lettered events. |
| POST | `/events/{event_id}/replay` | Replay a dead-lettered event. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVENT_BUS_PROVIDER` | database | `database` outbox or `kafka`. |
| `KAFKA_BOOTSTRAP_SERVERS` | 127.0.0.1:9092 | Kafka brokers (when enabled). |
| `AI_EVENT_TOPIC` | ai.platform.events | Topic name. |
| `AI_EVENT_CONSUMER_GROUP` | ai-api-events | Consumer group. |
| `AI_EVENT_MAX_ATTEMPTS` | 5 | Retries before dead-lettering. |
| `AI_EVENT_BATCH_SIZE` | 20 | Batch size. |
| `AI_EVENT_POLL_SECONDS` | 5.0 | Poll interval. |
| `AI_EVENT_REPLAY_MAX_AGE_DAYS` | 7 | Replay safety window. |

## Observability

Event processing exposes `ai_events_published_total` and
`ai_events_consumed_total{consumer_group,outcome}` (see `observability.md`).
