from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel


class EventOut(BaseModel):
    event_id: str
    type: str
    version: str
    tenant_id: int
    actor_id: int | None = None
    subject_type: str | None = None
    subject_id: str | None = None
    correlation_id: str | None = None
    request_id: str | None = None
    payload: dict[str, Any]
    occurred_at: datetime
    published_at: datetime | None = None


class DeadLetterOut(BaseModel):
    event_id: str
    consumer_group: str
    attempts: int
    last_error: str | None = None
    created_at: datetime


class EventStatsOut(BaseModel):
    consumer_group: str
    pending: int
    delivered: int
    failed: int
    dead: int


class ReplayResult(BaseModel):
    event_id: str
    consumer_group: str
    replayed: bool
