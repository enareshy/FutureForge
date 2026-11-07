"""Authorized Copilot context resolution.

Context references are *pointers* supplied by the client. Only the type and the
stable object identifier are trusted. An adapter re-reads the source under the
caller's identity, so display names, revisions, metadata and permissions are
always server-authoritative.

Authorization failures and missing objects deliberately share one error shape so
the API cannot be used as an existence oracle for other tenants or for records
the caller cannot read.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Protocol

from ai_api.application.ports import AiRepository
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal

CONTEXT_TYPE_KNOWLEDGE_DOCUMENT = "knowledge_document"


@dataclass(slots=True)
class ResolvedContext:
    context_type: str
    object_id: str
    display_name: str | None
    source_system: str | None
    revision: str | None
    lifecycle_state: str | None
    metadata: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    chunks: list[dict[str, Any]] = field(default_factory=list)

    def ref_out(self) -> dict[str, Any]:
        return {
            "type": self.context_type,
            "object_id": self.object_id,
            "display_name": self.display_name,
            "source_system": self.source_system,
            "revision": self.revision,
            "lifecycle_state": self.lifecycle_state,
            "metadata": self.metadata,
            "provenance": self.provenance,
        }

    def ref_row(self) -> dict[str, Any]:
        return {
            "context_type": self.context_type,
            "object_id": self.object_id,
            "display_name": self.display_name,
            "source_system": self.source_system,
            "revision": self.revision,
            "lifecycle_state": self.lifecycle_state,
            "metadata": self.metadata,
            "provenance": self.provenance,
        }


class ContextAdapter(Protocol):
    context_type: str

    async def resolve(
        self,
        principal: Principal,
        object_id: str,
        *,
        policy: Any,
        chunk_limit: int,
    ) -> ResolvedContext: ...


class KnowledgeDocumentAdapter:
    """Resolve documents from the AI knowledge corpus.

    The document record and every chunk are checked against the caller's ACL and
    the tenant classification ceiling before content is returned. Access is never
    inferred from the fact that the client knows an id.
    """

    context_type = CONTEXT_TYPE_KNOWLEDGE_DOCUMENT

    def __init__(self, repository: AiRepository, access: AccessControl) -> None:
        self.repository = repository
        self.access = access

    async def resolve(
        self,
        principal: Principal,
        object_id: str,
        *,
        policy: Any,
        chunk_limit: int,
    ) -> ResolvedContext:
        tenant_id = require_tenant(principal)
        try:
            document_id = int(object_id)
        except (TypeError, ValueError):
            raise self._not_found(object_id) from None
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise self._not_found(object_id)
        if not self._allowed(principal, document, policy):
            raise self._not_found(object_id)

        chunks, _total = await self.repository.list_document_chunks(
            tenant_id, document_id, limit=chunk_limit, offset=0
        )
        authorized: list[dict[str, Any]] = []
        for chunk in chunks:
            if not self._allowed(principal, chunk, policy):
                continue
            authorized.append(
                {
                    "chunk_id": chunk["chunk_id"],
                    "document_id": document_id,
                    "source_id": document.get("source_id"),
                    "source_code": document.get("source_code") or "knowledge",
                    "chunk_index": chunk.get("chunk_index", 0),
                    "content": chunk.get("content") or "",
                    "page": chunk.get("page"),
                    "section": chunk.get("section"),
                    "score": 1.0,
                    "classification": chunk.get("classification")
                    or document.get("classification"),
                    "acl": chunk.get("acl") or document.get("acl") or {},
                    "title": document.get("title"),
                    "external_id": document.get("external_id"),
                    "document_status": document.get("status"),
                }
            )
        if not authorized:
            # The object exists but the caller may read none of its content.
            raise self._not_found(object_id)

        updated = document.get("updated_at") or document.get("indexed_at")
        revision = updated.isoformat() if hasattr(updated, "isoformat") else (
            str(updated) if updated else None
        )
        return ResolvedContext(
            context_type=self.context_type,
            object_id=str(document_id),
            display_name=document.get("title") or document.get("external_id"),
            source_system=document.get("source_code") or "ai.knowledge",
            revision=revision,
            lifecycle_state=document.get("status"),
            metadata={
                "document_id": document_id,
                "source_id": document.get("source_id"),
                "mime_type": document.get("mime_type"),
                "classification": document.get("classification"),
                "size_bytes": document.get("size_bytes"),
            },
            provenance={
                "document_id": document_id,
                "external_id": document.get("external_id"),
                "source_id": document.get("source_id"),
            },
            chunks=authorized,
        )

    def _allowed(self, principal: Principal, record: dict[str, Any], policy: Any) -> bool:
        if not within_ceiling(record.get("classification"), policy.data_classification_ceiling):
            return False
        return self.access.allows(principal, record.get("acl"))

    @staticmethod
    def _not_found(object_id: str) -> NotFoundError:
        return NotFoundError(
            "context not found",
            details={"type": CONTEXT_TYPE_KNOWLEDGE_DOCUMENT, "id": object_id},
        )


@dataclass(slots=True)
class ContextService:
    adapters: dict[str, ContextAdapter]
    settings: Any

    async def resolve(
        self, principal: Principal, refs: list[Any], *, policy: Any
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
        """Resolve refs into (refs-out, authorized-chunks, warnings).

        Bounds are enforced here, not by the client: item count, chunks per
        context, and total evidence characters.
        """
        max_items = self.settings.ai_copilot_context_max_items
        if len(refs) > max_items:
            raise ValidationError(
                "too many context references",
                details={"max_context_items": max_items},
            )
        warnings: list[str] = []
        resolved: list[ResolvedContext] = []
        seen: set[tuple[str, str]] = set()
        for ref in refs:
            context_type = getattr(ref, "type", None) or (
                ref.get("type") if isinstance(ref, dict) else None
            )
            object_id = getattr(ref, "id", None) or (
                ref.get("id") if isinstance(ref, dict) else None
            )
            if not context_type or not object_id:
                raise ValidationError("context reference requires type and id")
            key = (str(context_type), str(object_id))
            if key in seen:
                continue
            seen.add(key)
            adapter = self.adapters.get(str(context_type))
            if adapter is None:
                raise ValidationError(
                    "unsupported context type",
                    details={"context_type": context_type},
                )
            context = await adapter.resolve(
                principal,
                str(object_id),
                policy=policy,
                chunk_limit=self.settings.ai_copilot_context_chunk_limit,
            )
            resolved.append(context)

        max_chars = self.settings.ai_copilot_context_max_chars
        used = 0
        refs_out: list[dict[str, Any]] = []
        chunks: list[dict[str, Any]] = []
        for context in resolved:
            refs_out.append(context.ref_out())
            if not context.chunks:
                warnings.append(
                    f"context {context.context_type}:{context.object_id} has no content"
                )
                continue
            included = 0
            for chunk in context.chunks:
                size = len(chunk.get("content") or "")
                if used + size > max_chars and included:
                    break
                if used + size > max_chars and not included:
                    warnings.append(
                        f"context {context.context_type}:{context.object_id} truncated"
                    )
                    break
                chunks.append(chunk)
                used += size
                included += 1
            if included < len(context.chunks):
                warnings.append(
                    f"context {context.context_type}:{context.object_id} truncated"
                )
        if refs_out and not chunks:
            warnings.append("no authorized context content available")
        return refs_out, chunks, _dedupe(warnings)

    def available_types(self) -> list[str]:
        return sorted(self.adapters)


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def estimate_tokens(text: str) -> int:
    """Cheap, provider-neutral token estimate for budgeting (not billing)."""
    if not text:
        return 0
    return max(1, math.ceil(len(text) / 4))
