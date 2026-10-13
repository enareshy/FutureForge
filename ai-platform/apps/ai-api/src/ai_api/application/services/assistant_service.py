"""Enterprise Knowledge Assistant conversations (Stage 3).

Each conversation is tenant- and actor-scoped. Answering a question always runs
the retrieval pipeline live (re-embedding the query and re-checking ACLs and the
classification ceiling), so a stored history can never become a route to content
the user is no longer allowed to access. Citations are persisted as snapshots
(score/snippet/location) for audit, independent of later re-indexing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.schemas.retrieval import RagQueryRequest
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var

# How many sources to retrieve/attach for a single assistant answer.
_ASSISTANT_RETRIEVAL_LIMIT = 5


@dataclass(slots=True)
class AssistantService:
    repository: AiRepository
    retrieval: RetrievalService
    audit: AuditService
    settings: Settings

    async def create_conversation(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        conversation = await self.repository.create_conversation(
            tenant_id,
            {
                "actor_id": principal.actor_id,
                "title": payload.title,
                "metadata": payload.metadata,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.assistant.conversation_create",
            resource_type="assistant_conversation",
            resource_id=str(conversation["id"]),
            request_id=request_id_var.get(),
        )
        return {**conversation, "message_count": 0}

    async def list_conversations(
        self,
        principal: Principal,
        *,
        mine: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        actor_id = principal.actor_id if mine else None
        items, total = await self.repository.list_conversations(
            tenant_id, actor_id, limit=limit, offset=offset
        )
        enriched: list[dict[str, Any]] = []
        for item in items:
            _, count = await self.repository.list_messages(
                tenant_id, item["id"], limit=1, offset=0
            )
            enriched.append({**item, "message_count": count})
        return enriched, total

    async def get_conversation(
        self, principal: Principal, conversation_id: int
    ) -> dict[str, Any]:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        messages, _ = await self.repository.list_messages(
            tenant_id, conversation_id, limit=500, offset=0
        )
        enriched_messages = []
        for message in messages:
            sources = await self.repository.get_message_sources(tenant_id, message["id"])
            enriched_messages.append(self._message_out(message, sources))
        _, count = await self.repository.list_messages(
            tenant_id, conversation_id, limit=1, offset=0
        )
        return {
            "conversation": {**conversation, "message_count": count},
            "messages": enriched_messages,
        }

    async def delete_conversation(self, principal: Principal, conversation_id: int) -> None:
        tenant_id = require_tenant(principal)
        await self._owned_conversation(principal, conversation_id)
        deleted = await self.repository.delete_conversation(tenant_id, conversation_id)
        if not deleted:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.assistant.conversation_delete",
            resource_type="assistant_conversation",
            resource_id=str(conversation_id),
            request_id=request_id_var.get(),
        )

    async def ask(
        self, principal: Principal, conversation_id: int, payload: Any
    ) -> dict[str, Any]:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)

        await self.repository.add_message(
            tenant_id,
            conversation["id"],
            {
                "role": "user",
                "content": payload.content,
                "request_id": request_id_var.get(),
            },
        )

        result = await self.retrieval.rag_query(
            principal,
            RagQueryRequest(
                query=payload.content,
                limit=_ASSISTANT_RETRIEVAL_LIMIT,
                model=payload.model,
            ),
        )
        insufficient = bool(result.get("insufficient_evidence"))
        answer_status = "insufficient_evidence" if insufficient else "answered"
        citations = result.get("citations") or []
        usage = result.get("usage") or {}

        message = await self.repository.add_message(
            tenant_id,
            conversation["id"],
            {
                "role": "assistant",
                "content": result.get("answer", ""),
                "answer_status": answer_status,
                "confidence": result.get("confidence"),
                "is_mock": result.get("is_mock"),
                "model_code": result.get("model"),
                "provider_code": result.get("provider"),
                "token_usage": usage,
                "request_id": result.get("request_id") or request_id_var.get(),
            },
        )
        sources = [self._source_row(citation) for citation in citations]
        if sources:
            await self.repository.add_message_sources(tenant_id, message["id"], sources)
        await self.repository.touch_conversation(tenant_id, conversation["id"])
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.assistant.ask",
            resource_type="assistant_message",
            resource_id=str(message["id"]),
            request_id=request_id_var.get(),
            detail={"answer_status": answer_status, "citations": len(sources)},
        )
        return self._message_out(message, sources)

    async def submit_feedback(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        comment = payload.comment.strip() if payload.comment else None
        if payload.rating is None and not comment:
            raise ValidationError("provide a rating or a comment")
        message = await self.repository.get_message(tenant_id, payload.message_id)
        if message is None:
            raise NotFoundError(
                "assistant message not found", details={"message_id": payload.message_id}
            )
        await self._owned_conversation(principal, message["conversation_id"])
        record = await self.repository.record_feedback(
            tenant_id,
            {
                "execution_id": message.get("execution_id"),
                "message_id": message["id"],
                "actor_id": principal.actor_id,
                "rating": payload.rating,
                "comment": comment,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.assistant.feedback",
            resource_type="assistant_message",
            resource_id=str(message["id"]),
            request_id=request_id_var.get(),
            detail={"rating": payload.rating},
        )
        return record

    async def _owned_conversation(
        self, principal: Principal, conversation_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        conversation = await self.repository.get_conversation(tenant_id, conversation_id)
        if conversation is None:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        owner = conversation.get("actor_id")
        if owner is not None and principal.actor_id is not None and owner != principal.actor_id:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        return conversation

    @staticmethod
    def _source_row(citation: dict[str, Any]) -> dict[str, Any]:
        return {
            "rank": citation["rank"],
            "source_id": citation.get("source_id"),
            "document_id": citation.get("document_id"),
            "chunk_id": citation.get("chunk_id"),
            "source_code": citation.get("source_code"),
            "chunk_index": citation.get("chunk_index"),
            "page": citation.get("page"),
            "section": citation.get("section"),
            "score": citation.get("score"),
            "snippet": citation.get("snippet"),
        }

    @staticmethod
    def _message_out(
        message: dict[str, Any], sources: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return {
            "id": message["id"],
            "conversation_id": message["conversation_id"],
            "role": message["role"],
            "content": message["content"],
            "answer_status": message.get("answer_status"),
            "confidence": (
                float(message["confidence"])
                if message.get("confidence") is not None
                else None
            ),
            "is_mock": message.get("is_mock"),
            "model_code": message.get("model_code"),
            "provider_code": message.get("provider_code"),
            "token_usage": message.get("token_usage") or {},
            "latency_ms": message.get("latency_ms"),
            "created_at": message["created_at"],
            "sources": [AssistantService._source_out(s) for s in sources],
        }

    @staticmethod
    def _source_out(source: dict[str, Any]) -> dict[str, Any]:
        score = source.get("score")
        return {
            "rank": source["rank"],
            "source_id": source.get("source_id"),
            "document_id": source.get("document_id"),
            "chunk_id": source.get("chunk_id"),
            "source_code": source.get("source_code"),
            "chunk_index": source.get("chunk_index"),
            "page": source.get("page"),
            "section": source.get("section"),
            "score": float(score) if score is not None else None,
            "snippet": source.get("snippet"),
        }
