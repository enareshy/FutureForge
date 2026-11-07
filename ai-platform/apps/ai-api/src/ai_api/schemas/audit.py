from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AuditEventOut(BaseModel):
    id: int
    actor_id: int | None = None
    action: str
    resource_type: str | None = None
    resource_id: str | None = None
    outcome: str
    request_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
