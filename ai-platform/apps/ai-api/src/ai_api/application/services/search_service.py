"""Enterprise search service (Stage 4): facets, suggestions, saved, history.

This service is a thin, read-mostly layer over :class:`RetrievalService`. It
never re-implements retrieval: the search endpoint and the facet endpoint run the
same authorized, ranked pipeline, so facet counts can only ever describe results
the caller is allowed to see. Saved searches and history are *personal* — every
read and delete is scoped to the exact actor — and a saved search stores the
request, never a frozen result set, so replaying it re-applies current ACLs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import NotFoundError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("search")

# Fields that can be turned into facets. Every one maps directly to a key on the
# consolidated search result, so facets stay consistent with what the user sees.
FACET_FIELDS: tuple[str, ...] = (
    "mime_type",
    "classification",
    "document_status",
    "source_code",
)

# Facet/suggestion hard caps so a single request can never fan out unbounded.
MAX_FACET_BUCKETS = 20
MAX_FACET_CANDIDATES = 200
MAX_SUGGESTIONS = 10


@dataclass(slots=True)
class SearchService:
    repository: AiRepository
    retrieval: RetrievalService
    audit: AuditService
    settings: Settings

    # --- Search + history -------------------------------------------------
    async def search(self, principal: Principal, payload: Any) -> dict[str, Any]:
        """Run a search and best-effort record it in history and the audit log."""
        result = await self.retrieval.search(principal, payload)
        await self._record_history(principal, payload, result)
        await self._audit(
            principal,
            "ai.search.query",
            detail={
                "mode": result.get("mode", payload.mode),
                "sort": payload.sort,
                "filter_fields": [f.field for f in payload.filters],
                "result_count": int(result.get("total", 0)),
                "fallback": bool(result.get("fallback", False)),
            },
        )
        return result

    async def _record_history(
        self, principal: Principal, payload: Any, result: dict[str, Any]
    ) -> None:
        if principal.tenant_id is None:
            return
        try:
            await self.repository.record_search_history(
                principal.tenant_id,
                {
                    "actor_id": principal.actor_id,
                    "query": payload.query,
                    "mode": result.get("mode", payload.mode),
                    "filters": [f.model_dump() for f in payload.filters],
                    "sort": payload.sort,
                    "result_count": int(result.get("total", 0)),
                    "fallback": bool(result.get("fallback", False)),
                },
            )
        except Exception as exc:  # noqa: BLE001 - history must not fail a search
            logger.warning("search.history_persist_failed", error=str(exc))

    async def list_history(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_search_history(
            tenant_id, principal.actor_id, limit=limit, offset=offset
        )

    async def delete_history(self, principal: Principal, history_id: int) -> None:
        tenant_id = require_tenant(principal)
        deleted = await self.repository.delete_search_history(
            tenant_id, history_id, principal.actor_id
        )
        if not deleted:
            raise NotFoundError(
                "history entry not found", details={"history_id": history_id}
            )

    async def clear_history(self, principal: Principal) -> int:
        tenant_id = require_tenant(principal)
        removed = await self.repository.clear_search_history(tenant_id, principal.actor_id)
        await self._audit(
            principal, "ai.search.history_clear", detail={"removed": removed}
        )
        return removed

    # --- Saved searches ---------------------------------------------------
    async def create_saved(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        saved = await self.repository.create_saved_search(
            tenant_id,
            {
                "actor_id": principal.actor_id,
                "name": payload.name.strip(),
                "query": payload.query.strip(),
                "mode": payload.mode,
                "filters": [f.model_dump() for f in payload.filters],
                "sort": payload.sort,
                "metadata": payload.metadata,
            },
        )
        await self._audit(
            principal,
            "ai.search.saved_create",
            resource_id=str(saved["id"]),
            detail={"mode": payload.mode, "sort": payload.sort},
        )
        return saved

    async def list_saved(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_saved_searches(
            tenant_id, principal.actor_id, limit=limit, offset=offset
        )

    async def get_saved(self, principal: Principal, saved_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        saved = await self.repository.get_saved_search(
            tenant_id, saved_id, principal.actor_id
        )
        if saved is None:
            raise NotFoundError("saved search not found", details={"saved_id": saved_id})
        return saved

    async def delete_saved(self, principal: Principal, saved_id: int) -> None:
        tenant_id = require_tenant(principal)
        deleted = await self.repository.delete_saved_search(
            tenant_id, saved_id, principal.actor_id
        )
        if not deleted:
            raise NotFoundError("saved search not found", details={"saved_id": saved_id})
        await self._audit(
            principal,
            "ai.search.saved_delete",
            resource_id=str(saved_id),
        )

    # --- Facets + suggestions --------------------------------------------
    async def facets(
        self,
        principal: Principal,
        *,
        query: str,
        mode: str,
        filters: list[Any],
        limit: int,
    ) -> dict[str, Any]:
        """Authorized facet counts over the same ranked set the user sees."""
        docs, effective, fallback = await self.retrieval.ranked_documents(
            principal,
            query=query,
            mode=mode,
            filters=filters,
            sort="relevance",
            limit=min(limit, MAX_FACET_CANDIDATES),
        )
        facets = []
        for field in FACET_FIELDS:
            counts: dict[str, int] = {}
            for doc in docs:
                value = doc.get(field)
                if value is None:
                    continue
                key = str(value)
                counts[key] = counts.get(key, 0) + 1
            ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            facets.append(
                {
                    "field": field,
                    "buckets": [
                        {"value": value, "count": count}
                        for value, count in ordered[:MAX_FACET_BUCKETS]
                    ],
                }
            )
        return {
            "query": query,
            "mode": effective,
            "fallback": fallback,
            "total": len(docs),
            "facets": facets,
        }

    async def suggestions(
        self, principal: Principal, *, query: str, limit: int
    ) -> list[str]:
        """Suggestions from the caller's own history/saved searches only.

        Scoped to the actor so one user's queries can never surface to another.
        This is intentionally cheap (no retrieval) so it is safe to call on
        every keystroke.
        """
        tenant_id = require_tenant(principal)
        cap = min(limit, MAX_SUGGESTIONS)
        needle = query.strip().lower()
        seen: list[str] = []
        history, _ = await self.repository.list_search_history(
            tenant_id, principal.actor_id, limit=100, offset=0
        )
        for row in history:
            text = (row.get("query") or "").strip()
            if not text or (needle and needle not in text.lower()):
                continue
            if text not in seen:
                seen.append(text)
            if len(seen) >= cap:
                return seen
        saved, _ = await self.repository.list_saved_searches(
            tenant_id, principal.actor_id, limit=100, offset=0
        )
        for row in saved:
            for text in ((row.get("name") or "").strip(), (row.get("query") or "").strip()):
                if not text or (needle and needle not in text.lower()):
                    continue
                if text not in seen:
                    seen.append(text)
                if len(seen) >= cap:
                    return seen
        return seen

    # --- Index health + reconciliation (Phase 4) --------------------------
    async def health(self, principal: Principal) -> dict[str, Any]:
        """Tenant-scoped index health; flags degraded when work is outstanding."""
        tenant_id = require_tenant(principal)
        stats = await self.repository.search_index_stats(tenant_id)
        backend = getattr(self.retrieval.search_backend, "name", None)
        # Degraded reflects the *current corpus* state. Historic failed jobs that
        # were later superseded by a successful reindex must not pin the tenant
        # to degraded forever, so job counts remain informational only.
        degraded = any(
            stats[key]
            for key in ("documents_stale", "documents_missing", "documents_failed")
        )
        return {
            "status": "degraded" if degraded else "ok",
            "tenant_id": tenant_id,
            "search_backend": backend or self.settings.search_provider,
            "hybrid_search": self.settings.ai_hybrid_search_enabled,
            "documents": {
                "total": stats["documents_total"],
                "indexed": stats["documents_indexed"],
                "pending": stats["documents_pending"],
                "stale": stats["documents_stale"],
                "missing": stats["documents_missing"],
                "failed": stats["documents_failed"],
            },
            "chunks_total": stats["chunks_total"],
            "embeddings_total": stats["embeddings_total"],
            "jobs": stats.get("jobs", {}),
            "last_indexed_at": stats.get("last_indexed_at"),
        }

    async def index_status(
        self, principal: Principal, *, problem_limit: int = 50
    ) -> dict[str, Any]:
        """Per-source index status plus a bounded list of problem documents."""
        tenant_id = require_tenant(principal)
        stats = await self.repository.search_index_stats(tenant_id)
        sources = await self.repository.search_index_status_by_source(tenant_id)
        problems = await self.repository.list_problem_documents(
            tenant_id, limit=problem_limit
        )
        return {
            "totals": {
                "total": stats["documents_total"],
                "indexed": stats["documents_indexed"],
                "pending": stats["documents_pending"],
                "stale": stats["documents_stale"],
                "missing": stats["documents_missing"],
                "failed": stats["documents_failed"],
            },
            "sources": sources,
            "problem_documents": problems,
        }

    async def _audit(
        self,
        principal: Principal,
        action: str,
        *,
        resource_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="search",
            resource_id=resource_id,
            request_id=request_id_var.get(),
            detail=detail,
        )
