from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class FeedbackCreate(BaseModel):
    execution_id: int | None = None
    rating: int | None = Field(default=None, ge=-1, le=5)
    comment: str | None = Field(default=None, max_length=2000)


class FeedbackOut(BaseModel):
    id: int
    execution_id: int | None = None
    actor_id: int | None = None
    rating: int | None = None
    comment: str | None = None
    created_at: datetime
