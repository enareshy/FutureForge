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
    answer_status: str = "answered"
    warnings: list[str] = Field(default_factory=list)
    citations_required: bool = False
    citation_status: str | None = None
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


class AgentDetailOut(AgentOut):
    category: str | None = None
    owner: str | None = None
    team: str | None = None
    lifecycle_status: str = "published"
    current_version_id: int | None = None
    lock_version: int = 1
    duplicated_from_agent_id: int | None = None
    suspended_at: datetime | None = None
    archived_at: datetime | None = None
    deleted_at: datetime | None = None
    working_config: dict[str, Any] = Field(default_factory=dict)
    created_by: str | None = None
    updated_by: str | None = None
    current_version: AgentVersionOut | None = None


class AgentCreateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    kind: str = Field(default="workflow", max_length=64)
    category: str | None = Field(default=None, max_length=100)
    owner: str | None = Field(default=None, max_length=200)
    team: str | None = Field(default=None, max_length=200)
    definition: dict[str, Any] = Field(default_factory=dict)


class AgentUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    category: str | None = Field(default=None, max_length=100)
    owner: str | None = Field(default=None, max_length=200)
    team: str | None = Field(default=None, max_length=200)
    kind: str | None = Field(default=None, max_length=64)
    definition: dict[str, Any] | None = None
    version_id: int | None = Field(default=None, ge=1)
    lock_version: int = Field(ge=1)
    version_lock_version: int | None = Field(default=None, ge=1)


class AgentValidateRequest(BaseModel):
    version_id: int | None = Field(default=None, ge=1)


class AgentPublishRequest(BaseModel):
    version_id: int | None = Field(default=None, ge=1)
    note: str | None = Field(default=None, max_length=2000)


class AgentRollbackRequest(BaseModel):
    version_id: int = Field(ge=1)


class AgentDisableRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class AgentValidationOut(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    checks: dict[str, Any] = Field(default_factory=dict)
    config_hash: str | None = None
    agent_version_id: int | None = None


class AgentVersionToolOut(BaseModel):
    code: str | None = None
    tool_id: int
    tool_version_id: int
    version: int | None = None
    risk_class: str | None = None


class AgentActivateRequest(BaseModel):
    version_id: int | None = Field(default=None, ge=1)
    note: str | None = Field(default=None, max_length=2000)


class AgentSuspendRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class AgentDuplicateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    copy_versions: bool = False


class AgentDeleteRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)
    confirm: bool = False


class AgentTemplateOut(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    category: str | None = None
    use_case: str | None = None
    definition: dict[str, Any] = Field(default_factory=dict)
    system_tools: list[Any] = Field(default_factory=list)
    enabled: bool = True
    created_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AgentTemplateInstantiateRequest(BaseModel):
    code: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    owner: str | None = Field(default=None, max_length=200)
    overrides: dict[str, Any] = Field(default_factory=dict)
    activate: bool = False


class AgentTemplateSeedRequest(BaseModel):
    code: str | None = Field(default=None, max_length=100)
    force: bool = False


class AgentWorkingConfigOut(BaseModel):
    agent_id: int
    working_config: dict[str, Any] = Field(default_factory=dict)
    lock_version: int = 1
