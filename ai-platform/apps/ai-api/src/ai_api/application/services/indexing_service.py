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
import random
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.config.settings import Settings
from ai_api.domain.errors import classify_error
from ai_api.infrastructure.db.tenant_context import system_scope, tenant_scope
from ai_api.schemas.knowledge import (
    KnowledgeIngestExecution,
    StoredKnowledgeDocumentIn,
)
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
        # Claim and lease in one atomic step: the read-then-write this replaces
        # let two workers observe the same ``queued`` row and both process it.
        job = await self.repository.claim_job(
            tenant_id,
            job_id,
            lease_seconds=self.settings.ai_job_lease_seconds,
            due_only=False,
        )
        if job is None:
            # Not claimable: the job may be absent, already finished, or owned by
            # another worker. Callers treat this as "nothing to do" and get the
            # current state rather than a spurious error.
            return await self.repository.get_job(tenant_id, job_id)

        attempt = int(job.get("attempts", 0))

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
                "next_attempt_at": None,
            },
            expected_attempts=attempt,
        )
        if updated is None:
            # Another worker reclaimed this job while this attempt ran (its
            # lease expired). Discard the late result: the new owner owns the
            # outcome, and emitting a completion event here would report work
            # that was not committed.
            logger.warning(
                "index.job_claim_lost",
                job_id=job_id,
                attempt=attempt,
            )
            return await self.repository.get_job(tenant_id, job_id)
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
            payload = KnowledgeIngestExecution(
                source_id=job["source_id"],
                documents=[
                    StoredKnowledgeDocumentIn(**item) for item in documents_payload
                ],
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
            fields["next_attempt_at"] = datetime.now(UTC) + timedelta(
                seconds=self._retry_delay(attempt)
            )
        else:
            fields["next_attempt_at"] = None
            fields["status"] = "failed"
            fields["finished_at"] = datetime.now(UTC)
        # Fence on the claim generation and write before emitting: a worker
        # whose lease expired and was reclaimed must not fail (or requeue) the
        # new owner's attempt, and the failed event must describe a committed
        # outcome rather than a discarded one.
        updated = await self.repository.update_job(
            tenant_id, job["id"], fields, expected_attempts=attempt
        )
        if updated is None:
            logger.warning(
                "index.job_claim_lost",
                job_id=job["id"],
                attempt=attempt,
                error_class=error_class,
            )
            return await self.repository.get_job(tenant_id, job["id"])
        if not retryable:
            if self.events is not None:
                await self.events.knowledge_index_failed(
                    tenant_id=tenant_id,
                    source_id=job.get("source_id"),
                    job_id=job["id"],
                    error=str(exc),
                )
            record_index_job(status="failed")
        return updated

    async def retry_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            return None
        if job["status"] not in ("failed", "queued"):
            return job
        # Fence on the attempts read above: a worker may claim this queued job
        # between the read and the requeue. Requeueing it then would clear the
        # live lease and let a second worker process it concurrently.
        updated = await self.repository.update_job(
            tenant_id,
            job_id,
            {
                "status": "queued",
                "stage": STAGE_QUEUED,
                "error": None,
                "error_class": None,
                "finished_at": None,
                "lease_expires_at": None,
                "next_attempt_at": None,
            },
            expected_attempts=int(job.get("attempts", 0)),
        )
        if updated is None:
            # Lost the race to a claimant: report the job's current state rather
            # than the requeue we intended.
            return await self.repository.get_job(tenant_id, job_id)
        return updated

    async def reclaim_stale_jobs(self, *, limit: int = 50) -> int:
        """Reset running jobs whose lease has expired back to queued."""

        with system_scope():
            jobs = await self.repository.list_jobs_by_status(
                "running", limit=limit, due_only=False
            )
        now = datetime.now(UTC)
        reclaimed = 0
        for job in jobs:
            lease = job.get("lease_expires_at")
            if lease is not None and lease.tzinfo is None:
                lease = lease.replace(tzinfo=UTC)
            if lease is None or lease < now:
                with tenant_scope(job["tenant_id"]):
                    # Fence on the generation read during discovery: the job may
                    # be reclaimed by a worker between the listing and this
                    # write, and requeueing it then would interrupt that run.
                    restored = await self.repository.update_job(
                        job["tenant_id"],
                        job["id"],
                        {
                            "status": "queued",
                            "stage": STAGE_QUEUED,
                            "started_at": None,
                            "lease_expires_at": None,
                            "next_attempt_at": None,
                        },
                        expected_attempts=int(job.get("attempts", 0)),
                    )
                if restored is not None:
                    reclaimed += 1
        return reclaimed

    def _retry_delay(self, attempt: int) -> float:
        delay = min(
            self.settings.ai_job_retry_max_seconds,
            self.settings.ai_job_retry_base_seconds * (2 ** max(0, attempt - 1)),
        )
        if self.settings.ai_job_retry_jitter:
            delay *= 1 + random.uniform(
                -self.settings.ai_job_retry_jitter, self.settings.ai_job_retry_jitter
            )
        return max(0.0, delay)

    async def metrics(self) -> dict[str, Any]:
        stale_before = datetime.now(UTC) - timedelta(
            seconds=self.settings.ai_security_refresh_stale_seconds
        )
        with system_scope():
            return await self.repository.job_metrics(stale_before=stale_before)

    async def process_queued(self, *, limit: int = 10) -> list[dict[str, Any] | None]:
        with system_scope():
            jobs = await self.repository.list_jobs_by_status("queued", limit=limit)
        results: list[dict[str, Any] | None] = []
        for job in jobs:
            with tenant_scope(job["tenant_id"]):
                results.append(await self.process_job(job["tenant_id"], job["id"]))
        return results
