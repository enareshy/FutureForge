"""Authorized retrieval and retrieval-augmented generation (Phase 7).

Pipeline: embed query -> vector search (tenant-scoped) -> ACL + classification
filter (server-side, before content is used) -> rank -> bounded context -> answer
with citations. When evidence is weak or absent the service returns an explicit
"insufficient evidence" result and never fabricates citations.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository, SearchBackend
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.citation_validation import (
    ANSWER_STATUS_INSUFFICIENT,
    validate_inline_citations,
)
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.prompt_security import (
    blocking_enabled,
    filter_evidence,
    screen_input,
)
from ai_api.application.services.search_filters import apply_filters, validate_filters
from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError, ServiceUnavailableError
from ai_api.domain.models.provider import ChatRequest, EmbeddingRequest, Message, Role
from ai_api.infrastructure.providers.registry import default_chat_model, default_embedding_model
from ai_api.security.access_control import (
    AccessControl,
    classification_rank,
    within_ceiling,
)
from ai_api.security.policies import Principal
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.logging import get_logger, request_id_var
from ai_api.telemetry.metrics import observe_retrieval, record_citation_validation
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


def _effective_mode(requested: str, has_vector: bool, has_lexical: bool) -> str:
    """The retrieval mode actually used, so results are never mislabelled."""
    if requested == "semantic":
        return "semantic"
    if requested == "lexical":
        return "lexical"
    if has_vector and has_lexical:
        return "hybrid"
    if has_vector:
        return "semantic"
    if has_lexical:
        return "lexical"
    return "hybrid"


def _recency_key(item: dict[str, Any]) -> str:
    value = item.get("document_created_at")
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _context_label(value: Any) -> str:
    """One-line, length-bounded metadata label for the RAG context header."""
    return " ".join(str(value).split())[:120]


def _freshness(value: Any, half_life_days: float) -> float:
    """Recency decay in [0, 1]: 1 for now, 0.5 after one half-life, →0 older."""
    if half_life_days <= 0 or value is None:
        return 0.0
    try:
        created = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return 0.0
    if created.tzinfo is None:
        created = created.replace(tzinfo=UTC)
    age_days = max((datetime.now(UTC) - created).total_seconds(), 0.0) / 86400.0
    return 0.5 ** (age_days / half_life_days)


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
        ranked, mode, fallback = await self.ranked_documents(
            principal,
            query=payload.query,
            mode=payload.mode,
            filters=list(payload.filters),
            sort=payload.sort,
            limit=payload.limit,
        )
        total = len(ranked)
        offset = (payload.page - 1) * payload.limit
        page = ranked[offset : offset + payload.limit]
        return {
            "query": payload.query,
            "count": len(page),
            "total": total,
            "mode": mode,
            "requested_mode": payload.mode,
            "fallback": fallback,
            "page": payload.page,
            "limit": payload.limit,
            "sort": payload.sort,
            "filters": [f.model_dump() for f in payload.filters],
            "results": [self.serialize_result(item) for item in page],
        }

    async def ranked_documents(
        self,
        principal: Principal,
        *,
        query: str,
        mode: str,
        filters: list[Any],
        sort: str,
        limit: int,
    ) -> tuple[list[dict[str, Any]], str, bool]:
        """Run a full search and return (ranked-documents, mode, fallback).

        Shared by the search endpoint and the facet endpoint so both operate on
        exactly the same authorized, ranked, document-consolidated result set.
        Consolidation happens *before* an explicit sort so the representative
        passage is always the best-scoring one, regardless of the display sort.
        """
        chunks, effective, fallback = await self._search_candidates(
            principal, query, mode=mode, filters=list(filters), limit=limit
        )
        ranked = self._apply_ranking(chunks, query)
        if self.settings.ai_search_consolidate_documents:
            ranked = self._consolidate_documents(ranked)
        ranked = self._sort_results(ranked, sort)
        return ranked, effective, fallback

    async def authorized_search(
        self,
        principal: Principal,
        query: str,
        *,
        limit: int,
        mode: str = "hybrid",
        filters: list[Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Return ranked, ACL- and classification-filtered knowledge candidates.

        Authorization and the classification ceiling are applied server-side
        before any content is used; similarity scores never grant access. Shared
        by the retrieval endpoint, RAG query and the knowledge agent tool. Results
        stay at chunk level (with citations) rather than being consolidated.
        """
        chunks, _mode, _fallback = await self._search_candidates(
            principal,
            query,
            mode=mode,
            filters=list(filters or []),
            limit=limit,
        )
        return self._sort_results(chunks, "relevance")[:limit]

    async def _search_candidates(
        self,
        principal: Principal,
        query: str,
        *,
        mode: str,
        filters: list[Any],
        limit: int,
    ) -> tuple[list[dict[str, Any]], str, bool]:
        """Run authorized retrieval and return (authorized-chunks, mode, fallback).

        ``mode`` is the requested retrieval mode; the returned mode is the one
        actually used, so lexical/semantic-only results are never mislabelled as
        hybrid. Filters are validated and applied to already-authorized
        candidates only.
        """
        filters = validate_filters(list(filters))
        tenant_id = require_tenant(principal)
        policy = await self.governance.policy_for(tenant_id)
        requested = mode
        if mode == "hybrid" and not self.settings.ai_hybrid_search_enabled:
            mode = "semantic"
        candidate_limit = max(limit * self.settings.ai_retrieval_candidate_multiplier, limit)
        started = time.perf_counter()
        outcome = "success"
        result_count = 0
        try:
            with span("ai.retrieval.search", {"ai.operation": "retrieval.search"}):
                ranked_lists: list[list[dict[str, Any]]] = []
                has_vector = mode in ("hybrid", "semantic")
                has_lexical = False
                lexical_available = True
                if has_vector:
                    vector = await self._embed_query(query)
                    vector_candidates = await self.repository.vector_search(
                        tenant_id, vector, limit=candidate_limit
                    )
                    ranked_lists.append(
                        self._prepare_candidates(vector_candidates, is_vector=True)
                    )
                if mode in ("hybrid", "lexical"):
                    lexical = await self._lexical_candidates(tenant_id, query, candidate_limit)
                    if lexical is None:
                        lexical_available = False
                    elif lexical:
                        ranked_lists.append(
                            self._prepare_candidates(lexical, is_vector=False)
                        )
                        has_lexical = True
                fused = self._fuse(ranked_lists)
                fused = await self._authorize_live(
                    tenant_id, principal, policy, fused
                )
                authorized = apply_filters(fused, filters)
                result_count = len(authorized)
            effective = _effective_mode(requested, has_vector, has_lexical)
            fallback = requested != effective or (
                mode in ("hybrid", "lexical") and not lexical_available
            )
            return authorized, effective, fallback
        except Exception:
            outcome = "error"
            raise
        finally:
            observe_retrieval(
                operation="search",
                outcome=outcome,
                duration_seconds=time.perf_counter() - started,
                result_count=result_count,
            )

    async def _lexical_candidates(
        self, tenant_id: int, query: str, limit: int
    ) -> list[dict[str, Any]] | None:
        """Lexical candidates, or ``None`` when the backend is unavailable.

        ``None`` (unavailable) and ``[]`` (available, no matches) are distinct so
        callers can report fallback honestly instead of claiming hybrid.
        """
        if self.search_backend is None:
            return None
        try:
            return await self.search_backend.search(tenant_id, query, limit=limit)
        except (ConfigurationError, ServiceUnavailableError) as exc:
            logger.warning("retrieval.lexical_unavailable", error=str(exc))
            return None

    @staticmethod
    def _sort_results(results: list[dict[str, Any]], sort: str) -> list[dict[str, Any]]:
        if sort == "title":
            return sorted(
                results,
                key=lambda r: (r.get("title") is None, (r.get("title") or "").lower()),
            )
        if sort == "recency":
            return sorted(results, key=_recency_key, reverse=True)
        return results

    def _apply_ranking(
        self, results: list[dict[str, Any]], query: str
    ) -> list[dict[str, Any]]:
        """Apply explainable, multiplicative ranking boosts to authorized results.

        Boosts are multiplicative so the same rules work whether the base score is
        a cosine similarity or an RRF score. Every component is recorded on the
        result (``score_components``) for controlled diagnostics; none of this
        affects authorization.
        """
        settings = self.settings
        if not results:
            return results
        normalized = query.strip().lower()
        tokens = [t for t in re.split(r"[^a-z0-9._-]+", normalized) if len(t) >= 2]
        half_life = settings.ai_search_freshness_half_life_days
        use_freshness = half_life > 0 and settings.ai_search_freshness_weight > 0
        ranked: list[dict[str, Any]] = []
        for item in results:
            base = float(item.get("score") or 0.0)
            title = (item.get("title") or "").lower()
            external = (item.get("external_id") or "").lower()
            content = (item.get("content") or "").lower()
            exact = 1.0 if any(t in external or t in title for t in tokens) else 0.0
            phrase = 1.0 if normalized and (normalized in content or normalized in title) else 0.0
            title_hit = 1.0 if any(t in title for t in tokens) else 0.0
            freshness = (
                _freshness(item.get("document_created_at"), half_life)
                if use_freshness
                else 0.0
            )
            factor = (
                (1 + settings.ai_search_exact_boost * exact)
                * (1 + settings.ai_search_phrase_boost * phrase)
                * (1 + settings.ai_search_title_boost * title_hit)
                * (1 + settings.ai_search_freshness_weight * freshness)
            )
            merged = dict(item)
            merged["score"] = round(base * factor, 8)
            merged["score_components"] = {
                "base": round(base, 6),
                "exact": exact,
                "phrase": phrase,
                "title": title_hit,
                "freshness": round(freshness, 4),
            }
            ranked.append(merged)
        ranked.sort(key=lambda r: r["score"], reverse=True)
        return ranked

    @staticmethod
    def _consolidate_documents(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Collapse chunk matches into one document-level result each.

        Input must be score-ordered; the first (best) chunk per document becomes
        the representative and all matching chunk ids are retained so the UI can
        show which passages matched.
        """
        grouped: dict[Any, dict[str, Any]] = {}
        for item in results:
            document_id = item["document_id"]
            existing = grouped.get(document_id)
            if existing is None:
                merged = dict(item)
                merged["matched_chunks"] = [item["chunk_id"]]
                merged["hit_count"] = 1
                grouped[document_id] = merged
            else:
                existing["matched_chunks"].append(item["chunk_id"])
                existing["hit_count"] += 1
        return list(grouped.values())

    def _fuse(self, ranked_lists: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
        """Reciprocal rank fusion of vector/lexical candidate lists.

        Fusion is on raw candidates; the fused list is authorized afterwards
        against live document state, so an unauthorized chunk can never displace
        an authorized one based on its rank alone.
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
        policy = await self.governance.enforce(
            principal, operation="rag", model=model, prompt_text=payload.query, feature="rag_query"
        )
        guard = PromptGuard(block=blocking_enabled(policy, self.settings))
        await screen_input(
            self.audit,
            principal,
            guard=guard,
            texts=[payload.query],
            feature="rag_query",
            model=model,
            resource_type="knowledge",
        )
        ranked = await self.authorized_search(
            principal,
            payload.query,
            limit=payload.limit,
            mode=getattr(payload, "mode", "hybrid"),
            filters=getattr(payload, "filters", None),
        )
        ranked, evidence_scan = await filter_evidence(
            self.audit,
            principal,
            guard=guard,
            items=ranked,
            feature="rag_query",
            model=model,
            resource_type="knowledge",
        )
        # Threshold on cosine similarity when it exists. Lexical-only retrieval
        # has no cosine; a term match is itself the evidence, so the similarity
        # gate must not force a false "insufficient evidence" answer.
        vector_scores = [
            float(item["vector_score"])
            for item in ranked
            if item.get("vector_score") is not None
        ]
        if vector_scores:
            best_score = max(vector_scores)
            sufficient = best_score >= self.settings.ai_rag_min_score
        else:
            best_score = max(
                (float(item.get("score") or 0.0) for item in ranked), default=0.0
            )
            sufficient = bool(ranked)

        if not ranked or not sufficient:
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
                detail={
                    "insufficient_evidence": True,
                    "answer_status": ANSWER_STATUS_INSUFFICIENT,
                    "citation_status": "not_required",
                    "confidence": round(best_score, 4),
                    "injection_findings": len(evidence_scan.findings),
                },
            )
            return {
                "answer": INSUFFICIENT_EVIDENCE_TEXT,
                "insufficient_evidence": True,
                "answer_status": ANSWER_STATUS_INSUFFICIENT,
                "citations": [],
                "citations_required": False,
                "citation_status": "not_required",
                "warnings": ["insufficient_authorized_evidence"],
                "confidence": round(best_score, 4),
                "is_mock": True,
                "request_id": request_id_var.get(),
            }

        context = self.build_context(ranked)
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
        validation = validate_inline_citations(
            response.content,
            citations,
            required=True,
            evidence=ranked,
        )
        record_citation_validation(operation="rag", status=validation.status)
        answer_status = validation.answer_status()
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
            detail={
                "citations": len(citations),
                "answer_status": answer_status,
                "citation_status": validation.status,
                "citation_warnings": len(validation.warnings),
                "confidence": round(best_score, 4),
                "injection_findings": len(evidence_scan.findings),
            },
        )
        return {
            "answer": response.content,
            "insufficient_evidence": False,
            "answer_status": answer_status,
            "citations": citations,
            "citations_required": validation.required,
            "citation_status": validation.status,
            "warnings": list(validation.warnings),
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

    @staticmethod
    def _prepare_candidates(
        candidates: list[dict[str, Any]],
        *,
        is_vector: bool,
    ) -> list[dict[str, Any]]:
        """Normalize scores before fusion.

        This deliberately makes no access decision: authorization runs once on
        the fused list against authoritative document state (``_authorize_live``),
        so neither a stale search index nor a ranking score can grant access.
        """
        prepared: list[dict[str, Any]] = []
        for candidate in candidates:
            candidate = dict(candidate)
            score = round(float(candidate.get("score", 0.0)), 6)
            candidate["score"] = score
            if is_vector:
                candidate["vector_score"] = score
            prepared.append(candidate)
        prepared.sort(key=lambda item: item["score"], reverse=True)
        return prepared

    async def _authorize_live(
        self,
        tenant_id: int,
        principal: Principal,
        policy: Any,
        candidates: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Re-check every candidate against current, authoritative labels.

        The search backend (especially OpenSearch) is treated as a retrieval
        index, never as an authorization authority. Candidate ids are resolved
        against the repository; deleted documents, disabled sources, tightened
        ACLs and raised classifications are dropped even when the index still
        holds the old chunk. If authoritative state cannot be loaded the candidate
        set is empty (fail closed).
        """
        if not candidates:
            return []
        chunk_ids = list({item["chunk_id"] for item in candidates})
        live_rows = await self.repository.get_authoritative_chunks(
            tenant_id, chunk_ids
        )
        live_by_chunk = {row["chunk_id"]: row for row in live_rows}
        ceiling = policy.data_classification_ceiling
        allowed: list[dict[str, Any]] = []
        for candidate in candidates:
            live = live_by_chunk.get(candidate["chunk_id"])
            if live is None:
                continue
            if live.get("document_status") != "indexed":
                continue
            if live.get("source_status") == "disabled":
                continue
            labels = tuple(
                label
                for label in (
                    live.get("chunk_classification"),
                    live.get("document_classification"),
                    live.get("source_classification"),
                )
                if label
            )
            classification = max(
                labels, key=classification_rank, default="internal"
            )
            if not within_ceiling(classification, ceiling):
                continue
            if not all(
                self.access.allows(principal, acl)
                for acl in (
                    live.get("chunk_acl"),
                    live.get("document_acl"),
                    live.get("source_acl"),
                )
            ):
                continue
            merged = dict(candidate)
            merged.update(
                {
                    "document_id": live["document_id"],
                    "source_id": live["source_id"],
                    "chunk_index": live.get("chunk_index"),
                    "content": live.get("content", ""),
                    "classification": classification,
                    "acl": live.get("chunk_acl") or {},
                    "page": live.get("page"),
                    "section": live.get("section"),
                    "title": live.get("title"),
                    "mime_type": live.get("mime_type"),
                    "external_id": live.get("external_id"),
                    "document_status": live.get("document_status"),
                    "document_created_at": live.get("document_created_at"),
                    "document_updated_at": live.get("document_updated_at"),
                    "document_metadata": live.get("document_metadata") or {},
                    "document_version": live.get("document_version", 1),
                    "source_code": live.get("source_code"),
                    "source_name": live.get("source_name"),
                }
            )
            allowed.append(merged)
        allowed.sort(key=lambda item: item["score"], reverse=True)
        return allowed

    def build_context(self, items: list[dict[str, Any]]) -> str:
        budget = self.settings.ai_rag_max_context_chars
        blocks: list[str] = []
        used = 0
        for index, item in enumerate(items, start=1):
            labels: list[str] = []
            if item.get("title"):
                labels.append(f"title={_context_label(item['title'])}")
            if item.get("external_id"):
                labels.append(f"id={_context_label(item['external_id'])}")
            if item.get("document_status"):
                labels.append(f"status={_context_label(item['document_status'])}")
            updated = _iso_or_none(item.get("document_updated_at"))
            if updated:
                labels.append(f"updated={updated}")
            suffix = f" — {', '.join(labels)}" if labels else ""
            header = f"[{index}] ({item['source_code']}#{item['chunk_index']}{suffix})\n"
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
            "title": item.get("title"),
            "mime_type": item.get("mime_type"),
            "external_id": item.get("external_id"),
            "document_status": item.get("document_status"),
            "document_created_at": _iso_or_none(item.get("document_created_at")),
            "document_updated_at": _iso_or_none(item.get("document_updated_at")),
            "document_version": item.get("document_version", 1),
            "hit_count": item.get("hit_count", 1),
            "matched_chunks": item.get("matched_chunks"),
            "score_components": item.get("score_components"),
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
