"""Background indexing job processor (Phase 7, hardened in Stage 3).

Executes queued index jobs with a bounded retry policy, a processing timeout, an
advisory lease (to avoid duplicate concurrent processing), and classified
failures so the API can show safe error summaries and retry only eligible jobs.

Idempotent: already-completed jobs are not reprocessed. In production a worker
(``python -m ai_api.workers.indexer``) drains the queue; in development the API
may process jobs inline (``AI_INGEST_INLINE=true``).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.config.settings import Settings
from ai_api.domain.errors import classify_error
from ai_api.schemas.knowledge import KnowledgeDocumentIn, KnowledgeIngestRequest
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.metrics import record_index_job

logger = get_logger("indexing")

STAGE_QUEUED = "queued"
STAGE_PROCESSING = "processing"
STAGE_COMPLETED = "completed"
STAGE_FAILED = "failed"


@dataclass(slots=True)
class IndexingService:
    repository: AiRepository
    ingestion: IngestionService
    settings: Settings
    events: EventPublisher | None = None

    async def process_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            return None
        if job["status"] in ("succeeded", "cancelled"):
            return job
        if self._is_leased(job):
            return job

        attempt = int(job.get("attempts", 0)) + 1
        await self.repository.update_job(
            tenant_id,
            job_id,
            {
                "status": "running",
                "stage": STAGE_PROCESSING,
                "started_at": datetime.now(UTC),
                "attempts": attempt,
                "lease_expires_at": datetime.now(UTC)
                + timedelta(seconds=self.settings.ai_job_lease_seconds),
            },
        )
        try:
            result = await asyncio.wait_for(
                self._run(tenant_id, job),
                timeout=self.settings.ai_job_timeout_seconds,
            )
        except Exception as exc:  # noqa: BLE001 - classify, retry or fail, never raise
            return await self._handle_failure(tenant_id, job, attempt, exc)

        updated = await self.repository.update_job(
            tenant_id,
            job_id,
            {
                "status": "succeeded",
                "stage": STAGE_COMPLETED,
                "progress": 100.0,
                "finished_at": datetime.now(UTC),
                "result": result,
                "error": None,
                "error_class": None,
                "lease_expires_at": None,
            },
        )
        if self.events is not None:
            await self.events.knowledge_index_completed(
                tenant_id=tenant_id,
                source_id=job.get("source_id"),
                job_id=job_id,
                documents=int(result.get("documents", 0)),
                chunks=int(result.get("chunks", 0)),
            )
        record_index_job(status="succeeded")
        return updated

    async def _run(self, tenant_id: int, job: dict[str, Any]) -> dict[str, Any]:
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
            return await self.ingestion.ingest(principal, payload)
        return await self.ingestion.reindex_source(principal, job["source_id"])

    async def _handle_failure(
        self,
        tenant_id: int,
        job: dict[str, Any],
        attempt: int,
        exc: BaseException,
    ) -> dict[str, Any] | None:
        error_class = classify_error(exc)
        max_attempts = int(job.get("max_attempts", self.settings.ai_max_job_attempts) or 0)
        retryable = error_class in {"timeout", "provider", "dependency", "storage"} and (
            max_attempts <= 0 or attempt < max_attempts
        )
        logger.warning(
            "index.job_failed",
            job_id=job["id"],
            error_class=error_class,
            attempt=attempt,
            retryable=retryable,
            error=str(exc)[:200],
        )
        fields: dict[str, Any] = {
            "stage": STAGE_QUEUED if retryable else STAGE_FAILED,
            "error_class": error_class,
            "error": {"message": str(exc)[:500], "class": error_class, "attempt": attempt},
            "lease_expires_at": None,
        }
        if retryable:
            fields["status"] = "queued"
            fields["started_at"] = None
        else:
            fields["status"] = "failed"
            fields["finished_at"] = datetime.now(UTC)
            if self.events is not None:
                await self.events.knowledge_index_failed(
                    tenant_id=tenant_id,
                    source_id=job.get("source_id"),
                    job_id=job["id"],
                    error=str(exc),
                )
            record_index_job(status="failed")
        return await self.repository.update_job(tenant_id, job["id"], fields)

    def _is_leased(self, job: dict[str, Any]) -> bool:
        if job.get("status") != "running":
            return False
        lease = job.get("lease_expires_at")
        if lease is None:
            return False
        if lease.tzinfo is None:
            lease = lease.replace(tzinfo=UTC)
        return lease > datetime.now(UTC)

    async def retry_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            return None
        if job["status"] not in ("failed", "queued"):
            return job
        return await self.repository.update_job(
            tenant_id,
            job_id,
            {
                "status": "queued",
                "stage": STAGE_QUEUED,
                "error": None,
                "error_class": None,
                "finished_at": None,
                "lease_expires_at": None,
            },
        )

    async def reclaim_stale_jobs(self, *, limit: int = 50) -> int:
        """Reset running jobs whose lease has expired back to queued."""

        jobs = await self.repository.list_jobs_by_status("running", limit=limit)
        now = datetime.now(UTC)
        reclaimed = 0
        for job in jobs:
            lease = job.get("lease_expires_at")
            if lease is not None and lease.tzinfo is None:
                lease = lease.replace(tzinfo=UTC)
            if lease is None or lease < now:
                await self.repository.update_job(
                    job["tenant_id"],
                    job["id"],
                    {
                        "status": "queued",
                        "stage": STAGE_QUEUED,
                        "started_at": None,
                        "lease_expires_at": None,
                    },
                )
                reclaimed += 1
        return reclaimed

    async def process_queued(self, *, limit: int = 10) -> list[dict[str, Any] | None]:
        jobs = await self.repository.list_jobs_by_status("queued", limit=limit)
        results: list[dict[str, Any] | None] = []
        for job in jobs:
            results.append(await self.process_job(job["tenant_id"], job["id"]))
        return results
