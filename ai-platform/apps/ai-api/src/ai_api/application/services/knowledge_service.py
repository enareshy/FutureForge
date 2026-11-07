from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository, ObjectStorage, SearchBackend
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from ai_api.infrastructure.db.tenant_context import system_scope, tenant_scope
from ai_api.infrastructure.ingestion.validation import validate_upload
from ai_api.infrastructure.storage import (
    build_object_key,
    content_checksum,
    sanitize_filename,
    validate_document_object_key,
)
from ai_api.security.access_control import (
    CLASSIFICATION_ORDER,
    AccessControl,
    classification_rank,
    validate_acl,
    within_ceiling,
)
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger, request_id_var
from ai_api.telemetry.tracing import span

__all__ = ["KnowledgeService", "require_tenant"]

logger = get_logger("knowledge")

_DOCUMENT_SCAN_PAGE_SIZE = 200
_DOCUMENT_LIST_FIELDS = (
    "id",
    "source_id",
    "external_id",
    "title",
    "mime_type",
    "classification",
    "status",
    "size_bytes",
    "checksum",
    "indexed_at",
    "search_indexed_at",
    "error_class",
    "created_at",
    "updated_at",
    "version",
    "metadata",
)


@dataclass(slots=True)
class KnowledgeService:
    repository: AiRepository
    audit: AuditService
    settings: Settings
    access: AccessControl
    governance: GovernanceService
    events: EventPublisher | None = None
    storage: ObjectStorage | None = None
    search: SearchBackend | None = None

    async def list_sources(
        self, principal: Principal, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_knowledge_sources(
            tenant_id, limit=limit, offset=offset
        )

    async def create_source(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        created = await self.repository.create_knowledge_source(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "kind": payload.kind,
                "uri": payload.uri,
                "classification": payload.classification,
                "acl": payload.acl,
                "config": payload.config,
            },
        )
        if created is None:
            raise ConflictError(
                "a knowledge source with this code already exists",
                details={"code": payload.code},
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.create",
            resource_type="knowledge_source",
            resource_id=str(created["id"]),
            request_id=request_id_var.get(),
            detail={"code": created["code"]},
        )
        if self.events is not None:
            await self.events.knowledge_source_registered(
                tenant_id=tenant_id, source=created, actor_id=principal.actor_id
            )
        return created

    async def get_source(
        self, principal: Principal, source_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found", details={"source_id": source_id}
            )
        return source

    async def update_source_acl(
        self,
        principal: Principal,
        source_id: int,
        *,
        acl: dict[str, Any],
        expected_version: int,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self._source_or_404(tenant_id, source_id)
        normalized = validate_acl(acl)
        if normalized == (source.get("acl") or {}):
            return source
        if source.get("version", 1) != expected_version:
            raise ConflictError(
                "knowledge source changed since it was read; retry with the current version",
                details={"source_id": source_id, "version": source.get("version", 1)},
            )
        await self._authorize_acl_update(
            principal, source.get("acl") or {}, normalized, source_id=source_id
        )
        updated = await self.repository.update_knowledge_source_acl(
            tenant_id,
            source_id,
            normalized,
            expected_version=expected_version,
            refresh_job={
                "type": "index",
                "source_id": source_id,
                "idempotency_key": f"source-security-{source_id}-v{expected_version + 1}",
                "payload": {"force": False, "security_update": "acl"},
            },
        )
        if updated is None:
            await self._raise_update_conflict(tenant_id, source_id)
        updated = dict(updated)
        refresh_job = updated.pop("_refresh_job", None)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.acl_update",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
            detail={
                "source_id": source_id,
                "version": updated["version"],
                "acl": normalized,
                "previous_acl": source.get("acl") or {},
            },
        )
        await self._propagate_source_security(
            tenant_id, updated, principal, change="acl", refresh_job=refresh_job
        )
        return updated

    async def update_source_classification(
        self,
        principal: Principal,
        source_id: int,
        *,
        classification: str,
        expected_version: int,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self._source_or_404(tenant_id, source_id)
        if classification not in CLASSIFICATION_ORDER:
            raise ValidationError(
                "unsupported classification",
                details={"classification": classification},
            )
        current = str(source.get("classification") or "internal")
        if classification == current:
            return source
        if source.get("version", 1) != expected_version:
            raise ConflictError(
                "knowledge source changed since it was read; retry with the current version",
                details={"source_id": source_id, "version": source.get("version", 1)},
            )
        if (
            classification_rank(classification) < classification_rank(current)
            and not self.access.is_superuser(principal)
        ):
            await self.audit.record(
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                action="ai.knowledge_source.classification_update",
                resource_type="knowledge_source",
                resource_id=str(source_id),
                outcome="denied",
                request_id=request_id_var.get(),
                detail={
                    "source_id": source_id,
                    "from": current,
                    "to": classification,
                    "reason": "classification_downgrade_requires_superuser",
                },
            )
            raise AuthorizationError(
                "downgrading source classification requires platform administrator approval",
                details={"source_id": source_id, "classification": current},
            )
        updated = await self.repository.update_knowledge_source_classification(
            tenant_id,
            source_id,
            classification,
            expected_version=expected_version,
            refresh_job={
                "type": "index",
                "source_id": source_id,
                "idempotency_key": f"source-security-{source_id}-v{expected_version + 1}",
                "payload": {"force": False, "security_update": "classification"},
            },
        )
        if updated is None:
            await self._raise_update_conflict(tenant_id, source_id)
        updated = dict(updated)
        refresh_job = updated.pop("_refresh_job", None)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.classification_update",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
            detail={
                "source_id": source_id,
                "version": updated["version"],
                "from": current,
                "to": classification,
            },
        )
        await self._propagate_source_security(
            tenant_id,
            updated,
            principal,
            change="classification",
            refresh_job=refresh_job,
        )
        return updated

    async def _source_or_404(
        self, tenant_id: int, source_id: int
    ) -> dict[str, Any]:
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found", details={"source_id": source_id}
            )
        return source

    async def _raise_update_conflict(self, tenant_id: int, source_id: int) -> None:
        current = await self.repository.get_knowledge_source(tenant_id, source_id)
        if current is None:
            raise NotFoundError(
                "knowledge source not found", details={"source_id": source_id}
            )
        raise ConflictError(
            "knowledge source changed since it was read; retry with the current version",
            details={"source_id": source_id, "version": current.get("version", 1)},
        )

    async def _authorize_acl_update(
        self,
        principal: Principal,
        current_acl: dict[str, Any],
        new_acl: dict[str, Any],
        *,
        source_id: int,
    ) -> None:
        """Reject grants that exceed the caller's own authority.

        Non-superusers may tighten ACLs, remove grants, and grant only roles or
        permissions they already hold. User grants are limited to the caller's
        own identity (granting other users requires a platform administrator),
        and a caller who cannot currently see the source cannot use an ACL
        update to grant themselves access.
        """

        if self.access.is_superuser(principal):
            return
        current_deny = current_acl.get("deny_all") is True
        new_deny = new_acl.get("deny_all") is True
        if current_deny:
            if not new_deny:
                await self._reject_acl_update(
                    principal,
                    source_id,
                    "only platform administrators can remove deny_all",
                )
            return
        if new_deny:
            # Adding deny_all can only reduce access.
            return

        current_roles = set(current_acl.get("roles") or [])
        current_permissions = set(current_acl.get("permissions") or [])
        current_users = set(current_acl.get("users") or [])
        roles = set(new_acl.get("roles") or [])
        permissions = set(new_acl.get("permissions") or [])
        users = set(new_acl.get("users") or [])
        restricted_before = bool(current_roles or current_permissions or current_users)
        restricted_after = bool(roles or permissions or users)

        if not restricted_after:
            if restricted_before:
                await self._reject_acl_update(
                    principal,
                    source_id,
                    "cannot broaden a restricted source to tenant-wide access",
                )
            return

        if restricted_before:
            if (
                not roles <= current_roles
                or not permissions <= current_permissions
                or not users <= current_users
            ):
                await self._reject_acl_update(
                    principal,
                    source_id,
                    "non-administrators can only remove grants from an existing ACL",
                )
            # Every grant already existed; this update only tightens access.
            return

        if not roles <= set(principal.roles):
            await self._reject_acl_update(
                principal,
                source_id,
                "cannot grant roles the caller does not hold",
            )
        for permission in permissions:
            if not self.access.policy.can(principal, permission):
                await self._reject_acl_update(
                    principal,
                    source_id,
                    "cannot grant permissions the caller does not hold",
                )
        self_ids = {principal.username}
        if principal.actor_id is not None:
            self_ids.add(str(principal.actor_id))
        if not users <= self_ids:
            await self._reject_acl_update(
                principal,
                source_id,
                "granting other users requires a platform administrator",
            )

    async def _reject_acl_update(
        self, principal: Principal, source_id: int, reason: str
    ) -> None:
        await self.audit.record(
            tenant_id=require_tenant(principal),
            actor_id=principal.actor_id,
            action="ai.knowledge_source.acl_update",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            outcome="denied",
            request_id=request_id_var.get(),
            detail={"source_id": source_id, "reason": reason},
        )
        raise AuthorizationError(reason, details={"source_id": source_id})

    async def _propagate_source_security(
        self,
        tenant_id: int,
        source: dict[str, Any],
        principal: Principal,
        *,
        change: str,
        refresh_job: dict[str, Any] | None = None,
    ) -> None:
        """Queue retryable index refresh; never a prerequisite for enforcement.

        Authorization already uses the committed authoritative rows. The job
        refreshes non-authoritative index metadata, and stale documents are also
        marked for reconciliation, so a queue failure is observable and
        recoverable rather than silently claiming propagation.
        """

        version = int(source.get("version", 1))
        job = refresh_job
        if job is None:
            try:
                job = await self.repository.create_job(
                    tenant_id,
                    {
                        "type": "index",
                        "source_id": source["id"],
                        "idempotency_key": f"source-security-{source['id']}-v{version}",
                        "payload": {"force": False, "security_update": change},
                    },
                )
            except Exception as exc:  # noqa: BLE001 - authoritative update already committed
                logger.warning(
                    "knowledge.source_security_reindex_enqueue_failed",
                    tenant_id=tenant_id,
                    source_id=source["id"],
                    version=version,
                    error=str(exc),
                )
                await self.audit.record(
                    tenant_id=tenant_id,
                    actor_id=principal.actor_id,
                    action="ai.knowledge_source.security_refresh_enqueue",
                    resource_type="knowledge_source",
                    resource_id=str(source["id"]),
                    outcome="degraded",
                    request_id=request_id_var.get(),
                    detail={
                        "source_id": source["id"],
                        "version": version,
                        "change": change,
                        "error": str(exc)[:500],
                    },
                )
        if self.events is None:
            return
        try:
            if job is not None:
                await self.events.knowledge_index_requested(
                    tenant_id=tenant_id,
                    source_id=source["id"],
                    job_id=job["id"],
                    documents=0,
                    actor_id=principal.actor_id,
                )
            await self.events.knowledge_source_security_updated(
                tenant_id=tenant_id,
                source=source,
                actor_id=principal.actor_id,
                change=change,
            )
        except Exception as exc:  # noqa: BLE001 - invalidation signal, not authority
            logger.warning(
                "knowledge.source_security_event_publish_failed",
                tenant_id=tenant_id,
                source_id=source["id"],
                version=version,
                error=str(exc),
            )
            await self.audit.record(
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                action="ai.knowledge_source.security_event_publish",
                resource_type="knowledge_source",
                resource_id=str(source["id"]),
                outcome="degraded",
                request_id=request_id_var.get(),
                detail={
                    "source_id": source["id"],
                    "version": version,
                    "change": change,
                    "error": str(exc)[:500],
                },
            )

    async def request_index(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, payload.source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found",
                details={"source_id": payload.source_id},
            )
        job = await self.repository.create_job(
            tenant_id,
            {
                "type": "index",
                "source_id": payload.source_id,
                "idempotency_key": payload.idempotency_key,
                "payload": {"force": payload.force},
            },
        )
        assert job is not None
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.index_requested",
            resource_type="job",
            resource_id=str(job["id"]),
            request_id=request_id_var.get(),
            detail={"source_id": payload.source_id},
        )
        if self.events is not None:
            await self.events.knowledge_index_requested(
                tenant_id=tenant_id,
                source_id=payload.source_id,
                job_id=job["id"],
                documents=0,
                actor_id=principal.actor_id,
            )
        return job

    async def reconcile_index(
        self,
        principal: Principal,
        *,
        limit: int = 100,
        scan_orphans: bool = False,
        purge_orphans: bool = False,
    ) -> dict[str, Any]:
        """Repair index divergence within a bounded, tenant-scoped window.

        Sources with stale/missing/failed documents get normal reindex jobs. When
        ``scan_orphans`` is set, indexed document identities are compared with the
        authoritative database and orphan entries (deleted documents/sources) are
        reported; ``purge_orphans`` must be explicit and deletes only those
        orphans, tenant-scoped and idempotently. Disabled sources are reported but
        not purged automatically because they are already excluded at retrieval.
        """
        with span("ai.index.reconcile", {"ai.operation": "index.reconcile"}):
            return await self._reconcile_index_impl(
                principal,
                limit=limit,
                scan_orphans=scan_orphans or purge_orphans,
                purge_orphans=purge_orphans,
            )

    async def _reconcile_index_impl(
        self,
        principal: Principal,
        *,
        limit: int = 100,
        scan_orphans: bool = False,
        purge_orphans: bool = False,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        report = await self._reconcile_tenant(
            tenant_id,
            limit=limit,
            scan_orphans=scan_orphans,
            purge_orphans=purge_orphans,
            apply=True,
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge.reconcile",
            resource_type="knowledge_index",
            resource_id=None,
            request_id=request_id_var.get(),
            detail={**report},
        )
        return report

    async def reconcile_all_tenants(
        self,
        *,
        limit: int = 100,
        scan_orphans: bool = True,
        purge_orphans: bool = False,
        dry_run: bool = False,
        max_tenants: int = 50,
    ) -> dict[str, Any]:
        """Run bounded reconciliation for every tenant, one page at a time.

        The automated worker uses this entry point. It never changes ACLs or
        classifications: reindex jobs read the authoritative source rows, and
        orphan purging only removes index entries whose database identity is
        gone. ``dry_run`` reports what would change without enqueueing jobs or
        deleting anything.
        """
        after = 0
        tenants = 0
        totals: dict[str, Any] = {
            "sources_candidates": 0,
            "sources_queued": 0,
            "sources_would_queue": 0,
            "disabled_sources_skipped": 0,
            "orphans_detected": 0,
            "orphans_deleted": 0,
        }
        reports: list[dict[str, Any]] = []
        while tenants < max_tenants:
            with system_scope():
                page = await self.repository.list_tenant_ids(
                    limit=min(100, max_tenants - tenants), after_tenant_id=after
                )
            if not page:
                break
            for tenant_id in page:
                with tenant_scope(tenant_id):
                    report = await self._reconcile_tenant(
                        tenant_id,
                        limit=limit,
                        scan_orphans=scan_orphans,
                        purge_orphans=purge_orphans,
                        apply=not dry_run,
                    )
                    for key in totals:
                        totals[key] += int(report.get(key, 0) or 0)
                    reports.append({"tenant_id": tenant_id, **report})
                    if (
                        report.get("sources_queued")
                        or report.get("orphans_detected")
                        or report.get("orphans_deleted")
                        or dry_run
                    ):
                        await self.audit.record(
                            tenant_id=tenant_id,
                            actor_id=None,
                            action="ai.knowledge.reconcile",
                            resource_type="knowledge_index",
                            resource_id=None,
                            outcome="dry_run" if dry_run else "success",
                            detail={"automated": True, "dry_run": dry_run, **report},
                        )
                tenants += 1
            after = page[-1]
        return {
            "tenants": tenants,
            "dry_run": dry_run,
            "reports": reports,
            **totals,
        }

    async def _reconcile_tenant(
        self,
        tenant_id: int,
        *,
        limit: int,
        scan_orphans: bool,
        purge_orphans: bool,
        apply: bool,
    ) -> dict[str, Any]:
        sources = await self.repository.sources_needing_reindex(tenant_id, limit=limit)
        active: set[Any] = set()
        for status in ("queued", "running"):
            jobs, _ = await self.repository.list_jobs(
                tenant_id, status=status, limit=500, offset=0
            )
            active.update(
                job["source_id"]
                for job in jobs
                if job.get("type") == "index" and job.get("source_id") is not None
            )
        job_ids: list[int] = []
        would_queue = 0
        disabled_skipped = 0
        for source in sources:
            if source.get("source_status") == "disabled":
                disabled_skipped += 1
                continue
            if source["source_id"] in active:
                continue
            if not apply:
                would_queue += 1
                continue
            # Time-bucketed key makes concurrent reconcilers and repeated
            # passes idempotent without blocking a later retry after the bucket.
            bucket = int(datetime.now(UTC).timestamp()) // 900
            job = await self.repository.create_job(
                tenant_id,
                {
                    "type": "index",
                    "source_id": source["source_id"],
                    "idempotency_key": f"reconcile-{source['source_id']}-{bucket}",
                    "payload": {"force": False, "reconcile": True},
                },
            )
            assert job is not None
            job_ids.append(job["id"])

        report: dict[str, Any] = {
            "sources_candidates": len(sources),
            "sources_queued": len(job_ids),
            "sources_would_queue": would_queue,
            "disabled_sources_skipped": disabled_skipped,
            "jobs": job_ids,
            "orphans_detected": 0,
            "orphan_document_ids": [],
            "missing_source_ids": [],
            "disabled_source_ids": [],
            "orphans_deleted": 0,
        }
        if scan_orphans and self.search is not None:
            report.update(
                await self._scan_orphans(
                    tenant_id, limit=limit, purge=purge_orphans and apply
                )
            )
        return report

    async def _scan_orphans(
        self, tenant_id: int, *, limit: int, purge: bool
    ) -> dict[str, Any]:
        assert self.search is not None
        rows, _cursor = await self.search.scan_documents(tenant_id, limit=limit)
        document_ids = sorted({int(row["document_id"]) for row in rows})
        source_ids = sorted(
            {
                int(row["source_id"])
                for row in rows
                if row.get("source_id") is not None
            }
        )
        existing_docs = await self.repository.existing_document_ids(
            tenant_id, document_ids
        )
        states = await self.repository.source_states(tenant_id, source_ids)
        orphan_document_ids = [
            document_id
            for document_id in document_ids
            if document_id not in existing_docs
        ]
        missing_source_ids = [
            source_id for source_id in source_ids if source_id not in states
        ]
        disabled_source_ids = sorted(
            source_id for source_id, status in states.items() if status == "disabled"
        )
        deleted = 0
        if purge and orphan_document_ids:
            await self.search.delete_documents(tenant_id, orphan_document_ids)
            deleted = len(orphan_document_ids)
        return {
            "orphans_detected": len(orphan_document_ids),
            "orphan_document_ids": orphan_document_ids,
            "missing_source_ids": missing_source_ids,
            "disabled_source_ids": disabled_source_ids,
            "orphans_deleted": deleted,
        }

    async def get_job(self, principal: Principal, job_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        job = await self.repository.get_job(tenant_id, job_id)
        if job is None:
            raise NotFoundError("job not found", details={"job_id": job_id})
        return job

    async def list_jobs(
        self, principal: Principal, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_jobs(
            tenant_id, status=status, limit=limit, offset=offset
        )

    async def list_documents(
        self, principal: Principal, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        """List document metadata the caller is authorized to discover.

        The repository narrows by tenant, source state and classification
        ceiling; ACL matching uses the same ``AccessControl`` implementation as
        download and retrieval. Filtering happens before the page is sliced and
        before the total is reported, so neither counts nor page boundaries can
        reveal documents outside the caller's effective permissions.
        """
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError(
                "knowledge source not found", details={"source_id": source_id}
            )
        if source.get("status") == "disabled":
            raise AuthorizationError(
                "not authorized to access this knowledge source",
                details={"source_id": source_id},
            )

        policy = await self.governance.policy_for(tenant_id)
        ceiling = policy.data_classification_ceiling
        if ceiling not in CLASSIFICATION_ORDER:
            raise AuthorizationError(
                "classification policy is missing or invalid",
                details={"source_id": source_id},
            )
        ceiling_rank = classification_rank(ceiling)

        visible: list[dict[str, Any]] = []
        total = 0
        scan_offset = 0
        scan_limit = max(_DOCUMENT_SCAN_PAGE_SIZE, limit)
        while True:
            candidates, candidate_total = await self.repository.list_documents(
                tenant_id,
                source_id,
                limit=scan_limit,
                offset=scan_offset,
                classification_ceiling_rank=ceiling_rank,
            )
            if not candidates:
                break
            for document in candidates:
                effective_classification = self._document_classification(
                    principal, document, source, ceiling
                )
                if effective_classification is None:
                    continue
                public = self._public_document(document, effective_classification)
                if public is None:
                    continue
                if offset <= total < offset + limit:
                    visible.append(public)
                total += 1
            scan_offset += len(candidates)
            if scan_offset >= candidate_total:
                break
        return visible, total

    def _document_classification(
        self,
        principal: Principal,
        document: dict[str, Any],
        source: dict[str, Any],
        ceiling: str,
    ) -> str | None:
        """Return the effective classification when the document is visible.

        Mirrors ``get_document_content`` and retrieval: the maximum of the
        document and source labels must fit the tenant ceiling, and both ACL
        layers must allow the caller. Missing ACLs follow the existing
        tenant-wide default; malformed ACLs fail closed in ``AccessControl``.
        """
        labels = (
            document.get("classification"),
            document.get("source_classification", source.get("classification")),
        )
        classification = max(
            (label for label in labels if label),
            key=classification_rank,
            default="internal",
        )
        if not within_ceiling(classification, ceiling):
            return None
        source_acl = document.get("source_acl")
        if "source_acl" not in document:
            source_acl = source.get("acl")
        if not all(
            self.access.allows(principal, acl)
            for acl in (document.get("acl"), source_acl)
        ):
            return None
        return classification

    @staticmethod
    def _public_document(
        document: dict[str, Any], classification: str
    ) -> dict[str, Any] | None:
        if any(
            document.get(field) is None
            for field in ("id", "source_id", "external_id", "status", "created_at")
        ):
            return None
        public = {field: document.get(field) for field in _DOCUMENT_LIST_FIELDS}
        public["classification"] = classification
        public.setdefault("version", 1)
        public["metadata"] = document.get("metadata") or {}
        return public

    async def get_document(
        self, principal: Principal, document_id: int
    ) -> dict[str, Any]:
        """Return one document's metadata after the same authorization checks.

        Uses identical ceiling/ACL logic to listing, download and retrieval so a
        direct id lookup cannot become a bypass of the visibility rules.
        """
        document, _source = await self._authorized_document(principal, document_id)
        effective = document["_effective_classification"]
        public = self._public_document(document, effective)
        if public is None:
            raise NotFoundError(
                "document not found", details={"document_id": document_id}
            )
        return public

    async def _authorized_document(
        self, principal: Principal, document_id: int
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        tenant_id = require_tenant(principal)
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise NotFoundError(
                "document not found", details={"document_id": document_id}
            )
        if document.get("source_status") == "disabled":
            raise AuthorizationError(
                "not authorized to access this document",
                details={"document_id": document_id},
            )
        source = await self.repository.get_knowledge_source(
            tenant_id, document["source_id"]
        )
        policy = await self.governance.policy_for(tenant_id)
        ceiling = policy.data_classification_ceiling
        effective = self._document_classification(
            principal, document, source or {}, ceiling
        )
        if effective is None:
            raise AuthorizationError(
                "not authorized to access this document",
                details={"document_id": document_id},
            )
        document["_effective_classification"] = effective
        return document, source

    async def update_document(
        self,
        principal: Principal,
        document_id: int,
        *,
        title: str | None,
        metadata: dict[str, Any] | None,
        expected_version: int | None,
    ) -> dict[str, Any]:
        """Update descriptive fields, versioning the change and reindexing search.

        Authorization is the caller's write capability plus document visibility;
        content labels are untouched, so an update can never widen access.
        """
        tenant_id = require_tenant(principal)
        document, _source = await self._authorized_document(principal, document_id)
        updated = await self.repository.update_document_metadata(
            tenant_id,
            document_id,
            title=title,
            metadata=metadata,
            expected_version=expected_version,
        )
        if updated is None:
            exists = await self.repository.get_document(tenant_id, document_id)
            if exists is None:
                raise NotFoundError(
                    "document not found", details={"document_id": document_id}
                )
            raise ConflictError(
                "document was modified by another request; reload and retry",
                details={"document_id": document_id},
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.update_metadata",
            resource_type="document",
            resource_id=str(document_id),
            request_id=request_id_var.get(),
            detail={"version": updated.get("version")},
        )
        if self.search is not None and document.get("source_id") is not None:
            try:
                await self._refresh_search_metadata(tenant_id, updated, document)
            except Exception as exc:  # noqa: BLE001 - metadata sync is best effort
                logger.warning(
                    "knowledge.search_metadata_sync_failed",
                    document_id=document_id,
                    error=str(exc)[:200],
                )
        public = self._public_document(
            updated,
            document.get("_effective_classification")
            or updated.get("classification")
            or "internal",
        )
        if public is None:
            raise NotFoundError(
                "document not found", details={"document_id": document_id}
            )
        return public

    async def _refresh_search_metadata(
        self, tenant_id: int, updated: dict[str, Any], previous: dict[str, Any]
    ) -> None:
        """Rewrite indexed chunk rows with the new title/metadata only."""
        assert self.search is not None
        chunk_rows, _total = await self.repository.list_document_chunks(
            tenant_id, updated["id"], limit=1000, offset=0
        )
        # ``list_document_chunks`` exposes ``chunk_id``; the search backends key
        # their document by the canonical ``id`` shape produced by ingestion.
        chunks = [
            {
                "id": row["chunk_id"],
                "chunk_index": row.get("chunk_index"),
                "content": row.get("content", ""),
                "page": row.get("page"),
                "section": row.get("section"),
                "classification": row.get("classification"),
                "acl": row.get("acl") or {},
            }
            for row in chunk_rows
        ]
        source = await self.repository.get_knowledge_source(
            tenant_id, updated["source_id"]
        )
        search_document = {
            "id": updated["id"],
            "source_id": updated["source_id"],
            "source_code": (source or {}).get("code"),
            "source_name": (source or {}).get("name"),
            "external_id": updated.get("external_id"),
            "title": updated.get("title"),
            "mime_type": updated.get("mime_type"),
            "status": updated.get("status"),
            "classification": updated.get("classification"),
            "acl": updated.get("acl") or {},
            "created_at": updated.get("created_at") or previous.get("created_at"),
            "updated_at": updated.get("updated_at"),
            "metadata": updated.get("metadata") or {},
        }
        await self.search.index_document(tenant_id, search_document, chunks)
        await self.repository.set_document_search_state(
            tenant_id,
            updated["id"],
            search_indexed_at=datetime.now(UTC),
            status=updated.get("status") or "indexed",
            error_class=None,
        )

    async def list_document_versions(
        self, principal: Principal, document_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        """Version history for a document the caller is allowed to see."""
        tenant_id = require_tenant(principal)
        await self._authorized_document(principal, document_id)
        rows, total = await self.repository.list_document_versions(
            tenant_id, document_id, limit=limit, offset=offset
        )
        fields = (
            "document_id",
            "source_id",
            "external_id",
            "version",
            "title",
            "mime_type",
            "checksum",
            "size_bytes",
            "classification",
            "status",
            "reason",
            "superseded_at",
        )
        public = [{field: row.get(field) for field in fields} for row in rows]
        return public, total

    async def delete_source(self, principal: Principal, source_id: int) -> None:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        # Remove the search copy before deleting the database rows. If the search
        # backend is unavailable the delete fails closed: the DB stays intact and
        # no deleted content can remain searchable.
        if self.search is not None:
            await self.search.delete_source(tenant_id, source_id)
        try:
            deleted = await self.repository.delete_source(tenant_id, source_id)
        except Exception:
            logger.warning(
                "knowledge.source_delete_db_failed",
                tenant_id=tenant_id,
                source_id=source_id,
                search_deleted=True,
            )
            raise
        if not deleted:
            logger.warning(
                "knowledge.source_delete_not_committed",
                tenant_id=tenant_id,
                source_id=source_id,
                search_deleted=True,
            )
            raise ConflictError(
                "knowledge source changed during deletion; retry the request",
                details={"source_id": source_id},
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.knowledge_source.delete",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
        )

    async def store_upload(
        self,
        principal: Principal,
        source_id: int,
        *,
        filename: str | None,
        content_type: str | None,
        data: bytes,
    ) -> dict[str, Any]:
        """Validate and persist an uploaded original, returning a doc descriptor.

        Rejects unsupported/oversized/mismatched files, deduplicates by content
        checksum, and stores the original under an opaque, tenant-partitioned
        key. The returned mapping feeds an indexing job; no public URL is ever
        produced.
        """

        tenant_id = require_tenant(principal)
        source = await self.repository.get_knowledge_source(tenant_id, source_id)
        if source is None:
            raise NotFoundError("knowledge source not found", details={"source_id": source_id})
        if source["status"] == "disabled":
            raise ValidationError("knowledge source is disabled")
        if self.storage is None:
            raise ConfigurationError("object storage is not configured")

        resolved_mime = validate_upload(
            data,
            filename=filename,
            declared_mime=content_type,
            max_bytes=self.settings.ai_upload_max_bytes,
        )
        checksum = content_checksum(data)

        existing = await self.repository.find_document_by_checksum(tenant_id, checksum)
        existing_key = (existing or {}).get("object_key")
        if existing is not None and existing_key:
            try:
                existing_key = validate_document_object_key(existing_key, tenant_id)
            except ConfigurationError:
                logger.warning(
                    "knowledge.upload_dedup_key_rejected",
                    tenant_id=tenant_id,
                    document_id=existing.get("id"),
                )
                existing_key = None
        if existing_key and await self.storage.exists(existing_key):
            return {
                "external_id": existing["external_id"],
                "title": existing.get("title") or filename,
                "mime_type": existing.get("mime_type") or resolved_mime,
                "object_key": existing_key,
                "checksum": checksum,
                "size_bytes": existing.get("size_bytes") or len(data),
                "deduplicated": True,
            }

        safe_name = sanitize_filename(filename or "document")
        object_key = build_object_key(tenant_id, safe_name)
        await self.storage.put(object_key, data, content_type=resolved_mime)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.upload",
            resource_type="knowledge_source",
            resource_id=str(source_id),
            request_id=request_id_var.get(),
            detail={"filename": safe_name, "size_bytes": len(data)},
        )
        return {
            "external_id": safe_name,
            "title": filename or safe_name,
            "mime_type": resolved_mime,
            "object_key": object_key,
            "checksum": checksum,
            "size_bytes": len(data),
            "deduplicated": False,
        }

    async def get_document_content(
        self, principal: Principal, document_id: int
    ) -> tuple[dict[str, Any], bytes]:
        tenant_id = require_tenant(principal)
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise NotFoundError("document not found", details={"document_id": document_id})
        if document.get("source_status") == "disabled":
            raise AuthorizationError(
                "not authorized to access this document",
                details={"document_id": document_id},
            )
        policy = await self.governance.policy_for(tenant_id)
        classification = max(
            (
                label
                for label in (
                    document.get("classification"),
                    document.get("source_classification"),
                )
                if label
            ),
            key=classification_rank,
            default="internal",
        )
        if not within_ceiling(
            classification, policy.data_classification_ceiling
        ) or not all(
            self.access.allows(principal, acl)
            for acl in (document.get("acl"), document.get("source_acl"))
        ):
            raise AuthorizationError(
                "not authorized to access this document",
                details={"document_id": document_id},
            )
        object_key = self._stored_object_key(tenant_id, document)
        if object_key is None:
            raise NotFoundError("document has no stored original")
        if self.storage is None:
            raise ConfigurationError("object storage is not configured")
        data = await self.storage.get(object_key)
        if data is None:
            raise NotFoundError("stored document not found")
        return document, data

    @staticmethod
    def _stored_object_key(tenant_id: int, document: dict[str, Any]) -> str | None:
        """Resolve a document's key, rejecting malformed or foreign namespaces.

        The database row is authoritative for legacy keys; a key that claims a
        different tenant's ``knowledge/`` namespace is never accepted.
        """

        object_key = document.get("object_key")
        if not object_key:
            return None
        try:
            return validate_document_object_key(object_key, tenant_id)
        except ConfigurationError:
            logger.warning(
                "knowledge.object_key_rejected",
                tenant_id=tenant_id,
                document_id=document.get("id"),
                source_id=document.get("source_id"),
            )
            raise AuthorizationError("stored object is not accessible") from None

    async def delete_document(self, principal: Principal, document_id: int) -> None:
        tenant_id = require_tenant(principal)
        document = await self.repository.get_document(tenant_id, document_id)
        if document is None:
            raise NotFoundError("document not found", details={"document_id": document_id})
        # Resolve and authorize the storage key before any destructive side
        # effect, so a malformed/foreign key cannot trigger a cross-tenant
        # object delete or remove the metadata of a still-stored original.
        object_key = self._stored_object_key(tenant_id, document)
        # Match the search copy by stable identity as well as id so chunks left
        # by an earlier reindex (which assigns a new document id) are removed.
        if self.search is not None:
            await self.search.delete_document(
                tenant_id,
                document_id,
                source_id=document.get("source_id"),
                external_id=document.get("external_id"),
            )
        try:
            deleted = await self.repository.delete_document(tenant_id, document_id)
        except Exception:
            logger.warning(
                "knowledge.document_delete_db_failed",
                tenant_id=tenant_id,
                document_id=document_id,
                search_deleted=True,
            )
            raise
        if not deleted:
            logger.warning(
                "knowledge.document_delete_not_committed",
                tenant_id=tenant_id,
                document_id=document_id,
                search_deleted=True,
            )
            raise ConflictError(
                "document changed during deletion; retry the request",
                details={"document_id": document_id},
            )
        if object_key and self.storage is not None:
            await self.storage.delete(object_key)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.document.delete",
            resource_type="document",
            resource_id=str(document_id),
            request_id=request_id_var.get(),
        )
