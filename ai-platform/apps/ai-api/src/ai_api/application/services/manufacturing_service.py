"""Manufacturing process intelligence (Stage 9 / Step 7).

Owns the manufacturing *domain* records: plants, production lines, work centres,
processes/revisions, operations, operation sequencing/dependencies, operation
consumption, work instructions, tooling/resources and production versions.

The domain rows are the system of record; each row may point at a knowledge graph
entity through `graph_entity_id` so traversal/impact keep working, but the graph
is never duplicated. Authorization mirrors the product/BOM services: every read
checks the tenant classification ceiling and the record ACL, and unauthorized
records surface as `NotFoundError` so their existence is not leaked.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.product_service import ProductService
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.domain.manufacturing import (
    CONSUMPTION_TYPES,
    DEPENDENCY_TYPES,
    GRAPH_TYPE_BY_KIND,
    INSTRUCTION_TYPES,
    MAX_INTELLIGENCE_ROWS,
    MAX_OPERATIONS,
    OPERATION_TYPES,
    PROCESS_LIFECYCLE_STATES,
    PROCESS_LIFECYCLE_TRANSITIONS,
    PROCESS_TYPES,
    RESOURCE_KINDS,
    STRUCTURE_LIFECYCLE_STATES,
    STRUCTURE_LIFECYCLE_TRANSITIONS,
    WORK_CENTRE_TYPES,
    is_transition_allowed,
    normalise_choice,
    normalise_key,
    normalise_process_key,
    normalise_revision,
    operation_sort_key,
)
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("manufacturing")

_ZERO = 0
_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


def _require_choice(value: str, allowed: tuple[str, ...], field: str) -> str:
    text = normalise_choice(value)
    if text not in allowed:
        raise ValidationError(
            f"invalid {field}", details={"field": field, "allowed": list(allowed)}
        )
    return text


def _require_lifecycle(value: str, allowed: tuple[str, ...], field: str) -> str:
    return _require_choice(value, allowed, field)


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class ManufacturingService:
    def __init__(
        self,
        repository: AiRepository,
        products: ProductService,
        audit: AuditService,
        access: AccessControl,
        governance: GovernanceService,
        graph: GraphService,
        events: EventPublisher | None = None,
    ) -> None:
        self.repository = repository
        self.products = products
        self.audit = audit
        self.access = access
        self.governance = governance
        self.graph = graph
        self.events = events

    # --- Authorization helpers -----------------------------------------
    async def _readable(self, principal: Principal, record: dict[str, Any]) -> bool:
        if record.get("lifecycle_status") == "archived" or record.get("deleted_at"):
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
            if not (
                record.get("lifecycle_status") == "archived"
                or record.get("deleted_at")
            )
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
                        in (
                            "active", "inactive", "draft", "released",
                            "obsolete", "stale", "archived",
                        )
                        else "active"
                    ),
                    properties=properties,
                    source_system="ai.manufacturing",
                ),
            )
            return int(entity["id"])
        except Exception as exc:  # noqa: BLE001 - graph is navigation only
            logger.warning("manufacturing.graph_link_failed", error=str(exc))
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
                    source_system="ai.manufacturing",
                ),
            )
        except Exception as exc:  # noqa: BLE001 - navigation only
            logger.warning("manufacturing.graph_relationship_failed", error=str(exc))

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
            logger.warning("manufacturing.event_publish_failed", error=str(exc))

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
            action=f"ai.manufacturing.{action}",
            resource_type=resource_type,
            resource_id=str(resource_id),
            detail=detail or {},
        )

    # --- Plants ---------------------------------------------------------
    async def upsert_plant(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        plant_key = normalise_process_key(payload.plant_key)
        if not plant_key:
            raise ValidationError("plant_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "active",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        existing = await self.repository.get_mfg_plant_by_key(tenant_id, plant_key)
        if existing is not None:
            await self._require_readable(principal, existing, "plant")
        graph_entity_id = await self._link_entity(
            principal,
            kind="plant",
            stable_key=f"PLANT:{plant_key}",
            name=payload.name or plant_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"plant_key": plant_key},
        )
        data = {
            "plant_key": plant_key,
            "name": payload.name,
            "description": payload.description,
            "site_code": payload.site_code,
            "country": payload.country,
            "timezone": payload.timezone,
            "lifecycle_status": lifecycle,
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
        plant = await self.repository.upsert_mfg_plant(tenant_id, data)
        await self._audit(
            principal,
            "plant.upsert",
            "mfg_plant",
            plant["id"],
            {"plant_key": plant_key, "created": existing is None},
        )
        await self._emit(
            "ManufacturingStructureChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="mfg_plant",
            data={
                "kind": "plant",
                "entity_id": plant["id"],
                "key": plant_key,
                "created": existing is None,
            },
        )
        return plant

    async def get_plant(self, principal: Principal, plant_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        plant = await self.repository.get_mfg_plant(tenant_id, plant_id)
        return await self._require_readable(principal, plant, "plant")

    async def list_plants(
        self,
        principal: Principal,
        *,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_plants(
            tenant_id,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        visible = await self._readable_many(principal, rows)
        return visible, total

    async def update_plant(
        self, principal: Principal, plant_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        plant = await self.get_plant(principal, plant_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, plant["lifecycle_status"], target
            ):
                raise ValidationError(
                    "illegal lifecycle transition",
                    details={"from": plant["lifecycle_status"], "to": target},
                )
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_plant(tenant_id, plant_id, fields)
        updated = await self._require_readable(principal, updated, "plant")
        await self._audit(
            principal, "plant.update", "mfg_plant", plant_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Production lines ----------------------------------------------
    async def upsert_line(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        plant = await self.get_plant(principal, payload.plant_id)
        line_key = normalise_process_key(payload.line_key)
        if not line_key:
            raise ValidationError("line_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "active",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        existing = await self.repository.get_mfg_line_by_key(
            tenant_id, plant["id"], line_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "production line")
        graph_entity_id = await self._link_entity(
            principal,
            kind="line",
            stable_key=f"LINE:{plant['plant_key']}:{line_key}",
            name=payload.name or line_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"line_key": line_key, "plant_id": plant["id"]},
        )
        data = {
            "plant_id": plant["id"],
            "line_key": line_key,
            "name": payload.name,
            "description": payload.description,
            "lifecycle_status": lifecycle,
            "capacity_per_hour": payload.capacity_per_hour,
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
        line = await self.repository.upsert_mfg_line(tenant_id, data)
        await self._audit(principal, "line.upsert", "mfg_line", line["id"])
        return line

    async def get_line(self, principal: Principal, line_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        line = await self.repository.get_mfg_line(tenant_id, line_id)
        return await self._require_readable(principal, line, "production line")

    async def list_lines(
        self,
        principal: Principal,
        *,
        plant_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_lines(
            tenant_id,
            plant_id=plant_id,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_line(
        self, principal: Principal, line_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        line = await self.get_line(principal, line_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, line["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_line(tenant_id, line_id, fields)
        updated = await self._require_readable(principal, updated, "production line")
        await self._audit(
            principal, "line.update", "mfg_line", line_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Work centres ---------------------------------------------------
    async def upsert_work_centre(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        plant = await self.get_plant(principal, payload.plant_id)
        if payload.line_id is not None:
            line = await self.get_line(principal, payload.line_id)
            if line["plant_id"] != plant["id"]:
                raise ValidationError("production line does not belong to the plant")
        work_centre_key = normalise_process_key(payload.work_centre_key)
        if not work_centre_key:
            raise ValidationError("work_centre_key must not be empty")
        wc_type = _require_choice(
            payload.work_centre_type or "other", WORK_CENTRE_TYPES, "work_centre_type"
        )
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "active",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        existing = await self.repository.get_mfg_work_centre_by_key(
            tenant_id, plant["id"], work_centre_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "work centre")
        graph_entity_id = await self._link_entity(
            principal,
            kind="work_centre",
            stable_key=f"WC:{plant['plant_key']}:{work_centre_key}",
            name=payload.name or work_centre_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"work_centre_key": work_centre_key, "plant_id": plant["id"]},
        )
        data = {
            "plant_id": plant["id"],
            "line_id": payload.line_id,
            "work_centre_key": work_centre_key,
            "name": payload.name,
            "description": payload.description,
            "work_centre_type": wc_type,
            "lifecycle_status": lifecycle,
            "capacity_per_hour": payload.capacity_per_hour,
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
        wc = await self.repository.upsert_mfg_work_centre(tenant_id, data)
        await self._audit(principal, "work_centre.upsert", "mfg_work_centre", wc["id"])
        return wc

    async def get_work_centre(
        self, principal: Principal, work_centre_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        wc = await self.repository.get_mfg_work_centre(tenant_id, work_centre_id)
        return await self._require_readable(principal, wc, "work centre")

    async def list_work_centres(
        self,
        principal: Principal,
        *,
        plant_id: int | None,
        line_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_work_centres(
            tenant_id,
            plant_id=plant_id,
            line_id=line_id,
            query=query,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_work_centre(
        self, principal: Principal, work_centre_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        wc = await self.get_work_centre(principal, work_centre_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, wc["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        if fields.get("work_centre_type") is not None:
            fields["work_centre_type"] = _require_choice(
                fields["work_centre_type"], WORK_CENTRE_TYPES, "work_centre_type"
            )
        if fields.get("line_id") is not None:
            line = await self.get_line(principal, fields["line_id"])
            if line["plant_id"] != wc["plant_id"]:
                raise ValidationError("production line does not belong to the plant")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_work_centre(
            tenant_id, work_centre_id, fields
        )
        updated = await self._require_readable(principal, updated, "work centre")
        await self._audit(
            principal, "work_centre.update", "mfg_work_centre", work_centre_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Processes ------------------------------------------------------
    async def upsert_process(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process_type = _require_choice(
            payload.process_type or "assembly", PROCESS_TYPES, "process_type"
        )
        process_key = normalise_process_key(payload.process_key)
        if not process_key:
            raise ValidationError("process_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft",
            PROCESS_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        if payload.root_item_id is not None:
            await self.products.get_item(principal, payload.root_item_id)
        if payload.root_revision_id is not None:
            revision = await self.products.get_revision(
                principal, payload.root_revision_id
            )
            if (
                payload.root_item_id is not None
                and revision["item_id"] != payload.root_item_id
            ):
                raise ValidationError("root revision does not belong to the root item")
        if payload.mbom_header_id is not None:
            header = await self.products.get_header(principal, payload.mbom_header_id)
            if header["bom_type"] != "MBOM":
                raise ValidationError("mbom_header_id must reference an MBOM header")
        if payload.plant_id is not None:
            await self.get_plant(principal, payload.plant_id)
        if payload.line_id is not None:
            await self.get_line(principal, payload.line_id)
        existing = await self.repository.get_mfg_process_by_key(
            tenant_id, process_type, process_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "manufacturing process")
        graph_entity_id = await self._link_entity(
            principal,
            kind="process",
            stable_key=f"PROCESS:{process_type}:{process_key}",
            name=payload.name or process_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"process_type": process_type, "process_key": process_key},
        )
        if graph_entity_id is not None and payload.root_item_id is not None:
            root_item = await self.repository.get_product_item(
                tenant_id, payload.root_item_id
            )
            if root_item and root_item.get("graph_entity_id"):
                await self._link_relationship(
                    principal, "references", root_item["graph_entity_id"], graph_entity_id
                )
        if graph_entity_id is not None and payload.plant_id is not None:
            plant = await self.repository.get_mfg_plant(tenant_id, payload.plant_id)
            if plant and plant.get("graph_entity_id"):
                await self._link_relationship(
                    principal, "manufactured_at", graph_entity_id, plant["graph_entity_id"]
                )
        data = {
            "process_type": process_type,
            "process_key": process_key,
            "name": payload.name,
            "description": payload.description,
            "root_item_id": payload.root_item_id,
            "root_revision_id": payload.root_revision_id,
            "mbom_header_id": payload.mbom_header_id,
            "plant_id": payload.plant_id,
            "line_id": payload.line_id,
            "revision": normalise_revision(payload.revision or "A"),
            "lifecycle_status": lifecycle,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "configuration": payload.configuration,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        process = await self.repository.upsert_mfg_process(tenant_id, data)
        await self._audit(
            principal,
            "process.upsert",
            "mfg_process",
            process["id"],
            {"process_key": process_key, "created": existing is None},
        )
        await self._emit(
            "ManufacturingProcessChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="mfg_process",
            data={
                "process_id": process["id"],
                "process_key": process_key,
                "created": existing is None,
            },
        )
        return process

    async def get_process(
        self, principal: Principal, process_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.repository.get_mfg_process(tenant_id, process_id)
        return await self._require_readable(principal, process, "manufacturing process")

    async def list_processes(
        self,
        principal: Principal,
        *,
        process_type: str | None,
        root_item_id: int | None,
        mbom_header_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        normalized = None
        if process_type:
            normalized = _require_choice(process_type, PROCESS_TYPES, "process_type")
        rows, total = await self.repository.list_mfg_processes(
            tenant_id,
            process_type=normalized,
            root_item_id=root_item_id,
            mbom_header_id=mbom_header_id,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_process(
        self, principal: Principal, process_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"],
                PROCESS_LIFECYCLE_STATES,
                "lifecycle_status",
            )
            if not is_transition_allowed(
                PROCESS_LIFECYCLE_TRANSITIONS, process["lifecycle_status"], target
            ):
                raise ValidationError(
                    "illegal lifecycle transition",
                    details={"from": process["lifecycle_status"], "to": target},
                )
            fields["lifecycle_status"] = target
        if fields.get("mbom_header_id") is not None:
            header = await self.products.get_header(
                principal, fields["mbom_header_id"]
            )
            if header["bom_type"] != "MBOM":
                raise ValidationError("mbom_header_id must reference an MBOM header")
        if fields.get("root_revision_id") is not None:
            revision = await self.products.get_revision(
                principal, fields["root_revision_id"]
            )
            root_item_id = fields.get("root_item_id", process.get("root_item_id"))
            if root_item_id is not None and revision["item_id"] != root_item_id:
                raise ValidationError("root revision does not belong to the root item")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_process(
            tenant_id, process_id, fields
        )
        updated = await self._require_readable(
            principal, updated, "manufacturing process"
        )
        await self._audit(
            principal, "process.update", "mfg_process", process_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Process revisions ---------------------------------------------
    async def upsert_process_revision(
        self, principal: Principal, process_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        revision = normalise_revision(payload.revision)
        if not revision:
            raise ValidationError("revision must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft",
            PROCESS_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        data = {
            "process_id": process["id"],
            "revision": revision,
            "lifecycle_status": lifecycle,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "change_reason": payload.change_reason,
            "configuration": payload.configuration,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        row = await self.repository.upsert_mfg_process_revision(tenant_id, data)
        await self._audit(
            principal, "process_revision.upsert", "mfg_process_revision", row["id"],
            {"process_id": process_id, "revision": revision},
        )
        return row

    async def get_process_revision(
        self, principal: Principal, revision_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.repository.get_mfg_process_revision(tenant_id, revision_id)
        return await self._require_readable(principal, row, "process revision")

    async def list_process_revisions(
        self,
        principal: Principal,
        *,
        process_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_process_revisions(
            tenant_id, process_id=process_id, limit=limit, offset=offset
        )
        return await self._readable_many(principal, rows), total

    async def update_process_revision(
        self, principal: Principal, revision_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.get_process_revision(principal, revision_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"],
                PROCESS_LIFECYCLE_STATES,
                "lifecycle_status",
            )
            if not is_transition_allowed(
                PROCESS_LIFECYCLE_TRANSITIONS, row["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_process_revision(
            tenant_id, revision_id, fields
        )
        updated = await self._require_readable(principal, updated, "process revision")
        await self._audit(
            principal, "process_revision.update", "mfg_process_revision", revision_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Operations -----------------------------------------------------
    async def upsert_operation(
        self, principal: Principal, process_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        operation_key = normalise_process_key(payload.operation_key)
        if not operation_key:
            raise ValidationError("operation_key must not be empty")
        op_type = _require_choice(
            payload.operation_type or "value_add", OPERATION_TYPES, "operation_type"
        )
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        if payload.process_revision_id is not None:
            revision = await self.get_process_revision(
                principal, payload.process_revision_id
            )
            if revision["process_id"] != process["id"]:
                raise ValidationError("process revision does not belong to the process")
        if payload.work_centre_id is not None:
            wc = await self.get_work_centre(principal, payload.work_centre_id)
            plant_id = payload.plant_id or process.get("plant_id")
            if plant_id is not None and wc["plant_id"] != plant_id:
                raise ValidationError("work centre does not belong to the plant")
        if payload.plant_id is not None:
            await self.get_plant(principal, payload.plant_id)
        existing = await self.repository.get_mfg_operation_by_key(
            tenant_id, process["id"], operation_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "operation")
        graph_entity_id = await self._link_entity(
            principal,
            kind="operation",
            stable_key=f"OP:{process['process_key']}:{operation_key}",
            name=payload.name or operation_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={
                "operation_key": operation_key,
                "process_id": process["id"],
                "sequence": int(payload.sequence or 0),
            },
        )
        if graph_entity_id is not None and process.get("graph_entity_id"):
            await self._link_relationship(
                principal, "process_contains", process["graph_entity_id"], graph_entity_id
            )
        data = {
            "process_id": process["id"],
            "process_revision_id": payload.process_revision_id,
            "operation_key": operation_key,
            "name": payload.name,
            "description": payload.description,
            "operation_type": op_type,
            "sequence": int(payload.sequence or 0),
            "work_centre_id": payload.work_centre_id,
            "plant_id": payload.plant_id,
            "setup_minutes": payload.setup_minutes,
            "cycle_minutes": payload.cycle_minutes,
            "lifecycle_status": lifecycle,
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
        operation = await self.repository.upsert_mfg_operation(tenant_id, data)
        await self._audit(
            principal, "operation.upsert", "mfg_operation", operation["id"],
            {"process_id": process_id, "operation_key": operation_key},
        )
        await self._emit(
            "ManufacturingOperationChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="mfg_operation",
            data={
                "process_id": process_id,
                "operation_id": operation["id"],
                "operation_key": operation_key,
                "created": existing is None,
            },
        )
        return operation

    async def get_operation(
        self, principal: Principal, operation_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.repository.get_mfg_operation(tenant_id, operation_id)
        return await self._require_readable(principal, row, "operation")

    async def list_operations(
        self,
        principal: Principal,
        *,
        process_id: int | None,
        work_centre_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_operations(
            tenant_id,
            process_id=process_id,
            work_centre_id=work_centre_id,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_operation(
        self, principal: Principal, operation_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        operation = await self.get_operation(principal, operation_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, operation["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        if fields.get("operation_type") is not None:
            fields["operation_type"] = _require_choice(
                fields["operation_type"], OPERATION_TYPES, "operation_type"
            )
        if fields.get("process_revision_id") is not None:
            revision = await self.get_process_revision(
                principal, fields["process_revision_id"]
            )
            if revision["process_id"] != operation["process_id"]:
                raise ValidationError("process revision does not belong to the process")
        if fields.get("work_centre_id") is not None:
            wc = await self.get_work_centre(principal, fields["work_centre_id"])
            plant_id = fields.get("plant_id", operation.get("plant_id"))
            if plant_id is not None and wc["plant_id"] != plant_id:
                raise ValidationError("work centre does not belong to the plant")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_operation(
            tenant_id, operation_id, fields
        )
        updated = await self._require_readable(principal, updated, "operation")
        await self._audit(
            principal, "operation.update", "mfg_operation", operation_id,
            {"fields": sorted(fields), "reason": reason},
        )
        await self._emit(
            "ManufacturingOperationChanged",
            tenant_id=tenant_id,
            principal=principal,
            subject_type="mfg_operation",
            data={
                "process_id": operation["process_id"],
                "operation_id": operation_id,
                "operation_key": operation["operation_key"],
                "created": False,
            },
        )
        return updated

    # --- Operation sequencing / dependencies ---------------------------
    async def add_dependency(
        self, principal: Principal, process_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        operation = await self.get_operation(principal, payload.operation_id)
        depends_on = await self.get_operation(
            principal, payload.depends_on_operation_id
        )
        if operation["process_id"] != process["id"]:
            raise ValidationError("operation does not belong to the process")
        if depends_on["process_id"] != process["id"]:
            raise ValidationError("depends_on operation does not belong to the process")
        if operation["id"] == depends_on["id"]:
            raise ValidationError("an operation cannot depend on itself")
        dependency_type = _require_choice(
            payload.dependency_type or "finish_to_start",
            DEPENDENCY_TYPES,
            "dependency_type",
        )
        row = await self.repository.add_mfg_operation_dependency(
            tenant_id,
            {
                "process_id": process["id"],
                "operation_id": operation["id"],
                "depends_on_operation_id": depends_on["id"],
                "dependency_type": dependency_type,
                "lag_minutes": payload.lag_minutes,
            },
        )
        await self._audit(
            principal, "operation_dependency.add", "mfg_operation", operation["id"],
            {"depends_on": depends_on["id"], "type": dependency_type},
        )
        return row

    async def list_dependencies(
        self, principal: Principal, process_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.get_process(principal, process_id)
        return await self.repository.list_mfg_operation_dependencies(
            tenant_id, process_id=process_id
        )

    async def delete_dependency(
        self, principal: Principal, dependency_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        deleted = await self.repository.delete_mfg_operation_dependency(
            tenant_id, dependency_id
        )
        if not deleted:
            raise NotFoundError("operation dependency not found")
        await self._audit(
            principal, "operation_dependency.delete", "mfg_operation_dependency",
            dependency_id,
        )
        return {"id": dependency_id, "deleted": True}

    # --- Operation consumption -----------------------------------------
    async def add_consumption(
        self, principal: Principal, operation_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        operation = await self.get_operation(principal, operation_id)
        await self.products.get_item(principal, payload.child_item_id)
        if payload.bom_line_id is not None:
            line = await self.products.get_line(principal, payload.bom_line_id)
            if line["child_item_id"] != payload.child_item_id:
                raise ValidationError("BOM line does not reference the consumed item")
        consumption_type = _require_choice(
            payload.consumption_type or "component",
            CONSUMPTION_TYPES,
            "consumption_type",
        )
        row = await self.repository.add_mfg_operation_consumption(
            tenant_id,
            {
                "operation_id": operation["id"],
                "child_item_id": payload.child_item_id,
                "bom_line_id": payload.bom_line_id,
                "quantity": payload.quantity,
                "unit_of_measure": payload.unit_of_measure,
                "consumption_type": consumption_type,
                "notes": payload.notes,
                "external_id": payload.external_id,
                "source_system": payload.source_system,
                "source_ref": payload.source_ref,
                "created_by": principal.username,
            },
        )
        await self._audit(
            principal, "operation_consumption.add", "mfg_operation_consumption",
            row["id"],
            {"operation_id": operation_id, "child_item_id": payload.child_item_id},
        )
        return row

    async def list_consumptions(
        self,
        principal: Principal,
        *,
        operation_id: int | None,
        child_item_id: int | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_mfg_operation_consumptions(
            tenant_id,
            operation_id=operation_id,
            child_item_id=child_item_id,
            limit=limit,
        )

    async def delete_consumption(
        self, principal: Principal, consumption_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        deleted = await self.repository.delete_mfg_operation_consumption(
            tenant_id, consumption_id
        )
        if deleted is None:
            raise NotFoundError("operation consumption not found")
        await self._audit(
            principal, "operation_consumption.delete", "mfg_operation_consumption",
            consumption_id,
        )
        return deleted

    # --- Work instructions ---------------------------------------------
    async def upsert_instruction(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, payload.process_id)
        if payload.operation_id is not None:
            operation = await self.get_operation(principal, payload.operation_id)
            if operation["process_id"] != process["id"]:
                raise ValidationError("operation does not belong to the process")
        instruction_key = normalise_process_key(payload.instruction_key)
        if not instruction_key:
            raise ValidationError("instruction_key must not be empty")
        instruction_type = _require_choice(
            payload.instruction_type or "text", INSTRUCTION_TYPES, "instruction_type"
        )
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft",
            PROCESS_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        existing = await self.repository.get_mfg_work_instruction_by_key(
            tenant_id, instruction_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "work instruction")
        graph_entity_id = await self._link_entity(
            principal,
            kind="instruction",
            stable_key=f"WI:{instruction_key}",
            name=payload.title or instruction_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={
                "instruction_key": instruction_key,
                "process_id": process["id"],
            },
        )
        if graph_entity_id is not None and payload.operation_id is not None:
            operation = await self.repository.get_mfg_operation(
                tenant_id, payload.operation_id
            )
            if operation and operation.get("graph_entity_id"):
                await self._link_relationship(
                    principal, "uses_instruction", operation["graph_entity_id"],
                    graph_entity_id,
                )
        data = {
            "process_id": process["id"],
            "operation_id": payload.operation_id,
            "instruction_key": instruction_key,
            "title": payload.title,
            "description": payload.description,
            "instruction_type": instruction_type,
            "revision": normalise_revision(payload.revision or "A"),
            "lifecycle_status": lifecycle,
            "document_ref": payload.document_ref,
            "steps": payload.steps,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        row = await self.repository.upsert_mfg_work_instruction(tenant_id, data)
        await self._audit(
            principal, "work_instruction.upsert", "mfg_work_instruction", row["id"],
            {"instruction_key": instruction_key, "created": existing is None},
        )
        return row

    async def get_instruction(
        self, principal: Principal, instruction_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.repository.get_mfg_work_instruction(
            tenant_id, instruction_id
        )
        return await self._require_readable(principal, row, "work instruction")

    async def list_instructions(
        self,
        principal: Principal,
        *,
        process_id: int | None,
        operation_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_work_instructions(
            tenant_id,
            process_id=process_id,
            operation_id=operation_id,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_instruction(
        self, principal: Principal, instruction_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.get_instruction(principal, instruction_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"],
                PROCESS_LIFECYCLE_STATES,
                "lifecycle_status",
            )
            if not is_transition_allowed(
                PROCESS_LIFECYCLE_TRANSITIONS, row["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        if fields.get("instruction_type") is not None:
            fields["instruction_type"] = _require_choice(
                fields["instruction_type"], INSTRUCTION_TYPES, "instruction_type"
            )
        if fields.get("operation_id") is not None:
            operation = await self.get_operation(principal, fields["operation_id"])
            if operation["process_id"] != row["process_id"]:
                raise ValidationError("operation does not belong to the process")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_work_instruction(
            tenant_id, instruction_id, fields
        )
        updated = await self._require_readable(principal, updated, "work instruction")
        await self._audit(
            principal, "work_instruction.update", "mfg_work_instruction",
            instruction_id, {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Resources ------------------------------------------------------
    async def upsert_resource(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        resource_key = normalise_process_key(payload.resource_key)
        if not resource_key:
            raise ValidationError("resource_key must not be empty")
        resource_kind = _require_choice(
            payload.resource_kind or "tooling", RESOURCE_KINDS, "resource_kind"
        )
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "active",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        if payload.plant_id is not None:
            await self.get_plant(principal, payload.plant_id)
        if payload.work_centre_id is not None:
            await self.get_work_centre(principal, payload.work_centre_id)
        existing = await self.repository.get_mfg_resource_by_key(
            tenant_id, resource_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "resource")
        graph_entity_id = await self._link_entity(
            principal,
            kind="resource",
            stable_key=f"RES:{resource_key}",
            name=payload.name or resource_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"resource_key": resource_key, "resource_kind": resource_kind},
        )
        data = {
            "resource_key": resource_key,
            "name": payload.name,
            "description": payload.description,
            "resource_kind": resource_kind,
            "plant_id": payload.plant_id,
            "work_centre_id": payload.work_centre_id,
            "lifecycle_status": lifecycle,
            "calibration_due": payload.calibration_due,
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
        row = await self.repository.upsert_mfg_resource(tenant_id, data)
        await self._audit(
            principal, "resource.upsert", "mfg_resource", row["id"],
            {"resource_key": resource_key, "created": existing is None},
        )
        return row

    async def get_resource(
        self, principal: Principal, resource_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.repository.get_mfg_resource(tenant_id, resource_id)
        return await self._require_readable(principal, row, "resource")

    async def list_resources(
        self,
        principal: Principal,
        *,
        resource_kind: str | None,
        plant_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        normalized = None
        if resource_kind:
            normalized = _require_choice(
                resource_kind, RESOURCE_KINDS, "resource_kind"
            )
        rows, total = await self.repository.list_mfg_resources(
            tenant_id,
            resource_kind=normalized,
            plant_id=plant_id,
            query=query,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_resource(
        self, principal: Principal, resource_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.get_resource(principal, resource_id)
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, row["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        if fields.get("resource_kind") is not None:
            fields["resource_kind"] = _require_choice(
                fields["resource_kind"], RESOURCE_KINDS, "resource_kind"
            )
        if fields.get("plant_id") is not None:
            await self.get_plant(principal, fields["plant_id"])
        if fields.get("work_centre_id") is not None:
            await self.get_work_centre(principal, fields["work_centre_id"])
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_resource(
            tenant_id, resource_id, fields
        )
        updated = await self._require_readable(principal, updated, "resource")
        await self._audit(
            principal, "resource.update", "mfg_resource", resource_id,
            {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Production versions -------------------------------------------
    async def upsert_production_version(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.products.get_item(principal, payload.item_id)
        if payload.process_id is not None:
            process = await self.get_process(principal, payload.process_id)
            if process.get("root_item_id") not in (None, payload.item_id):
                raise ValidationError("process does not target the product item")
        if payload.mbom_header_id is not None:
            header = await self.products.get_header(
                principal, payload.mbom_header_id
            )
            if header["bom_type"] != "MBOM":
                raise ValidationError("mbom_header_id must reference an MBOM header")
        if payload.plant_id is not None:
            await self.get_plant(principal, payload.plant_id)
        version_key = normalise_key(payload.version_key)
        if not version_key:
            raise ValidationError("version_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft",
            STRUCTURE_LIFECYCLE_STATES,
            "lifecycle_status",
        )
        existing = await self.repository.get_mfg_production_version_by_key(
            tenant_id, payload.item_id, version_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "production version")
        graph_entity_id = await self._link_entity(
            principal,
            kind="production_version",
            stable_key=f"PV:{payload.item_id}:{version_key}",
            name=payload.name or version_key,
            description=None,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"version_key": version_key, "item_id": payload.item_id},
        )
        data = {
            "item_id": payload.item_id,
            "process_id": payload.process_id,
            "mbom_header_id": payload.mbom_header_id,
            "version_key": version_key,
            "name": payload.name,
            "lifecycle_status": lifecycle,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "plant_id": payload.plant_id,
            "configuration": payload.configuration,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        row = await self.repository.upsert_mfg_production_version(tenant_id, data)
        await self._audit(
            principal, "production_version.upsert", "mfg_production_version",
            row["id"], {"item_id": payload.item_id, "version_key": version_key},
        )
        return row

    async def get_production_version(
        self, principal: Principal, production_version_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.repository.get_mfg_production_version(
            tenant_id, production_version_id
        )
        return await self._require_readable(principal, row, "production version")

    async def list_production_versions(
        self,
        principal: Principal,
        *,
        item_id: int | None,
        process_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        rows, total = await self.repository.list_mfg_production_versions(
            tenant_id,
            item_id=item_id,
            process_id=process_id,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        return await self._readable_many(principal, rows), total

    async def update_production_version(
        self, principal: Principal, production_version_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        row = await self.get_production_version(
            principal, production_version_id
        )
        fields = payload.model_dump(exclude_unset=True)
        reason = fields.pop("change_reason", None)
        if fields.get("lifecycle_status") is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], STRUCTURE_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                STRUCTURE_LIFECYCLE_TRANSITIONS, row["lifecycle_status"], target
            ):
                raise ValidationError("illegal lifecycle transition")
            fields["lifecycle_status"] = target
        if fields.get("mbom_header_id") is not None:
            header = await self.products.get_header(
                principal, fields["mbom_header_id"]
            )
            if header["bom_type"] != "MBOM":
                raise ValidationError("mbom_header_id must reference an MBOM header")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_mfg_production_version(
            tenant_id, production_version_id, fields
        )
        updated = await self._require_readable(
            principal, updated, "production version"
        )
        await self._audit(
            principal, "production_version.update", "mfg_production_version",
            production_version_id, {"fields": sorted(fields), "reason": reason},
        )
        return updated

    # --- Process structure / traversal ---------------------------------
    async def structure(
        self,
        principal: Principal,
        process_id: int,
        *,
        max_depth: int = 5,
        limit: int = MAX_OPERATIONS,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        operations = await self.repository.list_mfg_operations_by_process(
            tenant_id, process["id"]
        )
        visible = [
            operation
            for operation in operations
            if await self._readable(principal, operation)
        ]
        cap = max(1, min(int(limit), MAX_OPERATIONS))
        truncated = len(visible) > cap
        visible = visible[:cap]
        operation_ids = [operation["id"] for operation in visible]
        dependencies = await self.repository.list_mfg_dependencies_for_operators(
            tenant_id, operation_ids
        )
        depends_map: dict[int, list[int]] = defaultdict(list)
        for dependency in dependencies:
            depends_map[dependency["operation_id"]].append(
                dependency["depends_on_operation_id"]
            )
        instructions = await self.repository.list_mfg_work_instructions(
            tenant_id,
            process_id=process["id"],
            operation_id=None,
            query=None,
            lifecycle_status=None,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        instruction_counts: dict[int, int] = defaultdict(int)
        instruction_rows, _ = instructions
        for instruction in instruction_rows:
            if instruction.get("operation_id"):
                instruction_counts[instruction["operation_id"]] += 1
        consumptions = await self.repository.list_mfg_operation_consumptions(
            tenant_id, operation_id=None, child_item_id=None, limit=MAX_INTELLIGENCE_ROWS
        )
        consumption_counts: dict[int, int] = defaultdict(int)
        for consumption in consumptions:
            consumption_counts[consumption["operation_id"]] += 1

        rows: list[dict[str, Any]] = []
        seen: set[int] = set()
        cycle_detected = False

        def _row(operation: dict[str, Any], depth: int, path: list[int]) -> dict[str, Any]:
            return {
                "operation_id": operation["id"],
                "operation_key": operation["operation_key"],
                "name": operation.get("name"),
                "operation_type": operation.get("operation_type", "value_add"),
                "sequence": int(operation.get("sequence") or 0),
                "work_centre_id": operation.get("work_centre_id"),
                "plant_id": operation.get("plant_id"),
                "depth": depth,
                "path": list(path),
                "instruction_count": instruction_counts.get(operation["id"], 0),
                "consumption_count": consumption_counts.get(operation["id"], 0),
                "depends_on": depends_map.get(operation["id"], []),
                "has_instruction": instruction_counts.get(operation["id"], 0) > 0,
            }

        ordered = sorted(visible, key=operation_sort_key)
        depth_cap = max(1, min(int(max_depth), len(visible) or 1))

        def walk(operation: dict[str, Any], depth: int, path: list[int]) -> None:
            nonlocal cycle_detected
            if operation["id"] in path:
                cycle_detected = True
                return
            if operation["id"] in seen or len(rows) >= cap or depth > depth_cap:
                return
            seen.add(operation["id"])
            rows.append(_row(operation, depth, path))
            for dependency_id in depends_map.get(operation["id"], []):
                child = next(
                    (op for op in visible if op["id"] == dependency_id), None
                )
                if child is not None:
                    walk(child, depth + 1, [*path, operation["id"]])

        for operation in ordered:
            walk(operation, 0, [])

        if not rows:
            rows = [_row(operation, 0, []) for operation in ordered[:cap]]

        await self._audit(
            principal, "structure.query", "mfg_process", process_id,
            {"operations": len(rows)},
        )
        return {
            "process": process,
            "operations": rows,
            "total": len(rows),
            "truncated": truncated or len(ordered) > cap,
            "cycle_detected": cycle_detected,
        }

    async def compare(
        self, principal: Principal, left_process_id: int, right_process_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        left = await self.get_process(principal, left_process_id)
        right = await self.get_process(principal, right_process_id)
        left_ops = await self.repository.list_mfg_operations_by_process(
            tenant_id, left["id"]
        )
        right_ops = await self.repository.list_mfg_operations_by_process(
            tenant_id, right["id"]
        )
        left_index = {operation["operation_key"]: operation for operation in left_ops}
        right_index = {operation["operation_key"]: operation for operation in right_ops}
        keys = sorted(set(left_index) | set(right_index))
        truncated = len(keys) > MAX_INTELLIGENCE_ROWS
        diffs: list[dict[str, Any]] = []
        summary = {"added": 0, "removed": 0, "modified": 0, "unchanged": 0}
        compared = (
            "operation_type", "sequence", "work_centre_id", "plant_id",
            "setup_minutes", "cycle_minutes", "lifecycle_status",
        )
        for key in keys[:MAX_INTELLIGENCE_ROWS]:
            left_op = left_index.get(key)
            right_op = right_index.get(key)
            if left_op is None:
                summary["added"] += 1
                diffs.append(
                    {
                        "change_type": "added",
                        "operation_key": key,
                        "right_operation_id": right_op["id"],
                        "before": None,
                        "after": _operation_snapshot(right_op),
                    }
                )
                continue
            if right_op is None:
                summary["removed"] += 1
                diffs.append(
                    {
                        "change_type": "removed",
                        "operation_key": key,
                        "left_operation_id": left_op["id"],
                        "before": _operation_snapshot(left_op),
                        "after": None,
                    }
                )
                continue
            changes = [
                field
                for field in compared
                if left_op.get(field) != right_op.get(field)
            ]
            if changes:
                summary["modified"] += 1
                diffs.append(
                    {
                        "change_type": "modified",
                        "operation_key": key,
                        "left_operation_id": left_op["id"],
                        "right_operation_id": right_op["id"],
                        "changes": changes,
                        "before": _operation_snapshot(left_op),
                        "after": _operation_snapshot(right_op),
                    }
                )
            else:
                summary["unchanged"] += 1
        await self._audit(
            principal, "compare.query", "mfg_process", left_process_id,
            {"right_process_id": right_process_id, "diffs": len(diffs)},
        )
        return {
            "left_process_id": left_process_id,
            "right_process_id": right_process_id,
            "summary": summary,
            "diffs": diffs,
            "truncated": truncated,
        }

    async def validate(
        self, principal: Principal, process_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        process = await self.get_process(principal, process_id)
        operations = await self.repository.list_mfg_operations_by_process(
            tenant_id, process["id"]
        )
        checks: list[dict[str, Any]] = []

        def add(rule: str, severity: str, message: str, operation_id: int | None = None,
                detail: dict[str, Any] | None = None) -> None:
            checks.append(
                {
                    "rule": rule,
                    "severity": severity,
                    "operation_id": operation_id,
                    "message": message,
                    "detail": detail or {},
                }
            )

        if not operations:
            add(
                "no_operations", "error",
                "The manufacturing process defines no operations",
            )
        if process["lifecycle_status"] == "released":
            pass
        elif process.get("mbom_header_id") is None:
            add(
                "missing_mbom", "warning",
                "The process is not associated with a manufacturing BOM",
            )

        sequences: dict[int, list[int]] = defaultdict(list)
        for operation in operations:
            sequences[int(operation.get("sequence") or 0)].append(operation["id"])
            if operation.get("work_centre_id") is None and process.get("plant_id"):
                add(
                    "missing_work_centre", "warning",
                    "Operation has no work centre assigned",
                    operation["id"],
                )
            if operation.get("lifecycle_status") in ("draft",):
                add(
                    "draft_operation", "info",
                    "Operation is still in draft", operation["id"],
                )
        for sequence, ids in sequences.items():
            if len(ids) > 1:
                for operation_id in ids:
                    add(
                        "duplicate_sequence", "warning",
                        "More than one operation shares the same sequence",
                        operation_id, {"sequence": sequence, "operations": ids},
                    )

        instructions, _ = await self.repository.list_mfg_work_instructions(
            tenant_id,
            process_id=process["id"],
            operation_id=None,
            query=None,
            lifecycle_status=None,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        documented = {row["operation_id"] for row in instructions if row.get("operation_id")}
        for operation in operations:
            if operation["id"] not in documented:
                add(
                    "missing_work_instruction", "warning",
                    "Operation has no work instruction", operation["id"],
                    {"operation_key": operation["operation_key"]},
                )

        consumption = await self.repository.list_mfg_operation_consumptions(
            tenant_id, operation_id=None, child_item_id=None,
            limit=MAX_INTELLIGENCE_ROWS,
        )
        if process.get("mbom_header_id") is not None and not consumption:
            add(
                "missing_component_consumption", "warning",
                "No operation consumes an MBOM component",
            )

        errors = sum(1 for check in checks if check["severity"] == "error")
        warnings = sum(1 for check in checks if check["severity"] == "warning")
        status = "fail" if errors else ("warning" if warnings else "pass")
        score = 1.0 if not checks else max(
            0.0, 1.0 - (errors * 0.2 + warnings * 0.05)
        )
        await self._audit(
            principal, "validate.query", "mfg_process", process_id,
            {"checks": len(checks)},
        )
        return {
            "process_id": process["id"],
            "status": status,
            "score": round(score, 3),
            "checks": checks,
            "summary": {
                "errors": errors,
                "warnings": warnings,
                "total": len(checks),
            },
        }

    # --- Analytics ------------------------------------------------------
    async def analytics(
        self, principal: Principal, kind: str
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        processes, _ = await self.repository.list_mfg_processes(
            tenant_id, process_type=None, root_item_id=None, mbom_header_id=None,
            query=None, lifecycle_status=None, limit=MAX_INTELLIGENCE_ROWS, offset=0,
        )
        visible_processes = await self._readable_many(principal, processes)
        if kind == "process_completeness":
            rows: list[dict[str, Any]] = []
            for process in visible_processes:
                result = await self.validate(principal, process["id"])
                rows.append(
                    {
                        "key": str(process["id"]),
                        "label": process.get("name") or process["process_key"],
                        "count": result["summary"]["errors"],
                        "detail": {
                            "process_key": process["process_key"],
                            "status": result["status"],
                            "score": result["score"],
                            "warnings": result["summary"]["warnings"],
                        },
                    }
                )
            rows.sort(key=lambda row: row["count"], reverse=True)
            return {
                "kind": kind,
                "rows": rows[:MAX_INTELLIGENCE_ROWS],
                "total": len(rows),
                "truncated": len(rows) > MAX_INTELLIGENCE_ROWS,
                "summary": {
                    "processes": len(rows),
                    "failing": sum(1 for row in rows if row["detail"]["status"] == "fail"),
                },
            }
        if kind == "parts_without_instructions":
            operations = await self.repository.list_mfg_operations(
                tenant_id, process_id=None, work_centre_id=None,
                lifecycle_status=None, limit=MAX_INTELLIGENCE_ROWS, offset=0,
            )
            operation_rows, _ = operations
            instructions, _ = await self.repository.list_mfg_work_instructions(
                tenant_id, process_id=None, operation_id=None, query=None,
                lifecycle_status=None, limit=MAX_INTELLIGENCE_ROWS, offset=0,
            )
            documented = {row["operation_id"] for row in instructions if row.get("operation_id")}
            uncovered = [
                operation for operation in operation_rows
                if operation["id"] not in documented
            ]
            rows = [
                {
                    "key": str(operation["id"]),
                    "label": operation.get("name") or operation["operation_key"],
                    "count": 1,
                    "detail": {
                        "process_id": operation["process_id"],
                        "operation_key": operation["operation_key"],
                        "work_centre_id": operation.get("work_centre_id"),
                    },
                }
                for operation in uncovered[:MAX_INTELLIGENCE_ROWS]
            ]
            return {
                "kind": kind,
                "rows": rows,
                "total": len(uncovered),
                "truncated": len(uncovered) > MAX_INTELLIGENCE_ROWS,
                "summary": {
                    "operations": len(operation_rows),
                    "documented": len(operation_rows) - len(uncovered),
                    "uncovered": len(uncovered),
                },
            }
        if kind == "work_centre_load":
            operations, _ = await self.repository.list_mfg_operations(
                tenant_id, process_id=None, work_centre_id=None,
                lifecycle_status=None, limit=MAX_INTELLIGENCE_ROWS, offset=0,
            )
            totals: dict[int | None, int] = defaultdict(int)
            for operation in operations:
                totals[operation.get("work_centre_id")] += 1
            rows = [
                {
                    "key": str(work_centre_id) if work_centre_id else "unassigned",
                    "label": None,
                    "count": count,
                    "detail": {"work_centre_id": work_centre_id},
                }
                for work_centre_id, count in totals.items()
            ]
            rows.sort(key=lambda row: row["count"], reverse=True)
            return {
                "kind": kind,
                "rows": rows,
                "total": len(rows),
                "truncated": False,
                "summary": {"operations": len(operations)},
            }
        raise ValidationError(
            "unknown manufacturing analytics kind",
            details={"kind": kind},
        )

    # --- Impact ---------------------------------------------------------
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
        result = await query.change_impact(
            principal, entity_id, max_depth=max_depth
        )
        affected = []
        paths = []
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

    # --- Statistics -----------------------------------------------------
    async def stats(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        _, plants = await self.repository.list_mfg_plants(
            tenant_id, query=None, lifecycle_status=None, limit=0, offset=0
        )
        _, lines = await self.repository.list_mfg_lines(
            tenant_id, plant_id=None, query=None, lifecycle_status=None,
            limit=0, offset=0,
        )
        _, work_centres = await self.repository.list_mfg_work_centres(
            tenant_id, plant_id=None, line_id=None, query=None, limit=0, offset=0
        )
        _, processes = await self.repository.list_mfg_processes(
            tenant_id, process_type=None, root_item_id=None, mbom_header_id=None,
            query=None, lifecycle_status=None, limit=0, offset=0,
        )
        operations, total_operations = await self.repository.list_mfg_operations(
            tenant_id, process_id=None, work_centre_id=None, lifecycle_status=None,
            limit=MAX_INTELLIGENCE_ROWS, offset=0,
        )
        instructions, total_instructions = (
            await self.repository.list_mfg_work_instructions(
                tenant_id, process_id=None, operation_id=None, query=None,
                lifecycle_status=None, limit=MAX_INTELLIGENCE_ROWS, offset=0,
            )
        )
        _, resources = await self.repository.list_mfg_resources(
            tenant_id, resource_kind=None, plant_id=None, query=None,
            limit=0, offset=0,
        )
        _, production_versions = await self.repository.list_mfg_production_versions(
            tenant_id, item_id=None, process_id=None, lifecycle_status=None,
            limit=0, offset=0,
        )
        documented = {
            row["operation_id"] for row in instructions if row.get("operation_id")
        }
        uncovered = sum(1 for operation in operations if operation["id"] not in documented)
        coverage = (
            round((len(operations) - uncovered) / len(operations), 3)
            if operations else 0.0
        )
        return {
            "plants": plants,
            "production_lines": lines,
            "work_centres": work_centres,
            "processes": processes,
            "operations": total_operations,
            "work_instructions": total_instructions,
            "resources": resources,
            "production_versions": production_versions,
            "operations_without_instructions": uncovered,
            "documented_coverage": coverage,
            "status": "ok",
        }


def _operation_snapshot(operation: dict[str, Any] | None) -> dict[str, Any] | None:
    if operation is None:
        return None
    return {
        "operation_id": operation.get("id"),
        "operation_key": operation.get("operation_key"),
        "operation_type": operation.get("operation_type"),
        "sequence": int(operation.get("sequence") or 0),
        "work_centre_id": operation.get("work_centre_id"),
        "plant_id": operation.get("plant_id"),
        "setup_minutes": _num(operation.get("setup_minutes")),
        "cycle_minutes": _num(operation.get("cycle_minutes")),
        "lifecycle_status": operation.get("lifecycle_status"),
    }
