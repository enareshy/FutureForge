from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query

from ai_api.api.deps import (
    EventStoreDep,
    PrincipalDep,
    SettingsDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.schemas.events import (
    DeadLetterOut,
    EventOut,
    EventStatsOut,
    ReplayResult,
)
from ai_api.security.permissions import CAP_AUDIT_READ

router = APIRouter(tags=["events"], dependencies=[Depends(enforce_rate_limit)])


@router.get(
    "/events",
    response_model=list[EventOut],
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def list_events(
    store: EventStoreDep,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[EventOut]:
    rows = await store.list_events(limit=limit)
    return [EventOut(**row) for row in rows]


@router.get(
    "/events/dead-letters",
    response_model=list[DeadLetterOut],
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def list_dead_letters(
    store: EventStoreDep,
    limit: int = Query(default=50, ge=1, le=500),
) -> list[DeadLetterOut]:
    rows = await store.list_dead_letters(limit=limit)
    return [DeadLetterOut(**row) for row in rows]


@router.get(
    "/events/stats",
    response_model=EventStatsOut,
    dependencies=[Depends(require_capability(CAP_AUDIT_READ))],
)
async def event_stats(
    store: EventStoreDep,
    settings: SettingsDep,
    consumer_group: str | None = Query(default=None, max_length=200),
) -> EventStatsOut:
    group = consumer_group or settings.ai_event_consumer_group
    stats = await store.delivery_stats(group)
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
    _: PrincipalDep,
    consumer_group: str | None = Query(default=None, max_length=200),
) -> ReplayResult:
    event = await store.get_event(event_id)
    if event is None:
        raise NotFoundError("event not found", details={"event_id": event_id})
    occurred_at = event.get("occurred_at")
    if occurred_at is not None:
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=UTC)
        max_age = timedelta(days=settings.ai_event_replay_max_age_days)
        if datetime.now(UTC) - occurred_at > max_age:
            raise ValidationError(
                "event is older than the replay window",
                details={"max_age_days": settings.ai_event_replay_max_age_days},
            )
    group = consumer_group or settings.ai_event_consumer_group
    replayed = await store.replay(event_id, group)
    return ReplayResult(event_id=event_id, consumer_group=group, replayed=replayed)
