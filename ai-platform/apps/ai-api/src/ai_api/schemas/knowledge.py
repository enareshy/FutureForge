from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


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
    version: int = 1
    created_at: datetime
    updated_at: datetime


class KnowledgeSourceAclUpdate(BaseModel):
    acl: dict[str, Any] = Field(default_factory=dict)
    expected_version: int = Field(ge=1)


class KnowledgeSourceClassificationUpdate(BaseModel):
    classification: Literal["public", "internal", "confidential", "restricted"]
    expected_version: int = Field(ge=1)


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
    max_attempts: int = 5
    stage: str | None = None
    error_class: str | None = None
    lease_expires_at: datetime | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class KnowledgeDocumentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    external_id: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=512)
    mime_type: str | None = Field(default=None, max_length=128)
    text: str | None = Field(default=None, max_length=5_000_000)
    content_base64: str | None = Field(default=None, max_length=8_000_000)
    # Content checksum/size of the original upload. Carried through so dedup
    # compares like-for-like (original bytes) rather than re-deriving a checksum
    # from extracted text, which can differ from the raw bytes.
    checksum: str | None = Field(default=None, max_length=128)
    size_bytes: int | None = Field(default=None, ge=0)
    classification: str | None = Field(default=None, max_length=64)
    acl: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class StoredKnowledgeDocumentIn(KnowledgeDocumentIn):
    """Internal input for an object already written by the upload endpoint.

    This model is never accepted by a public route. The key is generated
    server-side and revalidated against the tenant before it reaches storage.
    """

    object_key: str | None = Field(default=None, max_length=1024)


class KnowledgeIngestExecution(BaseModel):
    """Internal worker payload carrying server-issued object keys."""

    source_id: int = Field(ge=1)
    documents: list[StoredKnowledgeDocumentIn] = Field(min_length=1)


class KnowledgeIngestBody(BaseModel):
    documents: list[KnowledgeDocumentIn] = Field(min_length=1)
    idempotency_key: str | None = Field(default=None, max_length=200)
    force: bool = False


class KnowledgeIngestResponse(BaseModel):
    job: JobOut
    result: dict[str, Any] | None = None


class DocumentOut(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    source_id: int
    external_id: str
    title: str | None = None
    mime_type: str | None = None
    classification: str
    status: str
    size_bytes: int | None = None
    checksum: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    version: int = 1
    indexed_at: datetime | None = None
    search_indexed_at: datetime | None = None
    error_class: str | None = None
    created_at: datetime
    updated_at: datetime | None = None


class DocumentMetadataUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=512)
    metadata: dict[str, Any] | None = None
    expected_version: int | None = Field(default=None, ge=1)


class DocumentVersionOut(BaseModel):
    document_id: int
    source_id: int
    external_id: str
    version: int
    title: str | None = None
    mime_type: str | None = None
    checksum: str | None = None
    size_bytes: int | None = None
    classification: str
    status: str
    reason: str
    superseded_at: datetime


class UploadedDocumentOut(BaseModel):
    external_id: str
    title: str | None = None
    mime_type: str | None = None
    size_bytes: int
    checksum: str
    deduplicated: bool = False


class KnowledgeUploadResponse(BaseModel):
    document: UploadedDocumentOut
    job: JobOut | None = None
    result: dict[str, Any] | None = None


class KnowledgeReindexResponse(BaseModel):
    source_id: int
    result: dict[str, Any]
