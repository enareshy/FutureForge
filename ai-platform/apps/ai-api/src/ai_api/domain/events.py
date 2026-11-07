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
KNOWLEDGE_SOURCE_SECURITY_UPDATED = "KnowledgeSourceSecurityUpdated"
KNOWLEDGE_INDEX_REQUESTED = "KnowledgeIndexRequested"
KNOWLEDGE_INDEX_COMPLETED = "KnowledgeIndexCompleted"
KNOWLEDGE_INDEX_FAILED = "KnowledgeIndexFailed"
AI_REQUEST_COMPLETED = "AIRequestCompleted"
AI_EVALUATION_COMPLETED = "AIEvaluationCompleted"
GRAPH_ENTITY_UPSERTED = "GraphEntityUpserted"
GRAPH_ENTITY_DELETED = "GraphEntityDeleted"
GRAPH_RELATIONSHIP_CHANGED = "GraphRelationshipChanged"
PRODUCT_ITEM_UPSERTED = "ProductItemUpserted"
BOM_HEADER_UPSERTED = "BomHeaderUpserted"
BOM_LINE_CHANGED = "BomLineChanged"
BOM_RECONCILIATION_COMPLETED = "BomReconciliationCompleted"
MANUFACTURING_STRUCTURE_CHANGED = "ManufacturingStructureChanged"
MANUFACTURING_PROCESS_CHANGED = "ManufacturingProcessChanged"
MANUFACTURING_OPERATION_CHANGED = "ManufacturingOperationChanged"
QUALITY_ISSUE_CHANGED = "QualityIssueChanged"
QUALITY_INSPECTION_CHANGED = "QualityInspectionChanged"
QUALITY_ACTION_CHANGED = "QualityActionChanged"
PREDICTION_EXECUTED = "PredictionExecuted"
PREDICTION_STALE = "PredictionStale"
RECOMMENDATION_GENERATED = "RecommendationGenerated"
RECOMMENDATION_STATUS_CHANGED = "RecommendationStatusChanged"
RECOMMENDATION_OUTCOME_RECORDED = "RecommendationOutcomeRecorded"

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
    KNOWLEDGE_SOURCE_SECURITY_UPDATED,
    KNOWLEDGE_INDEX_REQUESTED,
    KNOWLEDGE_INDEX_COMPLETED,
    KNOWLEDGE_INDEX_FAILED,
    AI_REQUEST_COMPLETED,
    AI_EVALUATION_COMPLETED,
    GRAPH_ENTITY_UPSERTED,
    GRAPH_ENTITY_DELETED,
    GRAPH_RELATIONSHIP_CHANGED,
    PRODUCT_ITEM_UPSERTED,
    BOM_HEADER_UPSERTED,
    BOM_LINE_CHANGED,
    BOM_RECONCILIATION_COMPLETED,
    MANUFACTURING_STRUCTURE_CHANGED,
    MANUFACTURING_PROCESS_CHANGED,
    MANUFACTURING_OPERATION_CHANGED,
    QUALITY_ISSUE_CHANGED,
    QUALITY_INSPECTION_CHANGED,
    QUALITY_ACTION_CHANGED,
    PREDICTION_EXECUTED,
    PREDICTION_STALE,
    RECOMMENDATION_GENERATED,
    RECOMMENDATION_STATUS_CHANGED,
    RECOMMENDATION_OUTCOME_RECORDED,
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
    KNOWLEDGE_SOURCE_SECURITY_UPDATED: EventDefinition(
        type=KNOWLEDGE_SOURCE_SECURITY_UPDATED,
        version="v1",
        description=(
            "A knowledge source ACL or classification changed. Consumers must "
            "treat the authoritative store as current and use version ordering; "
            "the event is an invalidation signal, not an authority."
        ),
        schema=_object(
            {
                "source_id": {"type": "integer"},
                "version": {"type": "integer", "minimum": 1},
                "classification": {"type": "string"},
                "acl": {"type": "object"},
                "change": {"type": "string", "enum": ["acl", "classification"]},
            },
            ["source_id", "version", "classification", "acl", "change"],
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
    GRAPH_ENTITY_UPSERTED: EventDefinition(
        type=GRAPH_ENTITY_UPSERTED,
        version="v1",
        description="A knowledge graph entity was created or updated.",
        schema=_object(
            {
                "entity_id": {"type": "integer"},
                "entity_type": {"type": "string"},
                "stable_key": {"type": "string"},
                "version": {"type": "integer", "minimum": 1},
            },
            ["entity_id", "entity_type", "stable_key"],
        ),
    ),
    GRAPH_ENTITY_DELETED: EventDefinition(
        type=GRAPH_ENTITY_DELETED,
        version="v1",
        description="A knowledge graph entity was archived.",
        schema=_object(
            {
                "entity_id": {"type": "integer"},
                "entity_type": {"type": "string"},
            },
            ["entity_id", "entity_type"],
        ),
    ),
    GRAPH_RELATIONSHIP_CHANGED: EventDefinition(
        type=GRAPH_RELATIONSHIP_CHANGED,
        version="v1",
        description="A knowledge graph relationship was created, updated or archived.",
        schema=_object(
            {
                "relationship_id": {"type": "integer"},
                "relationship_type": {"type": "string"},
                "source_entity_id": {"type": "integer"},
                "target_entity_id": {"type": "integer"},
            },
            ["relationship_id", "relationship_type"],
        ),
    ),
    PRODUCT_ITEM_UPSERTED: EventDefinition(
        type=PRODUCT_ITEM_UPSERTED,
        version="v1",
        description="A product/part/assembly item was created or updated.",
        schema=_object(
            {
                "item_id": {"type": "integer"},
                "item_type": {"type": "string"},
                "item_key": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["item_id", "item_type", "item_key"],
        ),
    ),
    BOM_HEADER_UPSERTED: EventDefinition(
        type=BOM_HEADER_UPSERTED,
        version="v1",
        description="A BOM header was created or updated.",
        schema=_object(
            {
                "header_id": {"type": "integer"},
                "bom_type": {"type": "string"},
                "bom_key": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["header_id", "bom_type", "bom_key"],
        ),
    ),
    BOM_LINE_CHANGED: EventDefinition(
        type=BOM_LINE_CHANGED,
        version="v1",
        description="A BOM line was created, updated or soft-deleted.",
        schema=_object(
            {
                "header_id": {"type": "integer"},
                "line_id": {"type": "integer"},
                "child_item_id": {"type": "integer"},
                "deleted": {"type": "boolean"},
            },
            ["header_id", "line_id"],
        ),
    ),
    BOM_RECONCILIATION_COMPLETED: EventDefinition(
        type=BOM_RECONCILIATION_COMPLETED,
        version="v1",
        description="An EBOM->MBOM reconciliation completed.",
        schema=_object(
            {
                "reconciliation_id": {"type": "integer"},
                "source_header_id": {"type": "integer"},
                "target_header_id": {"type": ["integer", "null"]},
                "status": {"type": "string"},
                "exceptions": {"type": "integer", "minimum": 0},
            },
            ["reconciliation_id", "source_header_id", "status"],
        ),
    ),
    MANUFACTURING_STRUCTURE_CHANGED: EventDefinition(
        type=MANUFACTURING_STRUCTURE_CHANGED,
        version="v1",
        description="A manufacturing structure record (plant/line/work centre) changed.",
        schema=_object(
            {
                "kind": {"type": "string"},
                "entity_id": {"type": "integer"},
                "key": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["kind", "entity_id", "key"],
        ),
    ),
    MANUFACTURING_PROCESS_CHANGED: EventDefinition(
        type=MANUFACTURING_PROCESS_CHANGED,
        version="v1",
        description="A manufacturing process or process revision changed.",
        schema=_object(
            {
                "process_id": {"type": "integer"},
                "process_key": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["process_id", "process_key"],
        ),
    ),
    MANUFACTURING_OPERATION_CHANGED: EventDefinition(
        type=MANUFACTURING_OPERATION_CHANGED,
        version="v1",
        description="A manufacturing operation or its sequencing changed.",
        schema=_object(
            {
                "operation_id": {"type": "integer"},
                "process_id": {"type": "integer"},
                "created": {"type": "boolean"},
            },
            ["operation_id", "process_id"],
        ),
    ),
    QUALITY_ISSUE_CHANGED: EventDefinition(
        type=QUALITY_ISSUE_CHANGED,
        version="v1",
        description="A quality issue/nonconformance was created or updated.",
        schema=_object(
            {
                "issue_id": {"type": "integer"},
                "issue_key": {"type": "string"},
                "issue_type": {"type": "string"},
                "status": {"type": "string"},
                "severity": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["issue_id", "issue_key", "status"],
        ),
    ),
    QUALITY_INSPECTION_CHANGED: EventDefinition(
        type=QUALITY_INSPECTION_CHANGED,
        version="v1",
        description="A quality inspection was created or updated.",
        schema=_object(
            {
                "inspection_id": {"type": "integer"},
                "inspection_key": {"type": "string"},
                "status": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["inspection_id", "status"],
        ),
    ),
    QUALITY_ACTION_CHANGED: EventDefinition(
        type=QUALITY_ACTION_CHANGED,
        version="v1",
        description="A corrective/preventive (CAPA) action was created or updated.",
        schema=_object(
            {
                "action_id": {"type": "integer"},
                "action_key": {"type": "string"},
                "issue_id": {"type": "integer"},
                "status": {"type": "string"},
                "action_type": {"type": "string"},
                "created": {"type": "boolean"},
            },
            ["action_id", "status"],
        ),
    ),
    PREDICTION_EXECUTED: EventDefinition(
        type=PREDICTION_EXECUTED,
        version="v1",
        description="A prediction or rule-based risk assessment was produced.",
        schema=_object(
            {
                "prediction_id": {"type": "integer"},
                "prediction_key": {"type": "string"},
                "prediction_type": {"type": "string"},
                "method": {"type": "string"},
                "risk_category": {"type": "string"},
                "status": {"type": "string"},
            },
            ["prediction_id", "prediction_type", "method", "risk_category"],
        ),
    ),
    PREDICTION_STALE: EventDefinition(
        type=PREDICTION_STALE,
        version="v1",
        description="A prediction became stale after expiry or a source change.",
        schema=_object(
            {
                "prediction_id": {"type": "integer"},
                "prediction_type": {"type": "string"},
                "reason": {"type": "string"},
            },
            ["prediction_id", "reason"],
        ),
    ),
    RECOMMENDATION_GENERATED: EventDefinition(
        type=RECOMMENDATION_GENERATED,
        version="v1",
        description="A recommendation was generated from observed evidence.",
        schema=_object(
            {
                "recommendation_id": {"type": "integer"},
                "recommendation_key": {"type": "string"},
                "prediction_id": {"type": "integer"},
                "severity": {"type": "string"},
                "priority": {"type": "string"},
            },
            ["recommendation_id", "recommendation_key"],
        ),
    ),
    RECOMMENDATION_STATUS_CHANGED: EventDefinition(
        type=RECOMMENDATION_STATUS_CHANGED,
        version="v1",
        description="A recommendation changed lifecycle status.",
        schema=_object(
            {
                "recommendation_id": {"type": "integer"},
                "recommendation_key": {"type": "string"},
                "from_status": {"type": "string"},
                "to_status": {"type": "string"},
            },
            ["recommendation_id", "to_status"],
        ),
    ),
    RECOMMENDATION_OUTCOME_RECORDED: EventDefinition(
        type=RECOMMENDATION_OUTCOME_RECORDED,
        version="v1",
        description="The measured outcome of a completed recommendation was recorded.",
        schema=_object(
            {
                "recommendation_id": {"type": "integer"},
                "recommendation_key": {"type": "string"},
                "outcome": {"type": "string"},
                "risk_reduced": {"type": "boolean"},
            },
            ["recommendation_id"],
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
