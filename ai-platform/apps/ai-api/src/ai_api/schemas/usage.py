from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class UsageKindOut(BaseModel):
    kind: str
    quantity: int
    total_cost: float


class UsageSummaryOut(BaseModel):
    quantity: int
    total_cost: float
    currency: str
    by_kind: list[UsageKindOut]


class UsageRecordOut(BaseModel):
    id: int
    kind: str
    provider_code: str | None = None
    model_code: str | None = None
    quantity: int
    unit: str
    total_cost: float | None = None
    currency: str
    created_at: datetime
