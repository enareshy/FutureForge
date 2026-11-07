from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    AuditServiceDep,
    EventStoreDep,
    PrincipalDep,
    SettingsDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.schemas.events import (
    DeadLetterOut,
    EventOut,
    EventStatsOut,
    ReplayResult,
)
from ai_api.security.permissions import CAP_AUDIT_READ
from ai_api.telemetry.logging import request_id_var

router = APIRouter(tags=["events"], dependencies=[Depends(enforce_rate_limit)])


@router.get(
    "/events",
    response_model=list[EventOut],
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def list_events(
    store: EventStoreDep,
    principal: PrincipalDep,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[EventOut]:
    rows = await store.list_events(require_tenant(principal), limit=limit)
    return [EventOut(**row) for row in rows]


@router.get(
    "/events/dead-letters",
    response_model=list[DeadLetterOut],
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def list_dead_letters(
    store: EventStoreDep,
    principal: PrincipalDep,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[DeadLetterOut]:
    rows = await store.list_dead_letters(require_tenant(principal), limit=limit)
    return [DeadLetterOut(**row) for row in rows]


@router.get(
    "/events/stats",
    response_model=EventStatsOut,
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def event_stats(
    store: EventStoreDep,
    principal: PrincipalDep,
    settings: SettingsDep,
    consumer_group: str | None = Query(default=None, max_length=200),
) -> EventStatsOut:
    group = consumer_group or settings.ai_event_consumer_group
    stats = await store.delivery_stats(require_tenant(principal), group)
    return EventStatsOut(consumer_group=group, **stats)


@router.post(
    "/events/{event_id}/replay",
    response_model=ReplayResult,
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def replay_event(
    event_id: str,
    store: EventStoreDep,
    settings: SettingsDep,
    principal: PrincipalDep,
    audit: AuditServiceDep,
    consumer_group: str | None = Query(default=None, max_length=200),
) -> ReplayResult:
    tenant_id = require_tenant(principal)
    event = await store.get_event(tenant_id, event_id)
    if event is None:
        raise NotFoundError("event not found", details={"event_id": event_id})
    occurred_at = event.get("occurred_at")
    if occurred_at is not None:
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        max_age = timedelta(days=settings.ai_event_replay_max_age_days)
        if datetime.now(UTC) - occurred_at > max_age:
            await audit.record(
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                action="ai.events.replay",
                resource_type="event",
                resource_id=event_id,
                outcome="denied",
                request_id=request_id_var.get(),
                detail={"reason": "outside_replay_window"},
            )
            raise ValidationError(
                "event is older than the replay window",
                details={"max_age_days": settings.ai_event_replay_max_age_days},
            )
    group = consumer_group or settings.ai_event_consumer_group
    replayed = await store.replay(tenant_id, event_id, group)
    await audit.record(
        tenant_id=tenant_id,
        actor_id=principal.actor_id,
        action="ai.events.replay",
        resource_type="event",
        resource_id=event_id,
        request_id=request_id_var.get(),
        detail={"consumer_group": group, "replayed": replayed},
    )
    return ReplayResult(event_id=event_id, consumer_group=group, replayed=replayed)
