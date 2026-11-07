"""Duplicate and conflict detection (Stage 4 Phase 5).

Detection is advisory and non-destructive. A *duplicate* is two documents with
identical content (checksum) or an identical normalized title; a *conflict* is
the same external identifier carrying different content. Findings are stored as
review records and are never merged, overwritten or deleted automatically.

Signals (strongest first):
  checksum    1.0  identical content hash          -> duplicate
  external_id 0.9  same identifier, differing hash -> conflict
                   same identifier, same hash      -> duplicate
  title       0.6  same normalized title           -> duplicate (possible)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.config.settings import Settings
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import request_id_var
from ai_api.telemetry.tracing import span

_CONFIDENCE = {"checksum": 1.0, "external_id": 0.9, "title": 0.6}
_PRECEDENCE = {"checksum": 3, "external_id": 2, "title": 1}
_REVIEW_STATUSES = frozenset({"dismissed", "resolved"})


def _normalize(value: Any) -> str:
    return " ".join(str(value or "").lower().split())


@dataclass(slots=True)
class DuplicateService:
    repository: AiRepository
    audit: AuditService
    settings: Settings

    async def scan(self, principal: Principal) -> dict[str, Any]:
        with span("ai.search.duplicate_scan", {"ai.operation": "search.duplicates"}):
            return await self._scan_impl(principal)

    async def _scan_impl(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        documents = await self.repository.list_documents_for_dedup(
            tenant_id, limit=self.settings.ai_dedup_scan_limit
        )
        findings = detect(documents)
        summary = await self.repository.upsert_duplicate_findings(tenant_id, findings)
        by_kind: dict[str, int] = {}
        for finding in findings:
            by_kind[finding["kind"]] = by_kind.get(finding["kind"], 0) + 1
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.search.duplicate_scan",
            resource_type="search_duplicates",
            resource_id=None,
            request_id=request_id_var.get(),
            detail={
                "documents_scanned": len(documents),
                "findings": summary["total"],
                "by_kind": by_kind,
            },
        )
        return {
            "documents_scanned": len(documents),
            "findings": summary["total"],
            "created": summary["created"],
            "updated": summary["updated"],
            "skipped": summary["skipped"],
            "by_kind": by_kind,
        }

    async def list_findings(
        self,
        principal: Principal,
        *,
        status: str | None,
        kind: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_duplicate_findings(
            tenant_id, status=status, kind=kind, limit=limit, offset=offset
        )

    async def get_finding(
        self, principal: Principal, finding_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        finding = await self.repository.get_duplicate_finding(tenant_id, finding_id)
        if finding is None:
            raise NotFoundError(
                "duplicate finding not found", details={"finding_id": finding_id}
            )
        return finding

    async def review(
        self,
        principal: Principal,
        finding_id: int,
        *,
        status: str,
        note: str | None,
    ) -> dict[str, Any]:
        if status not in _REVIEW_STATUSES:
            raise ValidationError(
                "invalid review status",
                details={"allowed": sorted(_REVIEW_STATUSES)},
            )
        tenant_id = require_tenant(principal)
        await self.get_finding(principal, finding_id)
        updated = await self.repository.update_duplicate_finding(
            tenant_id,
            finding_id,
            status=status,
            note=note,
            reviewed_by=principal.actor_id,
        )
        if updated is None:
            raise NotFoundError(
                "duplicate finding not found", details={"finding_id": finding_id}
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.search.duplicate_review",
            resource_type="search_duplicates",
            resource_id=str(finding_id),
            request_id=request_id_var.get(),
            detail={"status": status},
        )
        return updated


def detect(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return canonical pair findings for a tenant's documents.

    Each bucket is paired against its first (lowest-id) member so work stays
    linear in the bucket size rather than quadratic, while still surfacing every
    document that shares the signal with the representative.
    """
    by_id = {doc["id"]: doc for doc in documents}
    buckets: dict[str, dict[str, list[int]]] = {
        "checksum": {},
        "external_id": {},
        "title": {},
    }
    for doc in documents:
        checksum = str(doc.get("checksum") or "").strip()
        if checksum:
            buckets["checksum"].setdefault(checksum, []).append(doc["id"])
        external = str(doc.get("external_id") or "").strip().lower()
        if external:
            buckets["external_id"].setdefault(external, []).append(doc["id"])
        title = _normalize(doc.get("title"))
        if title:
            buckets["title"].setdefault(title, []).append(doc["id"])

    pairs: dict[tuple[int, int], dict[str, Any]] = {}
    for match_type in ("checksum", "external_id", "title"):
        for value, ids in buckets[match_type].items():
            unique = sorted(set(ids))
            if len(unique) < 2:
                continue
            anchor = unique[0]
            for other in unique[1:]:
                candidate = _build_finding(
                    by_id, anchor, other, match_type, value
                )
                key = (candidate["document_a_id"], candidate["document_b_id"])
                existing = pairs.get(key)
                if existing is None or _PRECEDENCE[match_type] > _PRECEDENCE[
                    existing["match_type"]
                ]:
                    pairs[key] = candidate
    return list(pairs.values())


def _build_finding(
    by_id: dict[int, dict[str, Any]],
    left: int,
    right: int,
    match_type: str,
    value: str,
) -> dict[str, Any]:
    a, b = (left, right) if left < right else (right, left)
    doc_a, doc_b = by_id[a], by_id[b]
    if match_type == "external_id":
        checksum_a = str(doc_a.get("checksum") or "").strip()
        checksum_b = str(doc_b.get("checksum") or "").strip()
        kind = "duplicate" if checksum_a and checksum_a == checksum_b else "conflict"
    else:
        kind = "duplicate"
    return {
        "dedupe_key": f"{a}:{b}",
        "kind": kind,
        "match_type": match_type,
        "confidence": _CONFIDENCE[match_type],
        "document_a_id": a,
        "document_b_id": b,
        "evidence": {
            "match": {match_type: value},
            "document_a": _document_evidence(doc_a),
            "document_b": _document_evidence(doc_b),
        },
    }


def _document_evidence(doc: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": doc["id"],
        "external_id": doc.get("external_id"),
        "title": doc.get("title"),
        "source_code": doc.get("source_code"),
        "status": doc.get("status"),
    }
