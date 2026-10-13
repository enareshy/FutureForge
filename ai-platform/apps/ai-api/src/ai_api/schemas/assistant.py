from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ConversationOut(BaseModel):
    id: int
    title: str | None = None
    status: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    message_count: int = 0
    created_at: datetime
    updated_at: datetime


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


class MessageOut(BaseModel):
    id: int
    conversation_id: int
    role: Literal["user", "assistant", "system"]
    content: str
    answer_status: str | None = None
    confidence: float | None = None
    is_mock: bool | None = None
    model_code: str | None = None
    provider_code: str | None = None
    token_usage: dict[str, Any] = Field(default_factory=dict)
    latency_ms: int | None = None
    created_at: datetime
    sources: list[MessageSourceOut] = Field(default_factory=list)


class ConversationDetailOut(BaseModel):
    conversation: ConversationOut
    messages: list[MessageOut] = Field(default_factory=list)


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    model: str | None = Field(default=None, max_length=128)


class AssistantFeedbackCreate(BaseModel):
    message_id: int = Field(ge=1)
    rating: int | None = Field(default=None, ge=-1, le=1)
    comment: str | None = Field(default=None, max_length=2000)
