"""Quality Intelligence (Stage 9 / Step 7).

Owns quality *domain* records: issues/nonconformances, inspections and their
results, root-cause hypotheses, corrective/preventive actions (CAPA) and supplier
quality issues. Records reference products, parts, processes, operations, plants
and work centres, and may carry a `graph_entity_id` so the digital thread and
impact engines keep working without a second graph model.

Two hard rules from the specification are enforced here:

* an AI-generated root cause is never presented as *confirmed* until a human
  explicitly confirms it (``RootCauseUpdate.confirm``); and
* no production/inspection/quality data is fabricated. Analytics only summarise
  rows that actually exist and report unavailable sources explicitly.

Authorization mirrors the product/BOM/manufacturing services: every read checks
the tenant classification ceiling and the record ACL, and unauthorized records
surface as ``NotFoundError`` so their existence is not leaked.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.manufacturing_service import ManufacturingService
from ai_api.application.services.product_service import ProductService
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.domain.quality import (
    ACTION_EFFECTIVENESS,
    ACTION_STATUS_TRANSITIONS,
    ACTION_STATUSES,
    ACTION_TYPES,
    ACTIVE_ISSUE_STATUSES,
    CLOSED_ISSUE_STATUSES,
    GRAPH_TYPE_BY_KIND,
    INSPECTION_STATUS_TRANSITIONS,
    INSPECTION_STATUSES,
    INSPECTION_TYPES,
    ISSUE_DISPOSITIONS,
    ISSUE_SEVERITIES,
    ISSUE_STATUS_TRANSITIONS,
    ISSUE_STATUSES,
    ISSUE_TYPES,
    MAX_ANALYTICS_ROWS,
    MAX_REPEAT_GROUPS,
    OPEN_ACTION_STATUSES,
    REPEAT_WINDOW_DAYS_DEFAULT,
    RESULT_STATUSES,
    ROOT_CAUSE_CLASSIFICATIONS,
    is_transition_allowed,
    normalise_choice,
    normalise_issue_key,
    normalise_key,
)
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("quality")

_SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def _require_choice(value: str, allowed: tuple[str, ...], field: str) -> str:
    text = normalise_choice(value)
    if text not in allowed:
        raise ValidationError(
            f"invalid {field}", details={"field": field, "allowed": list(allowed)}
        )
    return text


def _parse_ts(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class QualityService:
    def __init__(
        self,
        repository: AiRepository,
        products: ProductService,
        manufacturing: ManufacturingService,
        audit: AuditService,
        access: AccessControl,
        governance: GovernanceService,
        graph: GraphService,
        events: EventPublisher | None = None,
    ) -> None:
        self.repository = repository
        self.products = products
        self.manufacturing = manufacturing
        self.audit = audit
        self.access = access
        self.governance = governance
        self.graph = graph
        self.events = events

    # --- Authorization helpers -----------------------------------------
    async def _readable(self, principal: Principal, record: dict[str, Any]) -> bool:
        if record.get("deleted_at"):
            return False
        policy = await self.governance.policy_for(principal.tenant_id)
        if not within_ceiling(
            record.get("classification"), policy.data_classification_ceiling
        ):
            return False
        return self.access.allows(principal, record.get("acl"))

    async def _readable_many(
        self, principal: Principal, records: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Filter a page of records with a single governance-policy lookup.

        Same per-row semantics as :meth:`_readable`, but the tenant's
        classification ceiling is fetched once. No cross-request caching, so a
        policy change is honoured on the next request.
        """

        if not records:
            return []
        policy = await self.governance.policy_for(principal.tenant_id)
        ceiling = policy.data_classification_ceiling
        return [
            record
            for record in records
            if not record.get("deleted_at")
            and within_ceiling(record.get("classification"), ceiling)
            and self.access.allows(principal, record.get("acl"))
        ]

    async def _require_readable(
        self, principal: Principal, record: dict[str, Any] | None, label: str
    ) -> dict[str, Any]:
        if record is None or not await self._readable(principal, record):
            raise NotFoundError(f"{label} not found")
        return record

    # --- Graph linkage --------------------------------------------------
    async def _link_entity(
        self,
        principal: Principal,
        *,
        kind: str,
        stable_key: str,
        name: str | None,
        description: str | None,
        classification: str,
        acl: dict[str, Any],
        lifecycle_status: str,
        properties: dict[str, Any],
    ) -> int | None:
        try:
            from ai_api.schemas.graph import GraphEntityCreate

            entity = await self.graph.create_or_update_entity(
                principal,
                GraphEntityCreate(
                    entity_type=GRAPH_TYPE_BY_KIND[kind],
                    stable_key=stable_key,
                    name=name,
                    description=description,
                    classification=classification,
                    acl=acl,
                    lifecycle_status=(
                        lifecycle_status
                        if lifecycle_status
                        in ("active", "inactive", "draft", "released", "obsolete",
                            "stale", "archived")
                        else "active"
                    ),
                    properties=properties,
                    source_system="ai.quality",
                ),
            )
            return int(entity["id"])
        except Exception as exc:  # noqa: BLE001 - graph is navigation only
            logger.warning("quality.graph_link_failed", error=str(exc))
            return None

    async def _link_relationship(
        self,
        principal: Principal,
        relationship_type: str,
        source_id: int | None,
        target_id: int | None,
    ) -> None:
        if not source_id or not target_id or source_id == target_id:
            return
        try:
            from ai_api.schemas.graph import GraphRelationshipCreate

            await self.graph.create_relationship(
                principal,
                GraphRelationshipCreate(
                    relationship_type=relationship_type,
                    source_entity_id=source_id,
                    target_entity_id=target_id,
                    source_system="ai.quality",
                ),
            )
        except Exception as exc:  # noqa: BLE001 - navigation only
            logger.warning("quality.graph_relationship_failed", error=str(exc))

    async def _item_graph_id(self, tenant_id: int, item_id: int | None) -> int | None:
        if item_id is None:
            return None
        item = await self.repository.get_product_item(tenant_id, item_id)
        if item is None:
            return None
        value = item.get("graph_entity_id")
        return int(value) if value is not None else None

    # --- Audit / events -------------------------------------------------
    async def _emit(
        self,
        event_type: str,
        *,
        tenant_id: int,
        principal: Principal,
        subject_type: str,
        data: dict[str, Any],
    ) -> None:
        if self.events is None:
            return
        try:
            await self.events.emit(
                event_type,
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                subject_type=subject_type,
                data=data,
            )
        except Exception as exc:  # noqa: BLE001 - publishing must not break writes
            logger.warning("quality.event_publish_failed", error=str(exc))

    async def _audit(
        self,
        principal: Principal,
        action: str,
        resource_type: str,
        resource_id: int | str,
        detail: dict[str, Any] | None = None,
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=f"ai.quality.{action}",
            resource_type=resource_type,
            resource_id=str(resource_id),
            detail=detail or {},
        )

    # --- Reference validation ------------------------------------------
    async def _validate_references(
        self, principal: Principal, fields: dict[str, Any]
    ) -> None:
        if fields.get("product_item_id") is not None:
            await self.products.get_item(principal, fields["product_item_id"])
        if fields.get("component_item_id") is not None:
            await self.products.get_item(principal, fields["component_item_id"])
        if fields.get("process_id") is not None:
            await self.manufacturing.get_process(principal, fields["process_id"])
        if fields.get("operation_id") is not None:
            await self.manufacturing.get_operation(principal, fields["operation_id"])
        if fields.get("plant_id") is not None:
            await self.manufacturing.get_plant(principal, fields["plant_id"])
        if fields.get("work_centre_id") is not None:
            await self.manufacturing.get_work_centre(
                principal, fields["work_centre_id"]
            )

    # --- Quality issues -------------------------------------------------
    async def upsert_issue(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issue_key = normalise_issue_key(payload.issue_key)
        if not issue_key:
            raise ValidationError("issue_key must not be empty")
        issue_type = _require_choice(
            payload.issue_type or "nonconformance", ISSUE_TYPES, "issue_type"
        )
        severity = _require_choice(payload.severity or "medium", ISSUE_SEVERITIES, "severity")
        status = _require_choice(payload.status or "open", ISSUE_STATUSES, "status")
        disposition = _require_choice(
            payload.disposition or "none", ISSUE_DISPOSITIONS, "disposition"
        )
        await self._validate_references(principal, payload.model_dump())
        existing = await self.repository.get_quality_issue_by_key(tenant_id, issue_key)
        if existing is not None:
            await self._require_readable(principal, existing, "quality issue")
        kind = "nonconformance" if issue_type == "nonconformance" else "issue"
        graph_entity_id = await self._link_entity(
            principal,
            kind=kind,
            stable_key=f"QI:{issue_key}",
            name=payload.title or issue_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status="active",
            properties={
                "issue_key": issue_key,
                "issue_type": issue_type,
                "severity": severity,
            },
        )
        if graph_entity_id is not None:
            component_graph = await self._item_graph_id(
                tenant_id, payload.component_item_id
            )
            product_graph = await self._item_graph_id(tenant_id, payload.product_item_id)
            for target in (component_graph, product_graph):
                await self._link_relationship(
                    principal, "quality_affects", graph_entity_id, target
                )
        data = {
            "issue_key": issue_key,
            "title": payload.title,
            "description": payload.description,
            "issue_type": issue_type,
            "severity": severity,
            "status": status,
            "disposition": disposition,
            "product_item_id": payload.product_item_id,
            "component_item_id": payload.component_item_id,
            "process_id": payload.process_id,
            "operation_id": payload.operation_id,
            "plant_id": payload.plant_id,
            "work_centre_id": payload.work_centre_id,
            "supplier_ref": payload.supplier_ref,
            "failure_code": payload.failure_code,
            "detected_at": payload.detected_at,
            "detected_by": payload.detected_by,
            "attributes": payload.attributes,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        issue = await self.repository.upsert_quality_issue(tenant_id, data)
        await self._audit(
            principal,
            "issue.upsert",
            "quality_issue",
            issue["id"],
            {"issue_key": issue_key, "created": existing is None},
        )
        await self._emit(
            "QualityIssueChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_issue",
            data={
                "issue_id": issue["id"],
                "issue_key": issue_key,
                "issue_type": issue_type,
                "status": status,
                "severity": severity,
                "created": existing is None,
            },
        )
        return issue

    async def get_issue(self, principal: Principal, issue_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issue = await self.repository.get_quality_issue(tenant_id, issue_id)
        return await self._require_readable(principal, issue, "quality issue")

    async def list_issues(
        self,
        principal: Principal,
        *,
        status: str | None,
        severity: str | None,
        issue_type: str | None,
        component_item_id: int | None,
        product_item_id: int | None,
        supplier_ref: str | None,
        plant_id: int | None,
        operation_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_quality_issues(
            tenant_id,
            status=normalise_choice(status) if status else None,
            severity=normalise_choice(severity) if severity else None,
            issue_type=normalise_choice(issue_type) if issue_type else None,
            component_item_id=component_item_id,
            product_item_id=product_item_id,
            supplier_ref=supplier_ref,
            plant_id=plant_id,
            operation_id=operation_id,
            query=query,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_issue(
        self, principal: Principal, issue_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issue = await self.get_issue(principal, issue_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("status") is not None:
            target = _require_choice(fields["status"], ISSUE_STATUSES, "status")
            if not is_transition_allowed(
                ISSUE_STATUS_TRANSITIONS, issue["status"], target
            ):
                raise ValidationError(
                    "illegal quality issue status transition",
                    details={"from": issue["status"], "to": target},
                )
            fields["status"] = target
        if fields.get("severity") is not None:
            fields["severity"] = _require_choice(
                fields["severity"], ISSUE_SEVERITIES, "severity"
            )
        if fields.get("issue_type") is not None:
            fields["issue_type"] = _require_choice(
                fields["issue_type"], ISSUE_TYPES, "issue_type"
            )
        if fields.get("disposition") is not None:
            fields["disposition"] = _require_choice(
                fields["disposition"], ISSUE_DISPOSITIONS, "disposition"
            )
        await self._validate_references(principal, fields)
        fields["updated_by"] = principal.username
        updated = await self.repository.update_quality_issue(tenant_id, issue_id, fields)
        updated = await self._require_readable(principal, updated, "quality issue")
        await self._audit(
            principal, "issue.update", "quality_issue", issue_id,
            {"fields": sorted(fields), "reason": reason},
        )
        await self._emit(
            "QualityIssueChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_issue",
            data={
                "issue_id": issue_id,
                "issue_key": updated["issue_key"],
                "status": updated["status"],
                "severity": updated["severity"],
                "created": False,
            },
        )
        return updated

    # --- Inspections -----------------------------------------------------
    async def upsert_inspection(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        inspection_key = normalise_issue_key(payload.inspection_key)
        if not inspection_key:
            raise ValidationError("inspection_key must not be empty")
        inspection_type = _require_choice(
            payload.inspection_type or "incoming", INSPECTION_TYPES, "inspection_type"
        )
        status = _require_choice(
            payload.status or "planned", INSPECTION_STATUSES, "status"
        )
        await self._validate_references(principal, payload.model_dump())
        if payload.quality_issue_id is not None:
            await self.get_issue(principal, payload.quality_issue_id)
        existing = await self.repository.get_quality_inspection_by_key(
            tenant_id, inspection_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "inspection")
        graph_entity_id = await self._link_entity(
            principal,
            kind="inspection",
            stable_key=f"INSP:{inspection_key}",
            name=payload.title or inspection_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status="active",
            properties={
                "inspection_key": inspection_key,
                "inspection_type": inspection_type,
                "status": status,
            },
        )
        data = {
            "inspection_key": inspection_key,
            "title": payload.title,
            "description": payload.description,
            "inspection_type": inspection_type,
            "status": status,
            "product_item_id": payload.product_item_id,
            "component_item_id": payload.component_item_id,
            "operation_id": payload.operation_id,
            "plant_id": payload.plant_id,
            "work_centre_id": payload.work_centre_id,
            "quality_issue_id": payload.quality_issue_id,
            "characteristic": payload.characteristic,
            "sample_size": payload.sample_size,
            "passed_count": payload.passed_count,
            "failed_count": payload.failed_count,
            "performed_by": payload.performed_by,
            "performed_at": payload.performed_at,
            "result": payload.result,
            "attributes": payload.attributes,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        inspection = await self.repository.upsert_quality_inspection(tenant_id, data)
        await self._audit(
            principal,
            "inspection.upsert",
            "quality_inspection",
            inspection["id"],
            {"inspection_key": inspection_key, "created": existing is None},
        )
        await self._emit(
            "QualityInspectionChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_inspection",
            data={
                "inspection_id": inspection["id"],
                "inspection_key": inspection_key,
                "status": status,
                "created": existing is None,
            },
        )
        return inspection

    async def get_inspection(
        self, principal: Principal, inspection_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        inspection = await self.repository.get_quality_inspection(
            tenant_id, inspection_id
        )
        return await self._require_readable(principal, inspection, "inspection")

    async def list_inspections(
        self,
        principal: Principal,
        *,
        status: str | None,
        inspection_type: str | None,
        quality_issue_id: int | None,
        operation_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_quality_inspections(
            tenant_id,
            status=normalise_choice(status) if status else None,
            inspection_type=(
                normalise_choice(inspection_type) if inspection_type else None
            ),
            quality_issue_id=quality_issue_id,
            operation_id=operation_id,
            query=query,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_inspection(
        self, principal: Principal, inspection_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        inspection = await self.get_inspection(principal, inspection_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("status") is not None:
            target = _require_choice(fields["status"], INSPECTION_STATUSES, "status")
            if not is_transition_allowed(
                INSPECTION_STATUS_TRANSITIONS, inspection["status"], target
            ):
                raise ValidationError(
                    "illegal inspection status transition",
                    details={"from": inspection["status"], "to": target},
                )
            fields["status"] = target
        await self._validate_references(principal, fields)
        if fields.get("quality_issue_id") is not None:
            await self.get_issue(principal, fields["quality_issue_id"])
        fields["updated_by"] = principal.username
        updated = await self.repository.update_quality_inspection(
            tenant_id, inspection_id, fields
        )
        updated = await self._require_readable(principal, updated, "inspection")
        await self._audit(
            principal, "inspection.update", "quality_inspection", inspection_id,
            {"fields": sorted(fields), "reason": reason},
        )
        await self._emit(
            "QualityInspectionChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_inspection",
            data={
                "inspection_id": inspection_id,
                "status": updated["status"],
                "created": False,
            },
        )
        return updated

    async def add_inspection_result(
        self, principal: Principal, inspection_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_inspection(principal, inspection_id)
        result = _require_choice(payload.result or "unknown", RESULT_STATUSES, "result")
        record = await self.repository.add_quality_inspection_result(
            tenant_id,
            {
                "inspection_id": inspection_id,
                "characteristic": payload.characteristic,
                "measured_value": payload.measured_value,
                "result": result,
                "defect_code": payload.defect_code,
                "defect_category": payload.defect_category,
                "notes": payload.notes,
                "created_by": principal.username,
            },
        )
        await self._audit(
            principal, "inspection_result.add", "quality_inspection_result",
            record["id"], {"inspection_id": inspection_id, "result": result},
        )
        return record

    async def list_inspection_results(
        self, principal: Principal, inspection_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.get_inspection(principal, inspection_id)
        return await self.repository.list_quality_inspection_results(
            tenant_id, inspection_id=inspection_id, limit=limit
        )

    # --- Root causes -----------------------------------------------------
    async def add_root_cause(
        self, principal: Principal, issue_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issue = await self.get_issue(principal, issue_id)
        classification = _require_choice(
            payload.classification or "other",
            ROOT_CAUSE_CLASSIFICATIONS,
            "classification",
        )
        # An AI/human hypothesis is never auto-confirmed; confirmation is an
        # explicit, separate action. `confirmed` therefore always starts False.
        record = await self.repository.add_quality_root_cause(
            tenant_id,
            {
                "quality_issue_id": issue_id,
                "classification": classification,
                "description": payload.description,
                "is_hypothesis": payload.is_hypothesis,
                "confirmed": False,
                "confidence": payload.confidence,
                "evidence": payload.evidence,
                "created_by": principal.username,
            },
        )
        if issue.get("root_cause_status") == "not_investigated":
            await self.repository.update_quality_issue(
                tenant_id,
                issue_id,
                {"root_cause_status": "hypothesis", "updated_by": principal.username},
            )
        await self._audit(
            principal, "root_cause.add", "quality_root_cause", record["id"],
            {"issue_id": issue_id, "classification": classification},
        )
        return record

    async def list_root_causes(
        self, principal: Principal, issue_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.get_issue(principal, issue_id)
        return await self.repository.list_quality_root_causes(
            tenant_id, quality_issue_id=issue_id, limit=limit
        )

    async def update_root_cause(
        self, principal: Principal, issue_id: int, root_cause_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_issue(principal, issue_id)
        existing = await self.repository.get_quality_root_cause(
            tenant_id, root_cause_id
        )
        if existing is None or existing["quality_issue_id"] != issue_id:
            raise NotFoundError("root cause not found")
        fields = payload.model_dump(exclude_unset=True)
        confirm = bool(fields.pop("confirm", False))
        if fields.get("classification") is not None:
            fields["classification"] = _require_choice(
                fields["classification"], ROOT_CAUSE_CLASSIFICATIONS, "classification"
            )
        if confirm:
            fields["confirmed"] = True
            fields["is_hypothesis"] = False
        fields["updated_by"] = principal.username
        updated = await self.repository.update_quality_root_cause(
            tenant_id, root_cause_id, fields
        )
        if updated is None:
            raise NotFoundError("root cause not found")
        if confirm:
            await self.repository.update_quality_issue(
                tenant_id,
                issue_id,
                {"root_cause_status": "confirmed", "updated_by": principal.username},
            )
        await self._audit(
            principal, "root_cause.update", "quality_root_cause", root_cause_id,
            {"issue_id": issue_id, "confirmed": confirm, "fields": sorted(fields)},
        )
        return updated

    # --- Corrective / preventive actions (CAPA) --------------------------
    async def upsert_action(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issue = await self.get_issue(principal, payload.quality_issue_id)
        action_key = normalise_issue_key(payload.action_key)
        if not action_key:
            raise ValidationError("action_key must not be empty")
        action_type = _require_choice(
            payload.action_type or "corrective", ACTION_TYPES, "action_type"
        )
        status = _require_choice(payload.status or "open", ACTION_STATUSES, "status")
        effectiveness = _require_choice(
            payload.effectiveness or "pending", ACTION_EFFECTIVENESS, "effectiveness"
        )
        if payload.root_cause_id is not None:
            root = await self.repository.get_quality_root_cause(
                tenant_id, payload.root_cause_id
            )
            if root is None or root["quality_issue_id"] != issue["id"]:
                raise ValidationError("root_cause_id does not belong to the issue")
        existing = await self.repository.get_quality_action_by_key(tenant_id, action_key)
        if existing is not None:
            await self._require_readable(principal, existing, "quality action")
        graph_entity_id = await self._link_entity(
            principal,
            kind="action",
            stable_key=f"CAPA:{action_key}",
            name=payload.title or action_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status="active",
            properties={
                "action_key": action_key,
                "action_type": action_type,
                "status": status,
            },
        )
        if graph_entity_id is not None and issue.get("graph_entity_id"):
            await self._link_relationship(
                principal, "resolves", graph_entity_id, issue["graph_entity_id"]
            )
        data = {
            "action_key": action_key,
            "quality_issue_id": issue["id"],
            "title": payload.title,
            "description": payload.description,
            "action_type": action_type,
            "status": status,
            "root_cause_id": payload.root_cause_id,
            "owner_user": payload.owner_user,
            "due_at": payload.due_at,
            "effectiveness": effectiveness,
            "evidence": payload.evidence,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        action = await self.repository.upsert_quality_action(tenant_id, data)
        await self._audit(
            principal,
            "action.upsert",
            "quality_action",
            action["id"],
            {"action_key": action_key, "created": existing is None},
        )
        await self._emit(
            "QualityActionChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_action",
            data={
                "action_id": action["id"],
                "action_key": action_key,
                "issue_id": issue["id"],
                "status": status,
                "action_type": action_type,
                "created": existing is None,
            },
        )
        return action

    async def get_action(self, principal: Principal, action_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        action = await self.repository.get_quality_action(tenant_id, action_id)
        return await self._require_readable(principal, action, "quality action")

    async def list_actions(
        self,
        principal: Principal,
        *,
        quality_issue_id: int | None,
        status: str | None,
        action_type: str | None,
        owner_user: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_quality_actions(
            tenant_id,
            quality_issue_id=quality_issue_id,
            status=normalise_choice(status) if status else None,
            action_type=normalise_choice(action_type) if action_type else None,
            owner_user=owner_user,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_action(
        self, principal: Principal, action_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        action = await self.get_action(principal, action_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        now = datetime.now(UTC)
        if fields.get("status") is not None:
            target = _require_choice(fields["status"], ACTION_STATUSES, "status")
            if not is_transition_allowed(
                ACTION_STATUS_TRANSITIONS, action["status"], target
            ):
                raise ValidationError(
                    "illegal action status transition",
                    details={"from": action["status"], "to": target},
                )
            fields["status"] = target
            if target == "implemented" and not action.get("implemented_at"):
                fields["implemented_at"] = now
            if target == "verified":
                fields["verified_at"] = now
                fields["verified_by"] = principal.username
                if not action.get("implemented_at"):
                    fields["implemented_at"] = now
        if fields.get("action_type") is not None:
            fields["action_type"] = _require_choice(
                fields["action_type"], ACTION_TYPES, "action_type"
            )
        if fields.get("effectiveness") is not None:
            fields["effectiveness"] = _require_choice(
                fields["effectiveness"], ACTION_EFFECTIVENESS, "effectiveness"
            )
        if fields.get("root_cause_id") is not None:
            root = await self.repository.get_quality_root_cause(
                tenant_id, fields["root_cause_id"]
            )
            if root is None or root["quality_issue_id"] != action["quality_issue_id"]:
                raise ValidationError("root_cause_id does not belong to the issue")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_quality_action(
            tenant_id, action_id, fields
        )
        updated = await self._require_readable(principal, updated, "quality action")
        await self._audit(
            principal, "action.update", "quality_action", action_id,
            {"fields": sorted(fields), "reason": reason},
        )
        await self._emit(
            "QualityActionChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="quality_action",
            data={
                "action_id": action_id,
                "action_key": updated["action_key"],
                "issue_id": updated["quality_issue_id"],
                "status": updated["status"],
                "action_type": updated["action_type"],
                "created": False,
            },
        )
        return updated

    # --- Supplier quality ------------------------------------------------
    async def add_supplier_issue(
        self, principal: Principal, issue_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_issue(principal, issue_id)
        supplier_ref = normalise_key(payload.supplier_ref)
        if not supplier_ref:
            raise ValidationError("supplier_ref must not be empty")
        record = await self.repository.add_quality_supplier_issue(
            tenant_id,
            {
                "quality_issue_id": issue_id,
                "supplier_ref": supplier_ref,
                "supplier_name": payload.supplier_name,
                "component_item_id": payload.component_item_id,
                "defect_category": payload.defect_category,
                "quantity_affected": payload.quantity_affected,
                "containment_ref": payload.containment_ref,
                "created_by": principal.username,
            },
        )
        await self._audit(
            principal, "supplier_issue.add", "quality_supplier_issue", record["id"],
            {"issue_id": issue_id, "supplier_ref": supplier_ref},
        )
        return record

    async def list_supplier_issues(
        self, principal: Principal, *, supplier_ref: str | None, limit: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        reference = normalise_key(supplier_ref) if supplier_ref else None
        return await self.repository.list_quality_supplier_issues(
            tenant_id, supplier_ref=reference or None, limit=limit
        )

    # --- Analytics -------------------------------------------------------
    async def _visible_issues(
        self, principal: Principal, *, limit: int = MAX_ANALYTICS_ROWS
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        rows, _ = await self.repository.list_quality_issues(
            tenant_id, status=None, severity=None, issue_type=None,
            component_item_id=None, product_item_id=None, supplier_ref=None,
            plant_id=None, operation_id=None, query=None, limit=limit, offset=0,
        )
        return await self._readable_many(principal, rows)

    async def analytics(self, principal: Principal, kind: str) -> dict[str, Any]:
        issues = await self._visible_issues(principal)
        if kind in ("issues_by_product", "issues_by_part"):
            field = "product_item_id" if kind == "issues_by_product" else "component_item_id"
            return self._group_issues(
                kind, issues, field, label_key=field, severity=True
            )
        if kind == "defects_by_supplier":
            return self._group_issues(kind, issues, "supplier_ref", label_key="supplier_ref")
        if kind == "defects_by_plant":
            return self._group_issues(kind, issues, "plant_id", label_key="plant_id")
        if kind == "defects_by_work_centre":
            return self._group_issues(
                kind, issues, "work_centre_id", label_key="work_centre_id"
            )
        if kind == "defects_by_operation":
            return self._group_issues(kind, issues, "operation_id", label_key="operation_id")
        if kind == "open_vs_closed":
            open_count = sum(1 for row in issues if row["status"] in ACTIVE_ISSUE_STATUSES)
            closed_count = sum(1 for row in issues if row["status"] in CLOSED_ISSUE_STATUSES)
            other = len(issues) - open_count - closed_count
            rows = [
                {"key": "open", "label": "Open", "count": open_count, "detail": {}},
                {"key": "closed", "label": "Closed", "count": closed_count, "detail": {}},
            ]
            if other:
                rows.append(
                    {"key": "cancelled", "label": "Cancelled", "count": other, "detail": {}}
                )
            return {
                "kind": kind,
                "rows": rows,
                "total": len(issues),
                "truncated": False,
                "summary": {
                    "open": open_count,
                    "closed": closed_count,
                    "cancelled": other,
                },
            }
        if kind == "repeat_nonconformances":
            result = await self.repeat_issues(principal)
            rows = [
                {
                    "key": group["signature"],
                    "label": group.get("failure_code"),
                    "count": group["occurrences"],
                    "detail": {
                        "issue_ids": group["issue_ids"],
                        "issue_keys": group["issue_keys"],
                        "reason": group["reason"],
                    },
                }
                for group in result["groups"]
            ]
            return {
                "kind": kind,
                "rows": rows,
                "total": result["total"],
                "truncated": result["truncated"],
                "summary": {
                    "groups": len(rows),
                    "window_days": result["window_days"],
                },
            }
        if kind == "capa_effectiveness":
            return await self._capa_effectiveness(principal, kind)
        if kind == "issue_trends":
            return self._issue_trends(kind, issues)
        if kind == "issue_concentration":
            return self._group_issues(
                kind, issues, "component_item_id", label_key="component_item_id",
                severity=True,
            )
        raise ValidationError(
            "unknown quality analytics kind", details={"kind": kind}
        )

    def _group_issues(
        self,
        kind: str,
        issues: list[dict[str, Any]],
        field: str,
        *,
        label_key: str,
        severity: bool = False,
    ) -> dict[str, Any]:
        buckets: dict[Any, list[dict[str, Any]]] = defaultdict(list)
        for row in issues:
            buckets[row.get(field)].append(row)
        rows: list[dict[str, Any]] = []
        for key, members in buckets.items():
            severities = [member.get("severity") for member in members]
            worst = min(
                (value for value in severities if value in _SEVERITY_ORDER),
                key=lambda value: _SEVERITY_ORDER[value],
                default=None,
            )
            detail: dict[str, Any] = {
                "open": sum(
                    1 for member in members if member["status"] in ACTIVE_ISSUE_STATUSES
                ),
                "closed": sum(
                    1 for member in members if member["status"] in CLOSED_ISSUE_STATUSES
                ),
            }
            if severity:
                detail["severity_counts"] = {
                    level: severities.count(level) for level in _SEVERITY_ORDER
                    if severities.count(level)
                }
            rows.append(
                {
                    "key": str(key) if key is not None else "unassigned",
                    "label": str(key) if key is not None else None,
                    "count": len(members),
                    "severity": worst,
                    "detail": detail,
                }
            )
        rows.sort(key=lambda row: row["count"], reverse=True)
        return {
            "kind": kind,
            "rows": rows[:MAX_ANALYTICS_ROWS],
            "total": len(rows),
            "truncated": len(rows) > MAX_ANALYTICS_ROWS,
            "summary": {"issues": len(issues), "groups": len(rows)},
        }

    def _issue_trends(
        self, kind: str, issues: list[dict[str, Any]]
    ) -> dict[str, Any]:
        buckets: dict[str, int] = defaultdict(int)
        missing = 0
        for row in issues:
            detected = _parse_ts(row.get("detected_at")) or _parse_ts(
                row.get("created_at")
            )
            if detected is None:
                missing += 1
                continue
            buckets[detected.strftime("%Y-%m")] += 1
        rows = [
            {"key": month, "label": month, "count": count, "detail": {}}
            for month, count in sorted(buckets.items())
        ]
        return {
            "kind": kind,
            "rows": rows,
            "total": len(rows),
            "truncated": False,
            "summary": {"issues": len(issues), "without_date": missing},
        }

    async def _capa_effectiveness(
        self, principal: Principal, kind: str
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        actions, _ = await self.repository.list_quality_actions(
            tenant_id, quality_issue_id=None, status=None, action_type=None,
            owner_user=None, limit=MAX_ANALYTICS_ROWS, offset=0,
        )
        visible = await self._readable_many(principal, actions)
        now = datetime.now(UTC)
        buckets: dict[str, int] = defaultdict(int)
        overdue: list[dict[str, Any]] = []
        for action in visible:
            buckets[action.get("effectiveness") or "pending"] += 1
            due = _parse_ts(action.get("due_at"))
            if (
                due is not None
                and due < now
                and action.get("status") in OPEN_ACTION_STATUSES
            ):
                overdue.append(action)
        rows = [
            {
                "key": key,
                "label": key,
                "count": count,
                "detail": {},
            }
            for key, count in sorted(buckets.items())
        ]
        return {
            "kind": kind,
            "rows": rows,
            "total": len(visible),
            "truncated": False,
            "summary": {
                "actions": len(visible),
                "open": sum(
                    1 for row in visible if row.get("status") in OPEN_ACTION_STATUSES
                ),
                "overdue": len(overdue),
                "effective": buckets.get("effective", 0),
                "not_effective": buckets.get("not_effective", 0),
                "pending": buckets.get("pending", 0),
            },
        }

    async def repeat_issues(
        self, principal: Principal, *, window_days: int = REPEAT_WINDOW_DAYS_DEFAULT
    ) -> dict[str, Any]:
        issues = await self._visible_issues(principal)
        cutoff = datetime.now(UTC) - timedelta(days=window_days)
        recent: list[dict[str, Any]] = []
        for row in issues:
            detected = _parse_ts(row.get("detected_at")) or _parse_ts(
                row.get("created_at")
            )
            if detected is not None and detected < cutoff:
                continue
            recent.append(row)
        groups: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
        for row in recent:
            signature = (
                row.get("component_item_id"),
                normalise_key(row.get("failure_code") or ""),
                row.get("issue_type"),
            )
            groups[signature].append(row)
        repeat_rows: list[dict[str, Any]] = []
        for (component_item_id, failure_code, issue_type), members in groups.items():
            if len(members) < 2:
                continue
            signature = "|".join(
                [
                    str(component_item_id) if component_item_id is not None else "*",
                    failure_code or "*",
                    issue_type or "*",
                ]
            )
            ordered = sorted(
                members,
                key=lambda row: _parse_ts(row.get("detected_at"))
                or _parse_ts(row.get("created_at"))
                or datetime.min.replace(tzinfo=UTC),
            )
            repeat_rows.append(
                {
                    "signature": signature,
                    "occurrences": len(members),
                    "issue_ids": [row["id"] for row in ordered],
                    "issue_keys": [row.get("issue_key") for row in ordered],
                    "component_item_id": component_item_id,
                    "failure_code": failure_code or None,
                    "reason": (
                        "same component and failure code repeated "
                        f"{len(members)} times within {window_days} days"
                    ),
                }
            )
        repeat_rows.sort(key=lambda row: row["occurrences"], reverse=True)
        total = len(repeat_rows)
        return {
            "groups": repeat_rows[:MAX_REPEAT_GROUPS],
            "total": total,
            "truncated": total > MAX_REPEAT_GROUPS,
            "window_days": window_days,
        }

    async def supplier_quality(
        self, principal: Principal, *, limit: int = MAX_ANALYTICS_ROWS
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issues = await self._visible_issues(principal)
        supplier_issues = await self.repository.list_quality_supplier_issues(
            tenant_id, supplier_ref=None, limit=limit
        )
        buckets: dict[str, dict[str, Any]] = {}

        def _bucket(reference: str) -> dict[str, Any]:
            return buckets.setdefault(
                reference,
                {
                    "supplier_ref": reference,
                    "supplier_name": None,
                    "issue_count": 0,
                    "defect_count": 0,
                    "components": set(),
                    "open_issues": 0,
                    "issue_ids": set(),
                },
            )

        for issue in issues:
            reference = normalise_key(issue.get("supplier_ref") or "")
            if not reference:
                continue
            bucket = _bucket(reference)
            bucket["issue_count"] += 1
            bucket["issue_ids"].add(issue["id"])
            if issue.get("component_item_id") is not None:
                bucket["components"].add(issue["component_item_id"])
            if issue.get("failure_code"):
                bucket["defect_count"] += 1
            if issue["status"] in ACTIVE_ISSUE_STATUSES:
                bucket["open_issues"] += 1
        for record in supplier_issues:
            reference = normalise_key(record.get("supplier_ref") or "")
            if not reference:
                continue
            bucket = _bucket(reference)
            bucket["supplier_name"] = (
                bucket["supplier_name"] or record.get("supplier_name")
            )
            if record.get("component_item_id") is not None:
                bucket["components"].add(record["component_item_id"])
            if record.get("defect_category"):
                bucket["defect_count"] += 1
        rows = [
            {
                "supplier_ref": bucket["supplier_ref"],
                "supplier_name": bucket["supplier_name"],
                "issue_count": bucket["issue_count"],
                "defect_count": bucket["defect_count"],
                "affected_components": len(bucket["components"]),
                "open_issues": bucket["open_issues"],
                "detail": {
                    "component_item_ids": sorted(bucket["components"]),
                    "issue_ids": sorted(bucket["issue_ids"]),
                },
            }
            for bucket in buckets.values()
        ]
        rows.sort(key=lambda row: (row["issue_count"], row["defect_count"]), reverse=True)
        return {
            "rows": rows[:MAX_ANALYTICS_ROWS],
            "total": len(rows),
            "truncated": len(rows) > MAX_ANALYTICS_ROWS,
        }

    # --- Impact ----------------------------------------------------------
    async def impact(
        self, principal: Principal, entity_id: int, *, max_depth: int = 3
    ) -> dict[str, Any]:
        from ai_api.application.services.graph_query_service import GraphQueryService

        tenant_id = require_tenant(principal)
        subject = await self.repository.get_graph_entity(tenant_id, entity_id)
        if subject is None:
            raise NotFoundError("graph entity not found")
        query = GraphQueryService(
            repository=self.repository, graph=self.graph, audit=self.audit
        )
        result = await query.change_impact(principal, entity_id, max_depth=max_depth)
        affected: list[dict[str, Any]] = []
        paths: list[dict[str, Any]] = []
        for item in result["affected"]:
            entity = item["entity"]
            affected.append(
                {
                    "entity_id": entity.get("id"),
                    "entity_type": entity.get("entity_type"),
                    "stable_key": entity.get("stable_key"),
                    "name": entity.get("name"),
                    "impact": item["impact"],
                    "confidence": item.get("confidence", 1.0),
                    "reason": f"{item['impact']} impact via graph",
                    "source_ref": (entity.get("properties") or {}).get("source_ref"),
                    "detail": {"path_length": len(item.get("path") or [])},
                }
            )
            if item.get("path"):
                paths.append(
                    {
                        "nodes": [node.get("stable_key") for node in item["path"]],
                        "relationships": [
                            rel.get("relationship_type")
                            for rel in item.get("relationships", [])
                        ],
                    }
                )
        await self._audit(
            principal, "impact.query", "graph_entity", entity_id,
            {"affected": len(affected)},
        )
        return {
            "entity_id": entity_id,
            "subject": {
                "entity_id": subject["id"],
                "entity_type": subject["entity_type"],
                "stable_key": subject["stable_key"],
                "name": subject.get("name"),
            },
            "affected": affected,
            "paths": paths,
            "inferred": result.get("inferred", False),
            "truncated": result.get("truncated", False),
        }

    # --- Traceability ----------------------------------------------------
    async def traceability(
        self, principal: Principal, issue_id: int
    ) -> dict[str, Any]:
        """Issue -> product/part/process/plant/work instruction traceability."""

        tenant_id = require_tenant(principal)
        issue = await self.get_issue(principal, issue_id)
        product = None
        if issue.get("product_item_id") is not None:
            product = await self.repository.get_product_item(
                tenant_id, issue["product_item_id"]
            )
        component = None
        if issue.get("component_item_id") is not None:
            component = await self.repository.get_product_item(
                tenant_id, issue["component_item_id"]
            )
        process = None
        if issue.get("process_id") is not None:
            process = await self.repository.get_mfg_process(tenant_id, issue["process_id"])
        operation = None
        if issue.get("operation_id") is not None:
            operation = await self.repository.get_mfg_operation(
                tenant_id, issue["operation_id"]
            )
        plant = None
        if issue.get("plant_id") is not None:
            plant = await self.repository.get_mfg_plant(tenant_id, issue["plant_id"])
        work_centre = None
        if issue.get("work_centre_id") is not None:
            work_centre = await self.repository.get_mfg_work_centre(
                tenant_id, issue["work_centre_id"]
            )
        instructions: list[dict[str, Any]] = []
        if operation is not None:
            rows, _ = await self.repository.list_mfg_work_instructions(
                tenant_id, process_id=None, operation_id=operation["id"], query=None,
                lifecycle_status=None, limit=MAX_ANALYTICS_ROWS, offset=0,
            )
            instructions = [
                {
                    "id": row["id"],
                    "instruction_key": row.get("instruction_key"),
                    "title": row.get("title"),
                    "graph_entity_id": row.get("graph_entity_id"),
                }
                for row in rows
            ]
        root_causes = await self.repository.list_quality_root_causes(
            tenant_id, quality_issue_id=issue_id, limit=MAX_ANALYTICS_ROWS
        )
        actions, _ = await self.repository.list_quality_actions(
            tenant_id, quality_issue_id=issue_id, status=None, action_type=None,
            owner_user=None, limit=MAX_ANALYTICS_ROWS, offset=0,
        )
        inspections, _ = await self.repository.list_quality_inspections(
            tenant_id, status=None, inspection_type=None, quality_issue_id=issue_id,
            operation_id=None, query=None, limit=MAX_ANALYTICS_ROWS, offset=0,
        )

        def _summary(record: dict[str, Any] | None, key_field: str) -> dict[str, Any] | None:
            if record is None:
                return None
            return {
                "id": record["id"],
                "key": record.get(key_field),
                "name": record.get("name") or record.get("title"),
                "graph_entity_id": record.get("graph_entity_id"),
            }

        return {
            "issue": {
                "id": issue["id"],
                "issue_key": issue["issue_key"],
                "issue_type": issue["issue_type"],
                "severity": issue["severity"],
                "status": issue["status"],
                "disposition": issue["disposition"],
                "root_cause_status": issue.get("root_cause_status"),
            },
            "product": _summary(product, "item_key"),
            "component": _summary(component, "item_key"),
            "process": _summary(process, "process_key"),
            "operation": _summary(operation, "operation_key"),
            "plant": _summary(plant, "plant_key"),
            "work_centre": _summary(work_centre, "work_centre_key"),
            "work_instructions": instructions,
            "root_causes": root_causes,
            "actions": actions,
            "inspections": [
                {
                    "id": row["id"],
                    "inspection_key": row["inspection_key"],
                    "status": row["status"],
                }
                for row in inspections
            ],
            "status": "ok",
        }

    # --- Statistics ------------------------------------------------------
    async def stats(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        issues = await self._visible_issues(principal)
        inspections, _ = await self.repository.list_quality_inspections(
            tenant_id, status=None, inspection_type=None, quality_issue_id=None,
            operation_id=None, query=None, limit=MAX_ANALYTICS_ROWS, offset=0,
        )
        visible_inspections = await self._readable_many(principal, inspections)
        actions, total_actions = await self.repository.list_quality_actions(
            tenant_id, quality_issue_id=None, status=None, action_type=None,
            owner_user=None, limit=MAX_ANALYTICS_ROWS, offset=0,
        )
        visible_actions = await self._readable_many(principal, actions)
        supplier_issues = await self.repository.list_quality_supplier_issues(
            tenant_id, supplier_ref=None, limit=MAX_ANALYTICS_ROWS
        )
        now = datetime.now(UTC)
        overdue = 0
        for action in visible_actions:
            due = _parse_ts(action.get("due_at"))
            if (
                due is not None
                and due < now
                and action.get("status") in OPEN_ACTION_STATUSES
            ):
                overdue += 1
        return {
            "issues": len(issues),
            "open_issues": sum(1 for row in issues if row["status"] in ACTIVE_ISSUE_STATUSES),
            "critical_issues": sum(
                1 for row in issues if row.get("severity") == "critical"
            ),
            "inspections": len(visible_inspections),
            "failed_inspections": sum(
                1 for row in visible_inspections if row.get("status") == "failed"
            ),
            "actions": total_actions,
            "overdue_actions": overdue,
            "effective_actions": sum(
                1 for row in visible_actions if row.get("effectiveness") == "effective"
            ),
            "supplier_issues": len(supplier_issues),
            "status": "ok",
        }
