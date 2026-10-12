"""Background indexing job processor (Phase 7).

Executes queued index jobs, updating job status/progress/attempts and surfacing
failures. Idempotent: already-completed jobs are not reprocessed. In production a
worker (`python -m ai_api.workers.indexer`) drains the queue; in development the
API may process jobs inline (``AI_INGEST_INLINE=true``). Kafka-based event
processing is introduced in Phase 8.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.schemas.knowledge import KnowledgeDocumentIn, KnowledgeIngestRequest
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("indexing")


@dataclass(slots=True)
class IndexingService:
    repository: AiRepository
    ingestion: IngestionService
    events: EventPublisher | None = None

    async def process_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            return None
        if job["status"] in ("succeeded", "cancelled"):
            return job

        await self.repository.update_job(
            tenant_id,
            job_id,
            {
                "status": "running",
                "started_at": datetime.now(UTC),
                "attempts": int(job.get("attempts", 0)) + 1,
            },
        )
        try:
            documents_payload = (job.get("payload") or {}).get("documents") or []
            principal = Principal(
                user_id="system-indexer",
                username="system-indexer",
                tenant_id=tenant_id,
                permissions=frozenset({"*:*"}),
                auth_source="system",
            )
            if documents_payload:
                payload = KnowledgeIngestRequest(
                    source_id=job["source_id"],
                    documents=[KnowledgeDocumentIn(**item) for item in documents_payload],
                )
                result = await self.ingestion.ingest(principal, payload)
            else:
                result = await self.ingestion.reindex_source(principal, job["source_id"])
            updated = await self.repository.update_job(
                tenant_id,
                job_id,
                {
                    "status": "succeeded",
                    "progress": 100.0,
                    "finished_at": datetime.now(UTC),
                    "result": result,
                },
            )
            if self.events is not None:
                await self.events.knowledge_index_completed(
                    tenant_id=tenant_id,
                    source_id=job["source_id"],
                    job_id=job_id,
                    documents=int(result.get("documents", 0)),
                    chunks=int(result.get("chunks", 0)),
                )
            return updated
        except Exception as exc:  # noqa: BLE001 - record failure and move on
            logger.warning("index.job_failed", job_id=job_id, error=str(exc))
            failed = await self.repository.update_job(
                tenant_id,
                job_id,
                {
                    "status": "failed",
                    "error": {"message": str(exc)[:500]},
                    "finished_at": datetime.now(UTC),
                },
            )
            if self.events is not None:
                await self.events.knowledge_index_failed(
                    tenant_id=tenant_id,
                    source_id=job["source_id"],
                    job_id=job_id,
                    error=str(exc),
                )
            return failed

    async def process_queued(self, *, limit: int = 10) -> list[dict[str, Any] | None]:
        jobs = await self.repository.list_jobs_by_status("queued", limit=limit)
        results: list[dict[str, Any] | None] = []
        for job in jobs:
            results.append(await self.process_job(job["tenant_id"], job["id"]))
        return results
