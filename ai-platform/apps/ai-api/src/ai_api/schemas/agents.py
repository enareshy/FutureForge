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


class AgentVersionOut(BaseModel):
    id: int
    agent_id: int
    version: int
    definition: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime


class AgentExecuteRequest(BaseModel):
    input: str = Field(min_length=1, max_length=64000)
    model: str | None = None
    limit: int | None = Field(default=None, ge=1, le=20)
    approvals: list[str] = Field(default_factory=list)


class AgentTraceEvent(BaseModel):
    seq: int
    step: str
    detail: dict[str, Any] = Field(default_factory=dict)


class AgentExecuteResponse(BaseModel):
    agent_id: int
    code: str | None = None
    version: int = 0
    status: str
    answer: str
    citations: list[dict[str, Any]] = Field(default_factory=list)
    insufficient_evidence: bool = False
    confidence: float = 0.0
    is_mock: bool = True
    provider: str | None = None
    usage: dict[str, Any] = Field(default_factory=dict)
    trace: list[AgentTraceEvent] = Field(default_factory=list)
    execution_id: int | None = None
    request_id: str | None = None


class AgentExecutionOut(BaseModel):
    id: int
    request_id: str | None = None
    actor_id: int | None = None
    agent_id: int | None = None
    operation: str
    status: str
    latency_ms: int | None = None
    token_usage: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class AgentExecutionPage(BaseModel):
    items: list[AgentExecutionOut]
    total: int
    limit: int
    offset: int
