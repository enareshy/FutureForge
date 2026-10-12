from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ChatMessageIn(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(min_length=1, max_length=64000)


class ChatRequestIn(BaseModel):
    messages: list[ChatMessageIn] = Field(min_length=1, max_length=100)
    model: str | None = Field(default=None, max_length=200)
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_output_tokens: int | None = Field(default=None, ge=1, le=32768)
    response_format: Literal["text", "json"] = "text"
    json_schema: dict[str, Any] | None = None


class TokenUsageOut(BaseModel):
    input_tokens: int
    output_tokens: int
    total_tokens: int


class ChatResponseOut(BaseModel):
    content: str
    model: str
    provider: str
    is_mock: bool
    finish_reason: str
    usage: TokenUsageOut
    estimated_cost_usd: float | None = None
    request_id: str | None = None


class SummarizeRequestIn(BaseModel):
    text: str = Field(min_length=1, max_length=200000)
    model: str | None = Field(default=None, max_length=200)


class SummarizeResponseOut(BaseModel):
    summary: str
    model: str
    provider: str
    is_mock: bool
    finish_reason: str
    usage: TokenUsageOut
    estimated_cost_usd: float | None = None
    request_id: str | None = None
