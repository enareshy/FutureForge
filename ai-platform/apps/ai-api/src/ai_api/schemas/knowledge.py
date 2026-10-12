from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class KnowledgeSourceCreate(BaseModel):
    code: str = Field(min_length=1, max_length=128, pattern=r"^[a-z0-9][a-z0-9._-]*$")
    name: str = Field(min_length=1, max_length=255)
    kind: Literal["file", "url", "object", "manual"] = "file"
    uri: str | None = Field(default=None, max_length=2048)
    classification: str = Field(default="internal", max_length=64)
    acl: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)


class KnowledgeSourceOut(BaseModel):
    id: int
    code: str
    name: str
    kind: str
    uri: str | None = None
    classification: str
    acl: dict[str, Any] = Field(default_factory=dict)
    status: str
    created_at: datetime
    updated_at: datetime


class KnowledgeIndexRequest(BaseModel):
    source_id: int = Field(ge=1)
    force: bool = False
    idempotency_key: str | None = Field(default=None, max_length=200)


class JobOut(BaseModel):
    id: int
    type: str
    status: str
    source_id: int | None = None
    progress: float
    attempts: int
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class KnowledgeDocumentIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=512)
    mime_type: str | None = Field(default=None, max_length=128)
    text: str | None = Field(default=None, max_length=5_000_000)
    content_base64: str | None = Field(default=None, max_length=8_000_000)
    classification: str | None = Field(default=None, max_length=64)
    acl: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class KnowledgeIngestRequest(BaseModel):
    source_id: int = Field(ge=1)
    documents: list[KnowledgeDocumentIn] = Field(min_length=1)
    idempotency_key: str | None = Field(default=None, max_length=200)
    force: bool = False


class KnowledgeIngestBody(BaseModel):
    documents: list[KnowledgeDocumentIn] = Field(min_length=1)
    idempotency_key: str | None = Field(default=None, max_length=200)
    force: bool = False


class KnowledgeIngestResponse(BaseModel):
    job: JobOut
    result: dict[str, Any] | None = None


class DocumentOut(BaseModel):
    id: int
    source_id: int
    external_id: str
    title: str | None = None
    mime_type: str | None = None
    classification: str
    status: str
    size_bytes: int | None = None
    indexed_at: datetime | None = None
    created_at: datetime
