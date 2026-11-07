from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

MEMORY_SCOPES = ("execution", "conversation", "agent")


class AgentMemoryWriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    agent_id: int | None = Field(default=None, ge=1)
    scope: str = Field(default="agent", pattern=r"^(execution|conversation|agent)$")
    execution_id: int | None = Field(default=None, ge=1)
    conversation_id: int | None = Field(default=None, ge=1)
    memory_key: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    classification: str = Field(default="internal", max_length=32)
    ttl_seconds: int | None = Field(default=None, ge=1, le=31_536_000)


class AgentMemoryOut(BaseModel):
    id: int
    agent_id: int | None = None
    scope: str
    execution_id: int | None = None
    conversation_id: int | None = None
    owner_actor_id: int | None = None
    owner_username: str | None = None
    memory_key: str
    content: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    classification: str = "internal"
    expires_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AgentMemoryPage(BaseModel):
    items: list[AgentMemoryOut]
    total: int
    limit: int
    offset: int
