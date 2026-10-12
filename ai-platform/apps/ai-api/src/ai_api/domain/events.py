"""Versioned domain events (Phase 8).

Events are described by a stable type name plus a major version. Payloads are
validated against a JSON Schema at publish time and again, defensively, at
consume time. Compatibility rules:

- **Backward compatible** (same major version): add optional fields, widen
  enums, relax constraints. Consumers must ignore unknown fields.
- **Breaking** (new major version): remove/rename fields, narrow types, change
  semantics. Publish a new type/version and migrate consumers.

The `source` is always the producer (`ai-api`). Enterprise events (e.g.
`ProductCreated`) are **not** fabricated here; adapter placeholders document the
expected integration without inventing schemas or connecting to production.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from ai_api.domain.errors import ValidationError

# --- AI event types (initial set) ---------------------------------------
KNOWLEDGE_SOURCE_REGISTERED = "KnowledgeSourceRegistered"
KNOWLEDGE_INDEX_REQUESTED = "KnowledgeIndexRequested"
KNOWLEDGE_INDEX_COMPLETED = "KnowledgeIndexCompleted"
KNOWLEDGE_INDEX_FAILED = "KnowledgeIndexFailed"
AI_REQUEST_COMPLETED = "AIRequestCompleted"
AI_EVALUATION_COMPLETED = "AIEvaluationCompleted"

# --- Reserved enterprise event types (adapters only; schemas not fabricated)
ENTERPRISE_EVENT_TYPES = (
    "ProductCreated",
    "ProductReleased",
    "BOMChanged",
    "ChangeApproved",
    "QualityIssueCreated",
    "ManufacturingOrderCreated",
    "ServiceCaseCreated",
)

AI_EVENT_TYPES = (
    KNOWLEDGE_SOURCE_REGISTERED,
    KNOWLEDGE_INDEX_REQUESTED,
    KNOWLEDGE_INDEX_COMPLETED,
    KNOWLEDGE_INDEX_FAILED,
    AI_REQUEST_COMPLETED,
    AI_EVALUATION_COMPLETED,
)


@dataclass(frozen=True, slots=True)
class EventDefinition:
    type: str
    version: str
    schema: dict[str, Any]
    description: str = ""


def _object(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": True,
    }


REGISTRY: dict[str, EventDefinition] = {
    KNOWLEDGE_SOURCE_REGISTERED: EventDefinition(
        type=KNOWLEDGE_SOURCE_REGISTERED,
        version="v1",
        description="A knowledge source was registered for a tenant.",
        schema=_object(
            {
                "source_id": {"type": "integer"},
                "code": {"type": "string"},
                "kind": {"type": "string"},
                "classification": {"type": "string"},
            },
            ["source_id", "code", "kind"],
        ),
    ),
    KNOWLEDGE_INDEX_REQUESTED: EventDefinition(
        type=KNOWLEDGE_INDEX_REQUESTED,
        version="v1",
        description="A knowledge indexing job was requested.",
        schema=_object(
            {
                "source_id": {"type": "integer"},
                "job_id": {"type": "integer"},
                "documents": {"type": "integer", "minimum": 0},
            },
            ["source_id", "job_id"],
        ),
    ),
    KNOWLEDGE_INDEX_COMPLETED: EventDefinition(
        type=KNOWLEDGE_INDEX_COMPLETED,
        version="v1",
        description="A knowledge indexing job completed successfully.",
        schema=_object(
            {
                "source_id": {"type": "integer"},
                "job_id": {"type": "integer"},
                "documents": {"type": "integer", "minimum": 0},
                "chunks": {"type": "integer", "minimum": 0},
            },
            ["source_id", "job_id"],
        ),
    ),
    KNOWLEDGE_INDEX_FAILED: EventDefinition(
        type=KNOWLEDGE_INDEX_FAILED,
        version="v1",
        description="A knowledge indexing job failed.",
        schema=_object(
            {
                "source_id": {"type": "integer"},
                "job_id": {"type": "integer"},
                "error": {"type": "string"},
            },
            ["source_id", "job_id", "error"],
        ),
    ),
    AI_REQUEST_COMPLETED: EventDefinition(
        type=AI_REQUEST_COMPLETED,
        version="v1",
        description="An AI request (chat/summarize/rag/embed) completed.",
        schema=_object(
            {
                "operation": {"type": "string"},
                "model": {"type": "string"},
                "provider": {"type": "string"},
                "status": {"type": "string"},
                "is_mock": {"type": "boolean"},
                "latency_ms": {"type": ["integer", "null"]},
                "input_tokens": {"type": "integer", "minimum": 0},
                "output_tokens": {"type": "integer", "minimum": 0},
                "total_tokens": {"type": "integer", "minimum": 0},
            },
            ["operation", "status"],
        ),
    ),
    AI_EVALUATION_COMPLETED: EventDefinition(
        type=AI_EVALUATION_COMPLETED,
        version="v1",
        description="An AI evaluation run completed.",
        schema=_object(
            {
                "code": {"type": "string"},
                "evaluation_id": {"type": ["integer", "null"]},
                "passed": {"type": "integer", "minimum": 0},
                "failed": {"type": "integer", "minimum": 0},
                "metrics": {"type": "object"},
            },
            ["code"],
        ),
    ),
}


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """Immutable, versioned event document."""

    type: str
    version: str
    tenant_id: int
    data: dict[str, Any]
    event_id: str = field(default_factory=lambda: str(uuid4()))
    source: str = "ai-api"
    occurred_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    published_at: datetime | None = None
    actor_id: int | None = None
    subject_type: str | None = None
    subject_id: str | None = None
    correlation_id: str | None = None
    request_id: str | None = None
    idempotency_key: str | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "type": self.type,
            "version": self.version,
            "tenant_id": self.tenant_id,
            "source": self.source,
            "occurred_at": self.occurred_at,
            "actor_id": self.actor_id,
            "subject_type": self.subject_type,
            "subject_id": self.subject_id,
            "correlation_id": self.correlation_id,
            "request_id": self.request_id,
            "idempotency_key": self.idempotency_key,
            "payload": self.data,
        }

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> EventEnvelope:
        return cls(
            event_id=str(record["event_id"]),
            type=record["type"],
            version=record["version"],
            tenant_id=int(record["tenant_id"]),
            data=dict(record.get("payload") or {}),
            source=record.get("source", "ai-api"),
            occurred_at=record.get("occurred_at") or datetime.now(UTC),
            published_at=record.get("published_at"),
            actor_id=record.get("actor_id"),
            subject_type=record.get("subject_type"),
            subject_id=record.get("subject_id"),
            correlation_id=record.get("correlation_id"),
            request_id=record.get("request_id"),
            idempotency_key=record.get("idempotency_key"),
        )


def resolve_definition(event_type: str) -> EventDefinition:
    definition = REGISTRY.get(event_type)
    if definition is None:
        raise ValidationError(
            "unknown event type", details={"event_type": event_type}
        )
    return definition


def validate_event(event_type: str, data: dict[str, Any]) -> EventDefinition:
    """Validate a payload against the registered schema (fail closed)."""

    import jsonschema

    definition = resolve_definition(event_type)
    try:
        jsonschema.validate(instance=data, schema=definition.schema)
    except jsonschema.ValidationError as exc:
        raise ValidationError(
            "event payload failed schema validation",
            details={"event_type": event_type, "reason": exc.message},
        ) from exc
    return definition


def build_envelope(
    event_type: str,
    *,
    tenant_id: int,
    data: dict[str, Any],
    actor_id: int | None = None,
    subject_type: str | None = None,
    subject_id: str | None = None,
    correlation_id: str | None = None,
    request_id: str | None = None,
    idempotency_key: str | None = None,
) -> EventEnvelope:
    definition = validate_event(event_type, data)
    return EventEnvelope(
        type=event_type,
        version=definition.version,
        tenant_id=tenant_id,
        data=dict(data),
        actor_id=actor_id,
        subject_type=subject_type,
        subject_id=subject_id,
        correlation_id=correlation_id,
        request_id=request_id,
        idempotency_key=idempotency_key,
    )
