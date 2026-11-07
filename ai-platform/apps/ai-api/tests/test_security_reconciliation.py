"""Phase 6: security event propagation, retries and reconciliation."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.event_service import EventConsumer, EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.knowledge_service import KnowledgeService
from ai_api.config.settings import Settings
from ai_api.domain.events import (
    AI_REQUEST_COMPLETED,
    KNOWLEDGE_SOURCE_SECURITY_UPDATED,
    EventEnvelope,
    build_envelope,
)
from ai_api.infrastructure.events.memory_event_store import InMemoryEventStore
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.security.access_control import AccessControl
from ai_api.security.policies import Principal
from ai_api.workers import reconciler
from ai_api.workers.event_consumer import build_security_updated_handler

TENANT = 1


async def _create_source(
    repository: InMemoryAiRepository,
    *,
    tenant_id: int = TENANT,
    code: str = "ops",
    status: str = "ready",
) -> dict[str, Any]:
    source = await repository.create_knowledge_source(
        tenant_id,
        {
            "code": code,
            "name": code,
            "kind": "manual",
            "classification": "internal",
            "acl": {},
        },
    )
    assert source is not None
    if status != "registered":
        for record in repository._sources:
            if record["tenant_id"] == tenant_id and record["id"] == source["id"]:
                record["status"] = status
    return source


async def _bump_source_version(
    repository: InMemoryAiRepository, source: dict[str, Any], *, tenant_id: int = TENANT
) -> dict[str, Any]:
    updated = await repository.update_knowledge_source_acl(
        tenant_id,
        source["id"],
        {"users": ["alice"]},
        expected_version=int(source["version"]),
    )
    assert updated is not None
    return updated


def _security_event(
    source: dict[str, Any],
    *,
    version: int | None = None,
    tenant_id: int = TENANT,
    subject_id: str | None = None,
) -> EventEnvelope:
    version = int(source["version"]) if version is None else version
    return build_envelope(
        KNOWLEDGE_SOURCE_SECURITY_UPDATED,
        tenant_id=tenant_id,
        subject_type="knowledge_source",
        subject_id=str(source["id"]) if subject_id is None else subject_id,
        data={
            "source_id": source["id"],
            "version": version,
            "classification": source.get("classification", "internal"),
            "acl": source.get("acl") or {},
            "change": "acl",
        },
    )


async def _jobs(repository: InMemoryAiRepository, tenant_id: int = TENANT) -> list[dict]:
    jobs, _ = await repository.list_jobs(tenant_id, status=None, limit=100, offset=0)
    return jobs


def _service(
    repository: InMemoryAiRepository,
    *,
    search: Any | None = None,
    settings: Settings | None = None,
) -> KnowledgeService:
    return KnowledgeService(
        repository=repository,
        audit=AuditService(repository),
        settings=settings or Settings(ai_repository="memory"),
        access=AccessControl(),
        governance=GovernanceService(repository),
        search=search,
    )


class _OrphanBackend:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.deleted: list[int] = []

    async def scan_documents(self, tenant_id: int, *, limit: int, after=None):
        return [dict(row) for row in self.rows], None

    async def delete_documents(self, tenant_id: int, document_ids: list[int]) -> None:
        self.deleted.extend(document_ids)


async def test_security_event_queues_refresh_and_is_idempotent() -> None:
    repository = InMemoryAiRepository()
    source = await _create_source(repository)
    store = InMemoryEventStore()
    event = _security_event(source)
    await store.publish([event.to_record(), event.to_record()])

    # The store dedupes a repeated event_id, matching
    # `ON CONFLICT (event_id) DO NOTHING` in the Postgres sink, so only one
    # event is ever published for this consumer group.
    pending = await store.list_undelivered("security", limit=10)
    assert len(pending) == 1
    assert pending[0]["event_id"] == event.event_id

    consumer = EventConsumer(
        store=store,
        consumer_group="security",
        handlers={
            KNOWLEDGE_SOURCE_SECURITY_UPDATED: build_security_updated_handler(repository)
        },
    )
    assert await consumer.process_batch() == 1
    jobs = await _jobs(repository)
    assert len(jobs) == 1
    assert jobs[0]["source_id"] == source["id"]
    assert jobs[0]["status"] == "queued"
    stats = await store.delivery_stats(TENANT, "security")
    assert stats["delivered"] == 1

    # Idempotency is a handler property, not a delivery-count accident: a second
    # equivalent event (fresh event_id, same source version) must not create a
    # second job because the idempotency key is derived from the source version.
    duplicate = _security_event(source)
    await store.publish([duplicate.to_record()])
    assert await consumer.process_batch() == 1
    assert len(await _jobs(repository)) == 1


async def test_stale_event_cannot_restore_old_policy_or_queue_work() -> None:
    repository = InMemoryAiRepository()
    source = await _create_source(repository)
    current = await _bump_source_version(repository, source)
    assert current["version"] == 2

    handler = build_security_updated_handler(repository)
    await handler(_security_event(current, version=1))
    assert await _jobs(repository) == []


async def test_deleted_and_disabled_sources_are_not_resurrected() -> None:
    repository = InMemoryAiRepository()
    deleted = await _create_source(repository, code="deleted", status="ready")
    disabled = await _create_source(repository, code="disabled", status="disabled")
    await repository.create_or_replace_document(
        TENANT,
        {
            "source_id": disabled["id"],
            "external_id": "disabled-doc",
            "title": "disabled-doc",
            "status": "indexed",
        },
    )
    for document in repository._documents:
        if document["source_id"] == disabled["id"]:
            document["search_indexed_at"] = None
    handler = build_security_updated_handler(repository)

    assert await repository.delete_source(TENANT, deleted["id"]) is True
    await handler(_security_event(deleted))
    await handler(_security_event(disabled))

    report = await _service(repository).reconcile_all_tenants(
        limit=10, scan_orphans=False, dry_run=False
    )
    assert report["disabled_sources_skipped"] == 1
    assert await _jobs(repository) == []
    assert await repository.get_knowledge_source(TENANT, deleted["id"]) is None
    still_disabled = await repository.get_knowledge_source(TENANT, disabled["id"])
    assert still_disabled is not None
    assert still_disabled["status"] == "disabled"


async def test_malformed_event_is_dead_lettered_and_no_job_is_created() -> None:
    repository = InMemoryAiRepository()
    store = InMemoryEventStore()
    record = {
        "event_id": "11111111-1111-1111-1111-111111111111",
        "type": KNOWLEDGE_SOURCE_SECURITY_UPDATED,
        "version": "v1",
        "tenant_id": TENANT,
        "subject_type": "knowledge_source",
        "subject_id": "1",
        "payload": {"source_id": 1},
    }
    await store.publish([record])
    consumer = EventConsumer(
        store=store,
        consumer_group="security",
        handlers={KNOWLEDGE_SOURCE_SECURITY_UPDATED: build_security_updated_handler(repository)},
        max_attempts=1,
    )
    assert await consumer.process_batch() == 0
    assert await store.delivery_stats(TENANT, "security") == {
        "pending": 0,
        "delivered": 0,
        "failed": 0,
        "dead": 1,
    }
    assert len(await store.list_dead_letters(TENANT, limit=10)) == 1
    assert await _jobs(repository) == []


async def test_consumer_backoff_defers_retry_until_due() -> None:
    store = InMemoryEventStore()
    event = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "failed"},
    )
    await store.publish([event.to_record()])

    async def fails(_: EventEnvelope) -> None:
        raise RuntimeError("transient")

    consumer = EventConsumer(
        store=store,
        consumer_group="g1",
        handlers={AI_REQUEST_COMPLETED: fails},
        max_attempts=2,
        retry_base_seconds=30,
        retry_max_seconds=30,
        retry_jitter=0,
    )
    await consumer.process_batch()
    assert await store.list_undelivered("g1", limit=10) == []
    assert (await store.delivery_backlog())["delayed"] == 1

    delivery = store._deliveries[(event.event_id, "g1")]
    delivery["next_attempt_at"] = datetime.now(UTC) - timedelta(seconds=1)
    await consumer.process_batch()
    assert await store.delivery_stats(TENANT, "g1") == {
        "pending": 0,
        "delivered": 0,
        "failed": 0,
        "dead": 1,
    }


async def test_reconciliation_dry_run_then_apply_is_bounded_and_idempotent() -> None:
    repository = InMemoryAiRepository()
    one = await _create_source(repository, tenant_id=1, code="one")
    two = await _create_source(repository, tenant_id=2, code="two")
    for tenant_id, source in ((1, one), (2, two)):
        await repository.create_or_replace_document(
            tenant_id,
            {
                "source_id": source["id"],
                "external_id": "doc",
                "title": "doc",
                "status": "indexed",
            },
        )
        for document in repository._documents:
            if document["source_id"] == source["id"]:
                document["search_indexed_at"] = None
    service = _service(repository)

    dry = await service.reconcile_all_tenants(
        limit=10, scan_orphans=False, dry_run=True, max_tenants=1
    )
    assert dry["tenants"] == 1
    assert dry["reports"][0]["tenant_id"] == 1
    assert dry["sources_would_queue"] == 1
    assert dry["sources_queued"] == 0
    assert await _jobs(repository, tenant_id=1) == []
    assert await _jobs(repository, tenant_id=2) == []

    first = await service.reconcile_all_tenants(
        limit=10, scan_orphans=False, dry_run=False, max_tenants=1
    )
    assert first["tenants"] == 1
    assert first["sources_queued"] == 1
    second = await service.reconcile_all_tenants(
        limit=10, scan_orphans=False, dry_run=False, max_tenants=10
    )
    assert second["tenants"] == 2
    assert second["sources_queued"] == 1
    assert len(await _jobs(repository, tenant_id=1)) == 1
    assert len(await _jobs(repository, tenant_id=2)) == 1

    third = await service.reconcile_all_tenants(
        limit=10, scan_orphans=False, dry_run=False, max_tenants=10
    )
    assert third["tenants"] == 2
    assert third["sources_queued"] == 0
    assert len(await _jobs(repository, tenant_id=1)) == 1
    assert len(await _jobs(repository, tenant_id=2)) == 1


async def test_report_only_detects_orphans_without_deleting_them() -> None:
    repository = InMemoryAiRepository()
    source = await _create_source(repository)
    document = await repository.create_or_replace_document(
        TENANT,
        {
            "source_id": source["id"],
            "external_id": "doc",
            "title": "doc",
            "status": "indexed",
        },
    )
    backend = _OrphanBackend(
        [
            {"document_id": document["id"], "source_id": source["id"]},
            {"document_id": 999, "source_id": 999},
        ]
    )
    service = _service(repository, search=backend)

    report = await service.reconcile_all_tenants(
        limit=10, scan_orphans=True, purge_orphans=False, dry_run=True
    )
    assert report["orphans_detected"] == 1
    assert report["orphans_deleted"] == 0
    assert backend.deleted == []

    repaired = await service.reconcile_all_tenants(
        limit=10, scan_orphans=True, purge_orphans=True, dry_run=False
    )
    assert repaired["orphans_detected"] == 1
    assert repaired["orphans_deleted"] == 1
    assert backend.deleted == [999]
    assert await repository.get_document(TENANT, document["id"]) is not None


async def test_event_publication_failure_still_leaves_durable_refresh_work() -> None:
    class _FailingSink:
        async def publish(self, records: list[dict[str, Any]]) -> None:
            raise RuntimeError("event bus unavailable")

    repository = InMemoryAiRepository()
    source = await _create_source(repository)
    document = await repository.create_or_replace_document(
        TENANT,
        {
            "source_id": source["id"],
            "external_id": "doc",
            "title": "doc",
            "status": "indexed",
        },
    )
    service = _service(repository)
    service.events = EventPublisher(sinks=(_FailingSink(),))
    principal = Principal(
        user_id="admin",
        username="admin",
        tenant_id=TENANT,
        permissions=frozenset({"*:*"}),
    )

    updated = await service.update_source_acl(
        principal,
        source["id"],
        acl={"users": ["alice"]},
        expected_version=1,
    )
    assert updated["acl"] == {"users": ["alice"]}
    stored = await repository.get_document(TENANT, document["id"])
    assert stored is not None
    assert stored["search_indexed_at"] is None

    jobs = await _jobs(repository)
    assert len(jobs) == 1
    assert jobs[0]["type"] == "index"
    assert jobs[0]["source_id"] == source["id"]
    assert stored["classification"] == "internal"


def test_retry_settings_reject_invalid_windows() -> None:
    with pytest.raises(ValueError):
        Settings(ai_job_retry_base_seconds=10, ai_job_retry_max_seconds=1)
    with pytest.raises(ValueError):
        Settings(ai_event_retry_base_seconds=10, ai_event_retry_max_seconds=1)


async def test_replay_clears_dead_letter_and_resets_delivery() -> None:
    store = InMemoryEventStore()
    event = build_envelope(
        AI_REQUEST_COMPLETED,
        tenant_id=TENANT,
        data={"operation": "chat", "status": "succeeded"},
    )
    await store.publish([event.to_record()])
    assert (
        await store.record_failure(
            event.event_id, "g1", "boom", max_attempts=1
        )
        == "dead"
    )
    assert len(await store.list_dead_letters(TENANT, limit=10)) == 1
    assert await store.replay(TENANT, event.event_id, "g1") is True
    assert await store.list_dead_letters(TENANT, limit=10) == []
    assert (await store.delivery_stats(TENANT, "g1"))["pending"] == 1


async def test_reconciler_disabled_is_a_safe_noop(monkeypatch) -> None:
    async def fail(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("disabled reconciler must not build services")

    monkeypatch.setattr(reconciler, "_build_service", fail)
    await reconciler.run(
        once=True,
        settings=Settings(ai_reconcile_enabled=False, ai_repository="memory"),
    )


async def test_concurrent_reconcilers_do_not_duplicate_refresh_jobs() -> None:
    repository = InMemoryAiRepository()
    source = await _create_source(repository)
    await repository.create_or_replace_document(
        TENANT,
        {
            "source_id": source["id"],
            "external_id": "doc",
            "title": "doc",
            "status": "indexed",
        },
    )
    for document in repository._documents:
        document["search_indexed_at"] = None
    service = _service(repository)

    first, second = await asyncio.gather(
        service.reconcile_all_tenants(limit=10, scan_orphans=False),
        service.reconcile_all_tenants(limit=10, scan_orphans=False),
    )
    assert first["sources_queued"] + second["sources_queued"] == 1
    assert len(await _jobs(repository)) == 1
