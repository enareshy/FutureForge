from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class AgentExecutionCreateRequest(BaseModel):
    agent_id: int = Field(ge=1)
    input: dict[str, Any] = Field(default_factory=dict)
    input_text: str | None = Field(default=None, max_length=20000)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=200)
    budgets: dict[str, int] = Field(default_factory=dict)


class AgentExecutionStepOut(BaseModel):
    id: int
    step_key: str
    sequence: int
    tool_code: str | None = None
    tool_version_id: int | None = None
    status: str
    attempts: int = 0
    max_attempts: int = 3
    input_summary: dict[str, Any] = Field(default_factory=dict)
    output_summary: dict[str, Any] = Field(default_factory=dict)
    error_class: str | None = None
    error_message: str | None = None


class AgentToolInvocationOut(BaseModel):
    id: int
    step_id: int | None = None
    tool_code: str
    tool_version_id: int | None = None
    status: str
    attempt: int = 1
    outcome_certainty: str = "certain"
    arguments_summary: dict[str, Any] = Field(default_factory=dict)
    result_summary: dict[str, Any] = Field(default_factory=dict)
    error_class: str | None = None
    error_message: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


class AgentCheckpointOut(BaseModel):
    id: int
    sequence: int
    state: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class AgentArtifactOut(BaseModel):
    id: int
    execution_id: int | None = None
    artifact_type: str
    title: str
    content: str
    created_at: datetime


class AgentExecutionOut(BaseModel):
    id: int
    agent_id: int
    agent_version_id: int | None = None
    status: str
    current_step: str | None = None
    step_count: int = 0
    tool_call_count: int = 0
    model_call_count: int = 0
    plan: dict[str, Any] = Field(default_factory=dict)
    budgets: dict[str, Any] = Field(default_factory=dict)
    input: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    cancel_requested_at: datetime | None = None
    lease_expires_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    steps: list[AgentExecutionStepOut] = Field(default_factory=list)
    invocations: list[AgentToolInvocationOut] = Field(default_factory=list)
    artifacts: list[AgentArtifactOut] = Field(default_factory=list)


class AgentExecutionPage(BaseModel):
    items: list[AgentExecutionOut]
    total: int
    limit: int
    offset: int


class AgentApprovalOut(BaseModel):
    id: int
    execution_id: int
    step_key: str
    tool_code: str
    tool_version_id: int | None = None
    operation_hash: str
    target: str | None = None
    input_summary: dict[str, Any] = Field(default_factory=dict)
    expected_effect: str | None = None
    evidence: list[Any] = Field(default_factory=list)
    risk_class: str
    requested_by_name: str | None = None
    status: str
    expires_at: datetime
    reviewer_name: str | None = None
    decision_reason: str | None = None
    decided_at: datetime | None = None
    created_at: datetime


class AgentApprovalPage(BaseModel):
    items: list[AgentApprovalOut]
    total: int
    limit: int
    offset: int


class AgentApprovalDecision(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class AgentDelegationOut(BaseModel):
    id: int
    parent_execution_id: int
    child_execution_id: int | None = None
    parent_agent_id: int | None = None
    child_agent_id: int
    step_key: str
    mode: str = "sequential"
    status: str = "pending"
    depth: int = 1
    input_summary: dict[str, Any] = Field(default_factory=dict)
    result_summary: dict[str, Any] = Field(default_factory=dict)
    error_class: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AgentExecutionStatsOut(BaseModel):
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    cancelled: int = 0
    waiting_approval: int = 0
    active: int = 0
    avg_latency_ms: float | None = None
    total_tokens: int = 0


class AgentMonitoringOverviewOut(BaseModel):
    agents_total: int = 0
    executions: AgentExecutionStatsOut
    recent: list[dict[str, Any]] = Field(default_factory=list)
    generated_at: datetime


class AgentHealthOut(BaseModel):
    agent_id: int
    health: str
    failure_rate: float = 0.0
    stats: AgentExecutionStatsOut
