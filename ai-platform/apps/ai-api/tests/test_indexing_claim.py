"""Regression tests for atomic index-job claiming (Stage 3 hardening)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from ai_api.application.services.indexing_service import IndexingService
from ai_api.config.settings import get_settings
from ai_api.infrastructure.repositories.memory_ai_repository import InMemoryAiRepository

TENANT = 7


class _CountingIngestion:
    """Ingestion stub that records each run so double-processing is visible."""

    def __init__(self) -> None:
        self.runs: list[int | None] = []
        self.gate: asyncio.Event | None = None

    async def reindex_source(self, principal: Any, source_id: int | None) -> dict[str, Any]:
        self.runs.append(source_id)
        if self.gate is not None:
            await self.gate.wait()
        return {"documents": 1, "chunks": 1}

    async def ingest(self, principal: Any, payload: Any) -> dict[str, Any]:
        self.runs.append(getattr(payload, "source_id", None))
        if self.gate is not None:
            await self.gate.wait()
        return {"documents": 1, "chunks": 1}


def _service(ingestion: _CountingIngestion) -> IndexingService:
    return IndexingService(
        repository=InMemoryAiRepository(),
        ingestion=ingestion,  # type: ignore[arg-type]
        settings=get_settings(),
    )


async def _queued_job(service: IndexingService, **fields: Any) -> dict[str, Any]:
    job = await service.repository.create_job(TENANT, {"type": "index", "source_id": 1, **fields})
    assert job is not None
    return job


def test_two_workers_cannot_process_the_same_job() -> None:
    async def scenario() -> None:
        ingestion = _CountingIngestion()
        service = _service(ingestion)
        job = await _queued_job(service)

        # Two claims race for one queued row. Exactly one wins; the loser must
        # not be handed a runnable job.
        first, second = await asyncio.gather(
            service.repository.claim_job(TENANT, job["id"], lease_seconds=300.0, due_only=False),
            service.repository.claim_job(TENANT, job["id"], lease_seconds=300.0, due_only=False),
        )
        winners = [row for row in (first, second) if row is not None]
        assert len(winners) == 1
        assert winners[0]["status"] == "running"
        assert winners[0]["attempts"] == 1

    asyncio.run(scenario())


def test_process_job_skips_a_job_already_leased_by_another_worker() -> None:
    async def scenario() -> None:
        ingestion = _CountingIngestion()
        service = _service(ingestion)
        job = await _queued_job(service)

        # Simulate a peer worker holding a live lease.
        await service.repository.update_job(
            TENANT,
            job["id"],
            {
                "status": "running",
                "attempts": 1,
                "lease_expires_at": datetime.now(UTC) + timedelta(seconds=300),
            },
        )

        result = await service.process_job(TENANT, job["id"])

        assert ingestion.runs == []
        assert result is not None
        assert result["status"] == "running"

    asyncio.run(scenario())


def test_expired_lease_is_reclaimable() -> None:
    async def scenario() -> None:
        ingestion = _CountingIngestion()
        service = _service(ingestion)
        job = await _queued_job(service)

        await service.repository.update_job(
            TENANT,
            job["id"],
            {
                "status": "running",
                "attempts": 1,
                "lease_expires_at": datetime.now(UTC) - timedelta(seconds=1),
            },
        )

        result = await service.process_job(TENANT, job["id"])

        assert ingestion.runs == [1]
        assert result is not None
        assert result["status"] == "succeeded"
        assert result["attempts"] == 2

    asyncio.run(scenario())


def test_not_due_job_is_left_for_later_but_claimable_when_forced() -> None:
    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service, next_attempt_at=datetime.now(UTC) + timedelta(seconds=60))

        scheduled = await service.repository.claim_job(TENANT, job["id"], lease_seconds=300.0)
        assert scheduled is None

        forced = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert forced is not None
        assert forced["attempts"] == 1

    asyncio.run(scenario())


def test_finished_job_is_never_reclaimed() -> None:
    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        await service.repository.update_job(TENANT, job["id"], {"status": "succeeded"})

        assert (
            await service.repository.claim_job(
                TENANT, job["id"], lease_seconds=300.0, due_only=False
            )
            is None
        )

    asyncio.run(scenario())


def test_claim_is_scoped_to_the_requesting_tenant() -> None:
    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)

        assert (
            await service.repository.claim_job(
                TENANT + 1, job["id"], lease_seconds=300.0, due_only=False
            )
            is None
        )
        current = await service.repository.get_job(TENANT, job["id"])
        assert current is not None
        assert current["status"] == "queued"

    asyncio.run(scenario())


@pytest.mark.parametrize("lease_seconds", [0.0, 1.0, 300.0])
def test_claim_sets_a_lease_in_the_future(lease_seconds: float) -> None:
    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        claimed = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=lease_seconds, due_only=False
        )
        assert claimed is not None
        lease = claimed["lease_expires_at"]
        assert lease is not None
        if lease.tzinfo is None:
            lease = lease.replace(tzinfo=UTC)
        assert lease >= datetime.now(UTC) + timedelta(seconds=lease_seconds - 1)

    asyncio.run(scenario())


# --- Fencing: a lost-lease worker must not overwrite the new owner --------


async def _expire_lease(repository, job_id: int) -> None:
    await repository.update_job(
        TENANT,
        job_id,
        {
            "status": "running",
            "lease_expires_at": datetime.now(UTC) - timedelta(seconds=1),
        },
    )


def test_stale_worker_cannot_overwrite_a_reclaimed_job() -> None:
    """A worker whose lease expired must not clobber the reclaiming worker.

    Before the fence, ``update_job`` matched on ``(tenant_id, id)`` alone, so a
    worker that stalled past its lease could still write ``succeeded`` after
    another worker had reclaimed and was mid-run.
    """

    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        first = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert first is not None

        await _expire_lease(service.repository, job["id"])
        second = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert second is not None
        assert second["attempts"] == first["attempts"] + 1

        stale = await service.repository.update_job(
            TENANT,
            job["id"],
            {"status": "succeeded", "result": {"stale": True}},
            expected_attempts=first["attempts"],
        )
        assert stale is None

        current = await service.repository.get_job(TENANT, job["id"])
        assert current is not None
        assert current["status"] == "running"
        assert current["attempts"] == second["attempts"]
        assert current.get("result") is None

    asyncio.run(scenario())


def test_current_owner_can_still_write_after_expiry_race() -> None:
    """The fence accepts the legitimate owner, so it is not a blanket block."""

    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        claimed = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert claimed is not None

        written = await service.repository.update_job(
            TENANT,
            job["id"],
            {"status": "succeeded", "progress": 100.0},
            expected_attempts=claimed["attempts"],
        )
        assert written is not None
        assert written["status"] == "succeeded"

    asyncio.run(scenario())


def test_fenced_failure_write_is_discarded_when_claim_is_lost() -> None:
    """A stale failure must not requeue or fail the new owner's attempt."""

    async def scenario() -> None:
        ingestion = _CountingIngestion()
        service = _service(ingestion)
        job = await _queued_job(service)

        # Claim as worker A, then let the lease expire and be reclaimed by B.
        first = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert first is not None
        await _expire_lease(service.repository, job["id"])
        second = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert second is not None

        # A late failure from A is fenced out.
        rejected = await service.repository.update_job(
            TENANT,
            job["id"],
            {"status": "failed", "error": {"message": "late"}},
            expected_attempts=first["attempts"],
        )
        assert rejected is None

        current = await service.repository.get_job(TENANT, job["id"])
        assert current is not None
        assert current["status"] == "running"
        assert current.get("error") is None

    asyncio.run(scenario())


def test_reclaim_does_not_interrupt_a_job_reclaimed_concurrently() -> None:
    """``reclaim_stale_jobs`` is fenced on the generation it discovered.

    If another worker reclaims the job between discovery and the requeue write,
    the requeue must not apply.
    """

    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        first = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert first is not None
        await _expire_lease(service.repository, job["id"])

        # Simulate the race: a peer reclaims after discovery reads attempts=1.
        stale_generation = int(
            (await service.repository.get_job(TENANT, job["id"]))["attempts"]
        )
        second = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert second is not None

        requeued = await service.repository.update_job(
            TENANT,
            job["id"],
            {"status": "queued", "lease_expires_at": None},
            expected_attempts=stale_generation,
        )
        assert requeued is None

        current = await service.repository.get_job(TENANT, job["id"])
        assert current is not None
        assert current["status"] == "running"
        assert current["attempts"] == second["attempts"]

    asyncio.run(scenario())


def test_update_job_clears_explicit_none_and_preserves_omitted_fields() -> None:
    """Explicit ``None`` must clear a column; omitted keys must be untouched.

    Both repositories share this contract. Postgres covered the update with
    ``COALESCE``, which silently kept the stale value whenever a success or
    retry write tried to clear ``error``/``lease_expires_at``/``started_at``.
    """

    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        claimed = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert claimed is not None
        attempt = int(claimed["attempts"])

        failed = await service.repository.update_job(
            TENANT,
            job["id"],
            {
                "status": "queued",
                "error": {"message": "boom"},
                "error_class": "timeout",
                "started_at": None,
                "lease_expires_at": None,
                "next_attempt_at": None,
            },
            expected_attempts=attempt,
        )
        assert failed is not None
        assert failed["error"] == {"message": "boom"}
        assert failed["error_class"] == "timeout"

        succeeded = await service.repository.update_job(
            TENANT,
            job["id"],
            {
                "status": "succeeded",
                "error": None,
                "error_class": None,
                "lease_expires_at": None,
                "next_attempt_at": None,
            },
            expected_attempts=attempt,
        )
        assert succeeded is not None
        assert succeeded["error"] is None
        assert succeeded["error_class"] is None
        assert succeeded["lease_expires_at"] is None
        assert succeeded["next_attempt_at"] is None
        # Omitted keys survive the write unchanged.
        assert succeeded["attempts"] == attempt
        assert succeeded["source_id"] == job["source_id"]

    asyncio.run(scenario())


def test_retry_does_not_requeue_a_job_a_worker_just_claimed() -> None:
    """``retry_job`` is fenced on the attempts it read.

    A queued job can be claimed between the read and the requeue. Clearing the
    live lease then would let a second worker run the same job concurrently.
    """

    async def scenario() -> None:
        service = _service(_CountingIngestion())
        job = await _queued_job(service)
        observed = await service.repository.get_job(TENANT, job["id"])
        assert observed is not None

        # A worker claims the job after retry_job read it.
        claimed = await service.repository.claim_job(
            TENANT, job["id"], lease_seconds=300.0, due_only=False
        )
        assert claimed is not None

        requeued = await service.repository.update_job(
            TENANT,
            job["id"],
            {"status": "queued", "lease_expires_at": None},
            expected_attempts=int(observed["attempts"]),
        )
        assert requeued is None

        current = await service.repository.get_job(TENANT, job["id"])
        assert current is not None
        assert current["status"] == "running"
        assert current["lease_expires_at"] is not None

    asyncio.run(scenario())
