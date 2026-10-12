from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AgentOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    kind: str
    enabled: bool
    created_at: datetime
    updated_at: datetime


class AgentExecuteRequest(BaseModel):
    input: str = Field(min_length=1, max_length=64000)


class AgentExecuteResponse(BaseModel):
    agent_id: int
    answer: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
    insufficient_evidence: bool = False
