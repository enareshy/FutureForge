from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

RISK_CLASSES = (
    "read_only",
    "low_risk_preparation",
    "controlled_mutation",
    "consequential",
    "prohibited",
)


class ToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: str = Field(min_length=1, max_length=100)
    read_only: bool = True
    risk_class: str = "read_only"
    requires_approval: bool = False
    timeout_seconds: float = Field(default=30.0, gt=0, le=600)
    max_concurrency: int = Field(default=1, ge=1, le=50)
    idempotency: str = Field(default="supported", pattern=r"^(supported|required|none|reconcile)$")
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    implementation: str | None = Field(default=None, max_length=200)


class AgentToolOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    category: str | None = None
    owner: str | None = None
    enabled: bool = True
    lifecycle_status: str = "draft"
    current_version_id: int | None = None
    lock_version: int = 1
    created_at: datetime
    updated_at: datetime


class AgentToolVersionOut(BaseModel):
    id: int
    tool_id: int
    version: int
    definition: dict[str, Any] = Field(default_factory=dict)
    status: str
    validation: dict[str, Any] = Field(default_factory=dict)
    config_hash: str | None = None
    published_at: datetime | None = None
    published_by: str | None = None
    created_at: datetime


class AgentToolDetailOut(AgentToolOut):
    current_version: AgentToolVersionOut | None = None


class AgentToolCreateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=100, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    category: str | None = Field(default=None, max_length=100)
    owner: str | None = Field(default=None, max_length=200)
    definition: ToolDefinition


class AgentToolUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    category: str | None = Field(default=None, max_length=100)
    owner: str | None = Field(default=None, max_length=200)
    enabled: bool | None = None
    lock_version: int = Field(ge=1)


class AgentToolVersionCreateRequest(BaseModel):
    definition: ToolDefinition
    version: int | None = Field(default=None, ge=1)


class AgentToolValidationOut(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    checks: dict[str, Any] = Field(default_factory=dict)
    config_hash: str | None = None
    tool_version_id: int | None = None
