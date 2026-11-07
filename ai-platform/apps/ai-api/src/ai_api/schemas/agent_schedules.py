from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AgentScheduleCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    schedule_kind: str = Field(default="once", pattern=r"^(once|recurring)$")
    cron: str | None = Field(default=None, max_length=120)
    run_at: datetime | None = None
    timezone: str = Field(default="UTC", max_length=64)
    input: dict[str, Any] = Field(default_factory=dict)
    input_text: str | None = Field(default=None, max_length=20000)


class AgentScheduleUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    enabled: bool | None = None
    cron: str | None = Field(default=None, max_length=120)
    run_at: datetime | None = None
    timezone: str | None = Field(default=None, max_length=64)
    input: dict[str, Any] | None = None
    input_text: str | None = Field(default=None, max_length=20000)


class AgentScheduleOut(BaseModel):
    id: int
    agent_id: int
    name: str
    enabled: bool = True
    schedule_kind: str = "once"
    cron: str | None = None
    run_at: datetime | None = None
    timezone: str = "UTC"
    input: dict[str, Any] = Field(default_factory=dict)
    input_text: str | None = None
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None
    last_run_key: str | None = None
    last_execution_id: int | None = None
    last_status: str | None = None
    failure_count: int = 0
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AgentSchedulePage(BaseModel):
    items: list[AgentScheduleOut]
    total: int
    limit: int
    offset: int
