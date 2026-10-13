"""Authorized retrieval and retrieval-augmented generation (Phase 7).

Pipeline: embed query -> vector search (tenant-scoped) -> ACL + classification
filter (server-side, before content is used) -> rank -> bounded context -> answer
with citations. When evidence is weak or absent the service returns an explicit
"insufficient evidence" result and never fabricates citations.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository, SearchBackend
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError, ServiceUnavailableError
from ai_api.domain.models.provider import ChatRequest, EmbeddingRequest, Message, Role
from ai_api.infrastructure.providers.registry import default_chat_model, default_embedding_model
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.logging import get_logger, request_id_var
from ai_api.telemetry.metrics import observe_retrieval
from ai_api.telemetry.tracing import span

logger = get_logger("retrieval")

INSUFFICIENT_EVIDENCE_TEXT = (
    "The available knowledge does not contain enough evidence to answer this question."
)

RAG_SYSTEM_PROMPT = (
    "You are an enterprise knowledge assistant. Answer ONLY using the provided "
    "context. Cite sources as [n] matching the context items. If the context does "
    "not contain the answer, reply exactly: "
    f"'{INSUFFICIENT_EVIDENCE_TEXT}' Do not use outside knowledge."
)


@dataclass(slots=True)
class RetrievalService:
    repository: AiRepository
    gateway: ModelGateway
    governance: GovernanceService
    audit: AuditService
    access: AccessControl
    settings: Settings
    events: EventPublisher | None = None
    search_backend: SearchBackend | None = None

    async def search(self, principal: Principal, payload: Any) -> dict[str, Any]:
        results = await self.authorized_search(
            principal, payload.query, limit=payload.limit
        )
        return {
            "query": payload.query,
            "count": len(results),
            "results": [self.serialize_result(item) for item in results],
        }

    async def authorized_search(
        self, principal: Principal, query: str, *, limit: int
    ) -> list[dict[str, Any]]:
        """Return ranked, ACL- and classification-filtered knowledge candidates.

        Authorization and the classification ceiling are applied server-side
        before any content is used; similarity scores never grant access. Shared
        by the retrieval endpoint, RAG query and the knowledge agent tool.
        """
        tenant_id = require_tenant(principal)
        policy = await self.governance.policy_for(tenant_id)
        started = time.perf_counter()
        outcome = "success"
        results: list[dict[str, Any]] = []
        try:
            with span("ai.retrieval.search", {"ai.operation": "retrieval.search"}):
                vector = await self._embed_query(query)
                candidate_limit = max(
                    limit * self.settings.ai_retrieval_candidate_multiplier, limit
                )
                vector_candidates = await self.repository.vector_search(
                    tenant_id, vector, limit=candidate_limit
                )
                ranked_lists = [self._authorize(principal, policy, vector_candidates)]
                if self.settings.ai_hybrid_search_enabled:
                    lexical = await self._lexical_candidates(tenant_id, query, candidate_limit)
                    if lexical:
                        ranked_lists.append(self._authorize(principal, policy, lexical))
                results = self._fuse(ranked_lists)[:limit]
            return results
        except Exception:
            outcome = "error"
            raise
        finally:
            observe_retrieval(
                operation="search",
                outcome=outcome,
                duration_seconds=time.perf_counter() - started,
                result_count=len(results),
            )

    async def _lexical_candidates(
        self, tenant_id: int, query: str, limit: int
    ) -> list[dict[str, Any]]:
        if self.search_backend is None:
            return []
        try:
            return await self.search_backend.search(tenant_id, query, limit=limit)
        except (ConfigurationError, ServiceUnavailableError) as exc:
            logger.warning("retrieval.lexical_unavailable", error=str(exc))
            return []

    def _fuse(self, ranked_lists: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        """Reciprocal rank fusion of authorized vector/lexical candidate lists.

        Authorization already happened per list, so a high-ranked unauthorized
        chunk can never push an authorized one out of the fused result. When only
        one list is present the original similarity scores are preserved.
        """

        lists = [items for items in ranked_lists if items]
        if not lists:
            return []
        if len(lists) == 1:
            return list(lists[0])
        k = self.settings.ai_rrf_k
        scores: dict[Any, float] = {}
        items: dict[Any, dict[str, Any]] = {}
        for items_list in lists:
            for rank, candidate in enumerate(items_list, start=1):
                key = candidate["chunk_id"]
                scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
                items.setdefault(key, candidate)
        fused: list[dict[str, Any]] = []
        for key, candidate in items.items():
            merged = dict(candidate)
            merged["score"] = round(scores[key], 6)
            fused.append(merged)
        fused.sort(key=lambda item: item["score"], reverse=True)
        return fused

    async def rag_query(self, principal: Principal, payload: Any) -> dict[str, Any]:
        with span("ai.rag.query", {"ai.operation": "rag", "ai.model": payload.model}):
            return await self._rag_query_impl(principal, payload)

    async def _rag_query_impl(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        model = payload.model or default_chat_model(self.settings)
        await self.governance.enforce(
            principal, operation="rag", model=model, prompt_text=payload.query, feature="rag_query"
        )
        ranked = await self.authorized_search(principal, payload.query, limit=payload.limit)
        best_score = max(
            (float(item.get("vector_score") or 0.0) for item in ranked), default=0.0
        )

        if not ranked or best_score < self.settings.ai_rag_min_score:
            await self._record_conversation(
                principal, model, payload.query, answered=False, citations=0
            )
            await self.audit.record(
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                action="ai.rag.query",
                resource_type="knowledge",
                resource_id=None,
                request_id=request_id_var.get(),
                detail={"insufficient_evidence": True, "confidence": round(best_score, 4)},
            )
            return {
                "answer": INSUFFICIENT_EVIDENCE_TEXT,
                "insufficient_evidence": True,
                "citations": [],
                "confidence": round(best_score, 4),
                "is_mock": True,
                "request_id": request_id_var.get(),
            }

        context = self.build_context(ranked)
        guard = PromptGuard()
        messages = (
            Message(role=Role.system, content=guard.harden_system_prompt(RAG_SYSTEM_PROMPT)),
            Message(role=Role.user, content=f"Context:\n{context}\n\nQuestion: {payload.query}"),
        )
        started = time.perf_counter()
        response = await self.gateway.chat(
            ChatRequest(messages=messages, model=model, temperature=0.0)
        )
        latency_ms = int((time.perf_counter() - started) * 1000)

        citations = [self.citation(index, item) for index, item in enumerate(ranked, start=1)]
        await self._record_conversation(
            principal, model, payload.query, answered=True, citations=len(citations),
            response=response, latency_ms=latency_ms,
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.rag.query",
            resource_type="knowledge",
            resource_id=None,
            request_id=request_id_var.get(),
            detail={"citations": len(citations), "confidence": round(best_score, 4)},
        )
        return {
            "answer": response.content,
            "insufficient_evidence": False,
            "citations": citations,
            "confidence": round(best_score, 4),
            "is_mock": response.is_mock,
            "model": response.model,
            "provider": response.provider,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "request_id": request_id_var.get(),
        }

    async def _embed_query(self, query: str) -> list[float]:
        response = await self.gateway.embed(
            EmbeddingRequest(texts=(query,), model=default_embedding_model(self.settings))
        )
        return list(response.vectors[0])

    def _authorize(
        self,
        principal: Principal,
        policy: Any,
        candidates: list[dict[str, Any]],
        *,
        is_vector: bool = True,
    ) -> list[dict[str, Any]]:
        ceiling = policy.data_classification_ceiling
        allowed: list[dict[str, Any]] = []
        for candidate in candidates:
            if not within_ceiling(candidate.get("classification"), ceiling):
                continue
            if not self.access.allows(principal, candidate.get("acl")):
                continue
            candidate = dict(candidate)
            score = round(float(candidate.get("score", 0.0)), 6)
            candidate["score"] = score
            if is_vector:
                candidate["vector_score"] = score
            allowed.append(candidate)
        allowed.sort(key=lambda item: item["score"], reverse=True)
        return allowed

    def build_context(self, items: list[dict[str, Any]]) -> str:
        budget = self.settings.ai_rag_max_context_chars
        blocks: list[str] = []
        used = 0
        for index, item in enumerate(items, start=1):
            header = f"[{index}] ({item['source_code']}#{item['chunk_index']})\n"
            body = item["content"]
            block = header + body
            if used + len(block) > budget and blocks:
                break
            blocks.append(block)
            used += len(block)
        return "\n\n".join(blocks)

    @staticmethod
    def serialize_result(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "chunk_id": item["chunk_id"],
            "document_id": item["document_id"],
            "source_id": item["source_id"],
            "source_code": item["source_code"],
            "chunk_index": item["chunk_index"],
            "page": item.get("page"),
            "section": item.get("section"),
            "score": item["score"],
            "classification": item.get("classification"),
            "content": item["content"],
        }

    @staticmethod
    def citation(rank: int, item: dict[str, Any]) -> dict[str, Any]:
        snippet = item["content"][:280]
        return {
            "rank": rank,
            "source_id": item["source_id"],
            "source_code": item["source_code"],
            "document_id": item["document_id"],
            "chunk_id": item["chunk_id"],
            "chunk_index": item["chunk_index"],
            "page": item.get("page"),
            "section": item.get("section"),
            "score": item["score"],
            "snippet": snippet,
        }

    async def _record_conversation(
        self,
        principal: Principal,
        model: str,
        query: str,
        *,
        answered: bool,
        citations: int,
        response: Any = None,
        latency_ms: int | None = None,
    ) -> None:
        if principal.tenant_id is None:
            return
        try:
            execution = await self.repository.record_execution(
                principal.tenant_id,
                {
                    "actor_id": principal.actor_id,
                    "operation": "rag",
                    "status": "succeeded" if answered else "cancelled",
                    "input": {"query_length": len(query), "citations": citations},
                    "token_usage": {
                        "input_tokens": response.usage.input_tokens if response else 0,
                        "output_tokens": response.usage.output_tokens if response else 0,
                        "total_tokens": response.usage.total_tokens if response else 0,
                    },
                    "latency_ms": latency_ms,
                    "request_id": request_id_var.get(),
                },
            )
            if response is not None:
                await self.repository.record_usage(
                    principal.tenant_id,
                    {
                        "execution_id": execution["id"],
                        "provider_code": response.provider,
                        "model_code": response.model,
                        "kind": "input",
                        "quantity": response.usage.input_tokens,
                        "unit": "tokens",
                    },
                )
                await self.repository.record_usage(
                    principal.tenant_id,
                    {
                        "execution_id": execution["id"],
                        "provider_code": response.provider,
                        "model_code": response.model,
                        "kind": "output",
                        "quantity": response.usage.output_tokens,
                        "unit": "tokens",
                        "total_cost": response.estimated_cost_usd,
                    },
                )
            if self.events is not None:
                await self.events.ai_request_completed(
                    tenant_id=principal.tenant_id,
                    actor_id=principal.actor_id,
                    operation="rag",
                    model=response.model if response else model,
                    provider=response.provider if response else None,
                    status="succeeded" if answered else "cancelled",
                    is_mock=response.is_mock if response else True,
                    latency_ms=latency_ms,
                    input_tokens=response.usage.input_tokens if response else 0,
                    output_tokens=response.usage.output_tokens if response else 0,
                    total_tokens=response.usage.total_tokens if response else 0,
                )
        except Exception as exc:  # noqa: BLE001 - persistence must not fail the request
            logger.warning("rag.persist_failed", error=str(exc))
