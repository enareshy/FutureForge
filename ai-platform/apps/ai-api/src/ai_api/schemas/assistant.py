from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ai_api.schemas.agent_executions import AgentExecutionCreateRequest
from ai_api.schemas.search import SearchFilter, SearchMode

TaskType = Literal["ask", "summarize", "explain", "compare", "extract"]
OutputFormat = Literal["markdown", "executive", "technical", "bullets", "json"]
GenerationStatus = Literal["pending", "streaming", "completed", "cancelled", "failed"]
FeedbackCategory = Literal[
    "helpful", "not_helpful", "incorrect", "missing_information", "poor_citations", "other"
]
ExtractionValueType = Literal["string", "number", "date", "boolean", "list"]


class ConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=255)
    status: Literal["active", "archived"] | None = None

    @model_validator(mode="after")
    def _require_change(self) -> ConversationUpdate:
        if self.title is None and self.status is None:
            raise ValueError("provide title or status")
        return self


class ConversationOut(BaseModel):
    id: int
    title: str | None = None
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    message_count: int = 0
    created_at: datetime
    updated_at: datetime


class ToolTraceOut(BaseModel):
    tool_code: str
    status: str
    read_only: bool = True
    error_class: str | None = None
    duration_ms: int | None = None


class CopilotToolSpecOut(BaseModel):
    name: str
    description: str
    capability: str
    read_only: bool = True
    requires_approval: bool = False
    input_schema: dict[str, Any] = Field(default_factory=dict)


class CopilotActionProposalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_type: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=1000)
    expected_effect: str | None = Field(default=None, max_length=2000)
    arguments: dict[str, Any] = Field(default_factory=dict)


class CopilotActionCreate(CopilotActionProposalIn):
    conversation_id: int | None = Field(default=None, ge=1)
    message_id: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _bound_arguments(self) -> CopilotActionCreate:
        if self.message_id is not None and self.conversation_id is None:
            raise ValueError("message_id requires conversation_id")
        encoded = json.dumps(self.arguments)
        if len(encoded) > 8000:
            raise ValueError("arguments are too large")
        return self


class CopilotActionDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=2000)


class CopilotActionOut(BaseModel):
    id: int
    conversation_id: int | None = None
    message_id: int | None = None
    action_type: str
    target: str | None = None
    summary: str
    status: str
    risk_class: str
    expected_effect: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)
    requested_by_name: str | None = None
    approved_by_name: str | None = None
    executed_by_name: str | None = None
    decision_reason: str | None = None
    error_class: str | None = None
    duplicate: bool = False
    created_at: datetime
    updated_at: datetime | None = None
    expires_at: datetime | None = None


class CopilotMessageActionOut(BaseModel):
    id: int
    action_type: str
    target: str | None = None
    summary: str
    status: str
    risk_class: str
    expected_effect: str | None = None
    requested_by_name: str | None = None
    approved_by_name: str | None = None
    executed_by_name: str | None = None
    decision_reason: str | None = None
    expires_at: datetime | None = None
    created_at: datetime | None = None


class MessageSourceOut(BaseModel):
    rank: int
    source_id: int | None = None
    document_id: int | None = None
    chunk_id: int | None = None
    source_code: str | None = None
    chunk_index: int | None = None
    page: int | None = None
    section: str | None = None
    score: float | None = None
    snippet: str | None = None


class ContextRefIn(BaseModel):
    """Client-supplied reference. Only `type` and `id` are trusted.

    Names, revisions, permissions and content are always resolved server-side
    from the authorized source record.
    """

    type: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    id: str = Field(min_length=1, max_length=200)


class ContextRefOut(BaseModel):
    type: str
    object_id: str
    display_name: str | None = None
    source_system: str | None = None
    revision: str | None = None
    lifecycle_state: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    role: Literal["user", "assistant", "system"]
    content: str
    answer_status: str | None = None
    warnings: list[str] = Field(default_factory=list)
    citations_required: bool = False
    citation_status: str | None = None
    confidence: float | None = None
    is_mock: bool | None = None
    model_code: str | None = None
    provider_code: str | None = None
    token_usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None
    task_type: str | None = None
    generation_status: str = "completed"
    prompt_version: str | None = None
    parent_message_id: int | None = None
    created_at: datetime
    sources: list[MessageSourceOut] = Field(default_factory=list)
    context: list[ContextRefOut] = Field(default_factory=list)
    tools: list[ToolTraceOut] = Field(default_factory=list)
    actions: list[CopilotMessageActionOut] = Field(default_factory=list)


class ConversationDetailOut(BaseModel):
    conversation: ConversationOut
    messages: list[MessageOut] = Field(default_factory=list)
    total_messages: int = 0
    summary: str | None = None


class MessagePageOut(BaseModel):
    items: list[MessageOut] = Field(default_factory=list)
    total: int = 0
    limit: int
    offset: int


class ExtractionField(BaseModel):
    name: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z][A-Za-z0-9_ ]*$")
    description: str | None = Field(default=None, max_length=300)
    type: ExtractionValueType = "string"


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=8000)
    model: str | None = Field(default=None, max_length=128)
    mode: SearchMode = "hybrid"
    filters: list[SearchFilter] = Field(default_factory=list, max_length=20)
    task: TaskType = "ask"
    context: list[ContextRefIn] = Field(default_factory=list, max_length=25)
    output_format: OutputFormat = "markdown"
    parent_message_id: int | None = Field(default=None, ge=1)
    fields: list[ExtractionField] = Field(default_factory=list, max_length=100)
    action: CopilotActionProposalIn | None = None


class CopilotTaskRequest(BaseModel):
    instruction: str | None = Field(default=None, max_length=8000)
    model: str | None = Field(default=None, max_length=128)
    mode: SearchMode = "hybrid"
    filters: list[SearchFilter] = Field(default_factory=list, max_length=20)
    context: list[ContextRefIn] = Field(default_factory=list, max_length=25)
    output_format: OutputFormat = "markdown"
    fields: list[ExtractionField] = Field(default_factory=list, max_length=100)


class CopilotTaskResponse(BaseModel):
    task_type: TaskType
    content: str
    structured: dict[str, Any] | None = None
    citations: list[MessageSourceOut] = Field(default_factory=list)
    context: list[ContextRefOut] = Field(default_factory=list)
    answer_status: str
    confidence: float | None = None
    warnings: list[str] = Field(default_factory=list)
    citations_required: bool = False
    citation_status: str | None = None
    is_mock: bool = False
    prompt_version: str
    request_id: str | None = None
    model_code: str | None = None
    provider_code: str | None = None
    token_usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None


class AssistantFeedbackCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: int = Field(ge=1)
    rating: int | None = Field(default=None, ge=-1, le=1)
    comment: str | None = Field(default=None, max_length=2000)
    category: FeedbackCategory | None = None

    @model_validator(mode="after")
    def _require_signal(self) -> AssistantFeedbackCreate:
        if self.rating is None and self.category is None and not self.comment:
            raise ValueError("provide rating, category or comment")
        return self


class CapabilityOut(BaseModel):
    task: TaskType
    available: bool
    streaming: bool = False
    requires_context: bool = False
    reasons: list[str] = Field(default_factory=list)


class CopilotCapabilitiesOut(BaseModel):
    tasks: list[CapabilityOut] = Field(default_factory=list)
    context_types: list[str] = Field(default_factory=list)
    streaming: bool = False
    prompt_version: str
    is_mock: bool = False
    tools: list[CopilotToolSpecOut] = Field(default_factory=list)
    actions_enabled: bool = False


class CopilotAgentRunRequest(AgentExecutionCreateRequest):
    """Run a published agent from Copilot via the shared execution engine."""
