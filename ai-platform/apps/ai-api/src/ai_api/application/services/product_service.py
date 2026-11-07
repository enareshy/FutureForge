"""Product, part, revision and BOM record services (Stage 8 / Step 6).

These services own the *domain* records (items, revisions, BOM headers, BOM
lines). They sit on top of the Stage 7 knowledge graph: each record can point at
a graph entity so the digital thread, traversal and change-impact engines keep
working, but the graph is never duplicated and the domain rows remain the only
place BOM structure is stored.

Authorization mirrors the graph service: every read checks the tenant
classification ceiling and the record ACL, and unauthorized entities surface as
`NotFoundError` so their existence is not leaked.
"""

from __future__ import annotations

from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.graph_service import GraphService
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.domain.product import (
    ASSEMBLY_ITEM_TYPES,
    BOM_LIFECYCLE_STATES,
    BOM_LIFECYCLE_TRANSITIONS,
    BOM_TYPES,
    DEFAULT_UNIT_OF_MEASURE,
    ITEM_LIFECYCLE_STATES,
    ITEM_LIFECYCLE_TRANSITIONS,
    ITEM_TYPES,
    LINE_STATUSES,
    LINE_USAGES,
    is_transition_allowed,
    normalise_item_key,
    normalise_key,
    normalise_revision,
)
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("product_bom")

# Domain item type -> graph entity type. Assemblies and components are parts in
# the graph vocabulary; a product stays a product so the digital thread works.
_GRAPH_TYPE_BY_ITEM: dict[str, str] = {
    "product": "product",
    "part": "part",
    "assembly": "part",
    "component": "part",
    "material": "part",
}

_GRAPH_TYPE_BY_BOM: dict[str, str] = {
    "EBOM": "ebom",
    "MBOM": "mbom",
    "BOP": "ebom",
    "OTHER": "ebom",
}


def _require_choice(value: str, allowed: tuple[str, ...], field: str) -> str:
    text = str(value or "").strip()
    if text not in allowed:
        raise ValidationError(
            f"invalid {field}", details={"field": field, "allowed": list(allowed)}
        )
    return text


def _require_lifecycle(
    value: str, allowed: tuple[str, ...], field: str
) -> str:
    return _require_choice(str(value or "").strip().lower(), allowed, field)


class ProductService:
    def __init__(
        self,
        repository: AiRepository,
        audit: AuditService,
        access: AccessControl,
        governance: GovernanceService,
        graph: GraphService,
        events: EventPublisher | None = None,
    ) -> None:
        self.repository = repository
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

        Identical semantics to :meth:`_readable` per row, but the tenant's
        classification ceiling is fetched once instead of once per record. The
        policy is not cached across calls, so a policy change is honoured on the
        next request (no authorization staleness).
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
        entity_type: str,
        stable_key: str,
        name: str | None,
        description: str | None,
        classification: str,
        acl: dict[str, Any],
        lifecycle_status: str,
        properties: dict[str, Any],
    ) -> int | None:
        """Create/update the graph entity for a domain record (best effort).

        The domain record is the system of record; a graph outage must not block
        a BOM write. The returned id is stored on the domain row when available.
        """

        try:
            from ai_api.schemas.graph import GraphEntityCreate

            entity = await self.graph.create_or_update_entity(
                principal,
                GraphEntityCreate(
                    entity_type=entity_type,
                    stable_key=stable_key,
                    name=name,
                    description=description,
                    classification=classification,
                    acl=acl,
                    lifecycle_status=(
                        lifecycle_status
                        if lifecycle_status in
                        ("active", "inactive", "draft", "released", "obsolete", "stale", "archived")
                        else "active"
                    ),
                    properties=properties,
                    source_system="ai.product",
                ),
            )
            return int(entity["id"])
        except Exception as exc:  # noqa: BLE001 - graph is navigation only
            logger.warning("product.graph_link_failed", error=str(exc))
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
                    source_system="ai.product",
                ),
            )
        except Exception as exc:  # noqa: BLE001 - navigation only
            logger.warning("product.graph_relationship_failed", error=str(exc))

    # --- Items ----------------------------------------------------------
    async def create_or_update_item(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        item_type = _require_choice(
            str(payload.item_type or "").strip().lower(), ITEM_TYPES, "item_type"
        )
        item_key = normalise_item_key(payload.item_key)
        if not item_key:
            raise ValidationError("item_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "active", ITEM_LIFECYCLE_STATES, "lifecycle_status"
        )
        existing = await self.repository.get_product_item_by_key(
            tenant_id, item_type, item_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "product item")
        graph_type = _GRAPH_TYPE_BY_ITEM[item_type]
        graph_entity_id = await self._link_entity(
            principal,
            entity_type=graph_type,
            stable_key=item_key,
            name=payload.name or item_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status=lifecycle,
            properties={"item_key": item_key, "item_type": item_type},
        )
        data = {
            "item_type": item_type,
            "item_key": item_key,
            "name": payload.name,
            "description": payload.description,
            "unit_of_measure": payload.unit_of_measure or DEFAULT_UNIT_OF_MEASURE,
            "lifecycle_status": lifecycle,
            "configuration": payload.configuration,
            "variants": payload.variants,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        item = await self.repository.upsert_product_item(tenant_id, data)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.product.item.upsert",
            resource_type="product_item",
            resource_id=str(item["id"]),
            detail={
                "item_type": item_type,
                "item_key": item_key,
                "created": existing is None,
            },
        )
        await self._emit(
            "ProductItemUpserted",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "item_id": item["id"],
                "item_type": item_type,
                "item_key": item_key,
                "created": existing is None,
            },
        )
        return item

    async def get_item(self, principal: Principal, item_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        item = await self.repository.get_product_item(tenant_id, item_id)
        return await self._require_readable(principal, item, "product item")

    async def list_items(
        self,
        principal: Principal,
        *,
        item_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        normalized_types = None
        if item_types:
            normalized_types = [
                _require_choice(t.strip().lower(), ITEM_TYPES, "item_type")
                for t in item_types
            ]
        items, total = await self.repository.list_product_items(
            tenant_id,
            item_types=normalized_types,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        visible = await self._readable_many(principal, items)
        return visible, total

    async def update_item(
        self, principal: Principal, item_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        item = await self.get_item(principal, item_id)
        fields = payload.model_dump(exclude_unset=True)
        change_reason = fields.pop("change_reason", None)
        if "lifecycle_status" in fields and fields["lifecycle_status"] is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], ITEM_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                ITEM_LIFECYCLE_TRANSITIONS, item["lifecycle_status"], target
            ):
                raise ValidationError(
                    "illegal lifecycle transition",
                    details={
                        "from": item["lifecycle_status"],
                        "to": target,
                    },
                )
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_product_item(
            tenant_id, item_id, fields
        )
        updated = await self._require_readable(principal, updated, "product item")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.product.item.update",
            resource_type="product_item",
            resource_id=str(item_id),
            detail={"fields": sorted(fields), "reason": change_reason},
        )
        await self._emit(
            "ProductItemUpserted",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "item_id": item_id,
                "item_type": updated["item_type"],
                "item_key": updated["item_key"],
                "created": False,
            },
        )
        return updated

    # --- Revisions ------------------------------------------------------
    async def create_or_update_revision(
        self, principal: Principal, item_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_item(principal, item_id)
        revision = normalise_revision(payload.revision)
        if not revision:
            raise ValidationError("revision must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft", ITEM_LIFECYCLE_STATES, "lifecycle_status"
        )
        data = {
            "item_id": item_id,
            "revision": revision,
            "lifecycle_status": lifecycle,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "configuration": payload.configuration,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        rev = await self.repository.upsert_product_revision(tenant_id, data)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.product.revision.upsert",
            resource_type="product_revision",
            resource_id=str(rev["id"]),
            detail={"item_id": item_id, "revision": revision},
        )
        return rev

    async def get_revision(
        self, principal: Principal, revision_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        revision = await self.repository.get_product_revision(tenant_id, revision_id)
        return await self._require_readable(principal, revision, "product revision")

    async def list_revisions(
        self,
        principal: Principal,
        *,
        item_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        revisions, total = await self.repository.list_product_revisions(
            tenant_id,
            item_id=item_id,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        visible = await self._readable_many(principal, revisions)
        return visible, total

    async def update_revision(
        self, principal: Principal, revision_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        revision = await self.get_revision(principal, revision_id)
        fields = payload.model_dump(exclude_unset=True)
        change_reason = fields.pop("change_reason", None)
        if "lifecycle_status" in fields and fields["lifecycle_status"] is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], ITEM_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                ITEM_LIFECYCLE_TRANSITIONS, revision["lifecycle_status"], target
            ):
                raise ValidationError(
                    "illegal lifecycle transition",
                    details={"from": revision["lifecycle_status"], "to": target},
                )
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_product_revision(
            tenant_id, revision_id, fields
        )
        updated = await self._require_readable(
            principal, updated, "product revision"
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.product.revision.update",
            resource_type="product_revision",
            resource_id=str(revision_id),
            detail={"fields": sorted(fields), "reason": change_reason},
        )
        return updated

    # --- BOM headers ----------------------------------------------------
    async def create_or_update_header(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        bom_type = _require_choice(
            str(payload.bom_type or "").strip().upper(), BOM_TYPES, "bom_type"
        )
        bom_key = normalise_key(payload.bom_key)
        if not bom_key:
            raise ValidationError("bom_key must not be empty")
        lifecycle = _require_lifecycle(
            payload.lifecycle_status or "draft", BOM_LIFECYCLE_STATES, "lifecycle_status"
        )
        if payload.root_item_id is not None:
            await self.get_item(principal, payload.root_item_id)
        if payload.root_revision_id is not None:
            revision = await self.get_revision(principal, payload.root_revision_id)
            if payload.root_item_id is not None and revision["item_id"] != payload.root_item_id:
                raise ValidationError("root revision does not belong to the root item")
        existing = await self.repository.get_bom_header_by_key(
            tenant_id, bom_type, bom_key
        )
        if existing is not None:
            await self._require_readable(principal, existing, "BOM header")
        graph_entity_id = await self._link_entity(
            principal,
            entity_type=_GRAPH_TYPE_BY_BOM[bom_type],
            stable_key=f"{bom_type}:{bom_key}",
            name=payload.name or bom_key,
            description=payload.description,
            classification=payload.classification,
            acl=payload.acl,
            lifecycle_status="active",
            properties={"bom_type": bom_type, "bom_key": bom_key},
        )
        if graph_entity_id is not None and payload.root_item_id is not None:
            root_item = await self.repository.get_product_item(
                tenant_id, payload.root_item_id
            )
            if root_item and root_item.get("graph_entity_id"):
                await self._link_relationship(
                    principal,
                    "has_bom",
                    root_item["graph_entity_id"],
                    graph_entity_id,
                )
        data = {
            "bom_type": bom_type,
            "bom_key": bom_key,
            "name": payload.name,
            "description": payload.description,
            "root_item_id": payload.root_item_id,
            "root_revision_id": payload.root_revision_id,
            "plant": payload.plant,
            "configuration": payload.configuration,
            "lifecycle_status": lifecycle,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "classification": payload.classification,
            "acl": payload.acl,
            "graph_entity_id": graph_entity_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        header = await self.repository.upsert_bom_header(tenant_id, data)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.header.upsert",
            resource_type="bom_header",
            resource_id=str(header["id"]),
            detail={
                "bom_type": bom_type,
                "bom_key": bom_key,
                "created": existing is None,
            },
        )
        await self._emit(
            "BomHeaderUpserted",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "header_id": header["id"],
                "bom_type": bom_type,
                "bom_key": bom_key,
                "created": existing is None,
            },
        )
        return header

    async def get_header(
        self, principal: Principal, header_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        header = await self.repository.get_bom_header(tenant_id, header_id)
        return await self._require_readable(principal, header, "BOM header")

    async def list_headers(
        self,
        principal: Principal,
        *,
        bom_type: str | None,
        root_item_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        normalized_type = None
        if bom_type:
            normalized_type = _require_choice(
                bom_type.strip().upper(), BOM_TYPES, "bom_type"
            )
        headers, total = await self.repository.list_bom_headers(
            tenant_id,
            bom_type=normalized_type,
            root_item_id=root_item_id,
            query=query,
            lifecycle_status=lifecycle_status,
            limit=limit,
            offset=offset,
        )
        visible = await self._readable_many(principal, headers)
        return visible, total

    async def update_header(
        self, principal: Principal, header_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        header = await self.get_header(principal, header_id)
        fields = payload.model_dump(exclude_unset=True)
        change_reason = fields.pop("change_reason", None)
        if "lifecycle_status" in fields and fields["lifecycle_status"] is not None:
            target = _require_lifecycle(
                fields["lifecycle_status"], BOM_LIFECYCLE_STATES, "lifecycle_status"
            )
            if not is_transition_allowed(
                BOM_LIFECYCLE_TRANSITIONS, header["lifecycle_status"], target
            ):
                raise ValidationError(
                    "illegal lifecycle transition",
                    details={"from": header["lifecycle_status"], "to": target},
                )
            fields["lifecycle_status"] = target
        fields["updated_by"] = principal.username
        updated = await self.repository.update_bom_header(
            tenant_id, header_id, fields
        )
        updated = await self._require_readable(principal, updated, "BOM header")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.header.update",
            resource_type="bom_header",
            resource_id=str(header_id),
            detail={"fields": sorted(fields), "reason": change_reason},
        )
        return updated

    async def delete_header(self, principal: Principal, header_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_header(principal, header_id)
        deleted = await self.repository.delete_bom_header(
            tenant_id, header_id, updated_by=principal.username
        )
        if deleted is None:
            raise NotFoundError("BOM header not found")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.header.delete",
            resource_type="bom_header",
            resource_id=str(header_id),
        )
        return deleted

    # --- BOM lines ------------------------------------------------------
    async def create_line(
        self, principal: Principal, header_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        header = await self.get_header(principal, header_id)
        parent_revision = await self.get_revision(
            principal, payload.parent_revision_id
        )
        child_item = await self.get_item(principal, payload.child_item_id)
        if payload.child_revision_id is not None:
            child_revision = await self.get_revision(
                principal, payload.child_revision_id
            )
            if child_revision["item_id"] != payload.child_item_id:
                raise ValidationError("child revision does not belong to the child item")
        usage = _require_choice(
            str(payload.usage or "DESIGN").strip().upper(), LINE_USAGES, "usage"
        )
        line_status = _require_lifecycle(
            payload.line_status or "active", LINE_STATUSES, "line_status"
        )
        if payload.substitute_for_item_id is not None:
            if payload.substitute_for_item_id == payload.child_item_id:
                raise ValidationError("a substitute must differ from the child item")
            await self.get_item(principal, payload.substitute_for_item_id)
        line_key = normalise_key(
            payload.line_key
            or payload.find_number
            or f"{parent_revision['id']}:{payload.child_item_id}"
        )
        if not line_key:
            raise ValidationError("line_key must not be empty")
        data = {
            "bom_header_id": header_id,
            "parent_revision_id": parent_revision["id"],
            "child_item_id": child_item["id"],
            "child_revision_id": payload.child_revision_id,
            "line_key": line_key,
            "quantity": payload.quantity,
            "unit_of_measure": payload.unit_of_measure or DEFAULT_UNIT_OF_MEASURE,
            "find_number": payload.find_number,
            "sequence": payload.sequence,
            "reference_designators": payload.reference_designators,
            "usage": usage,
            "line_status": line_status,
            "is_phantom": payload.is_phantom,
            "is_reference": payload.is_reference,
            "alternate_of_line_id": payload.alternate_of_line_id,
            "substitute_for_item_id": payload.substitute_for_item_id,
            "plant": payload.plant,
            "effectivity_from": payload.effectivity_from,
            "effectivity_to": payload.effectivity_to,
            "configuration": payload.configuration,
            "attributes": payload.attributes,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "external_id": payload.external_id,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        line = await self.repository.create_bom_line(tenant_id, data)
        await self._link_line_graph(principal, header, line, child_item)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.line.upsert",
            resource_type="bom_line",
            resource_id=str(line["id"]),
            detail={
                "header_id": header_id,
                "child_item_id": payload.child_item_id,
                "line_key": line_key,
            },
        )
        await self._emit(
            "BomLineChanged",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "header_id": header_id,
                "line_id": line["id"],
                "child_item_id": payload.child_item_id,
            },
        )
        return line

    async def _link_line_graph(
        self,
        principal: Principal,
        header: dict[str, Any],
        line: dict[str, Any],
        child_item: dict[str, Any],
    ) -> None:
        header_graph = header.get("graph_entity_id")
        if not header_graph:
            return
        child_graph = child_item.get("graph_entity_id")
        if not child_graph:
            return
        prefix = "EBOM" if header["bom_type"] in ("EBOM", "BOP", "OTHER") else header["bom_type"]
        line_graph = await self._link_entity(
            principal,
            entity_type="bom_line",
            stable_key=f"{prefix}:{header['bom_key']}:{line['line_key']}",
            name=f"{child_item['item_key']} on {header['bom_key']}",
            description=None,
            classification=child_item.get("classification", "internal"),
            acl=child_item.get("acl", {}),
            lifecycle_status="active",
            properties={
                "header_id": header["id"],
                "line_id": line["id"],
                "child_item_id": child_item["id"],
            },
        )
        if line_graph is None:
            return
        await self._link_relationship(principal, "has_line", header_graph, line_graph)
        await self._link_relationship(principal, "references", line_graph, child_graph)

    async def get_line(self, principal: Principal, line_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        line = await self.repository.get_bom_line(tenant_id, line_id)
        return await self._require_readable(principal, line, "BOM line")

    async def list_lines(
        self,
        principal: Principal,
        *,
        header_id: int | None,
        parent_revision_id: int | None,
        child_item_id: int | None,
        active_only: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        lines, total = await self.repository.list_bom_lines(
            tenant_id,
            header_id=header_id,
            parent_revision_id=parent_revision_id,
            child_item_id=child_item_id,
            active_only=active_only,
            limit=limit,
            offset=offset,
        )
        visible = await self._readable_many(principal, lines)
        return visible, total

    async def update_line(
        self, principal: Principal, line_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        line = await self.get_line(principal, line_id)
        header = await self.get_header(principal, line["bom_header_id"])
        if header["lifecycle_status"] in ("superseded", "obsolete", "archived"):
            raise ValidationError("cannot edit an immutable BOM revision")
        fields = payload.model_dump(exclude_unset=True)
        change_reason = fields.pop("change_reason", None)
        if "usage" in fields and fields["usage"] is not None:
            fields["usage"] = _require_choice(
                str(fields["usage"]).strip().upper(), LINE_USAGES, "usage"
            )
        if "line_status" in fields and fields["line_status"] is not None:
            fields["line_status"] = _require_lifecycle(
                fields["line_status"], LINE_STATUSES, "line_status"
            )
        if "child_revision_id" in fields and fields["child_revision_id"] is not None:
            child_revision = await self.get_revision(
                principal, fields["child_revision_id"]
            )
            if child_revision["item_id"] != line["child_item_id"]:
                raise ValidationError("child revision does not belong to the child item")
        if "substitute_for_item_id" in fields and fields["substitute_for_item_id"] is not None:
            if fields["substitute_for_item_id"] == line["child_item_id"]:
                raise ValidationError("a substitute must differ from the child item")
        fields["updated_by"] = principal.username
        updated = await self.repository.update_bom_line(tenant_id, line_id, fields)
        updated = await self._require_readable(principal, updated, "BOM line")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.line.update",
            resource_type="bom_line",
            resource_id=str(line_id),
            detail={"fields": sorted(fields), "reason": change_reason},
        )
        await self._emit(
            "BomLineChanged",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "header_id": line["bom_header_id"],
                "line_id": line_id,
                "child_item_id": line["child_item_id"],
            },
        )
        return updated

    async def delete_line(self, principal: Principal, line_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        line = await self.get_line(principal, line_id)
        header = await self.get_header(principal, line["bom_header_id"])
        if header["lifecycle_status"] in ("superseded", "obsolete", "archived"):
            raise ValidationError("cannot edit an immutable BOM revision")
        deleted = await self.repository.delete_bom_line(
            tenant_id, line_id, updated_by=principal.username
        )
        if deleted is None:
            raise NotFoundError("BOM line not found")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.bom.line.delete",
            resource_type="bom_line",
            resource_id=str(line_id),
        )
        await self._emit(
            "BomLineChanged",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "header_id": line["bom_header_id"],
                "line_id": line_id,
                "child_item_id": line["child_item_id"],
                "deleted": True,
            },
        )
        return deleted

    # --- Events ---------------------------------------------------------
    async def _emit(
        self,
        event_type: str,
        *,
        tenant_id: int,
        principal: Principal,
        data: dict[str, Any],
    ) -> None:
        if self.events is None:
            return
        try:
            await self.events.emit(
                event_type,
                tenant_id=tenant_id,
                actor_id=principal.actor_id,
                subject_type="product_item",
                data=data,
            )
        except Exception as exc:  # noqa: BLE001 - publishing must not break writes
            logger.warning("product.event_publish_failed", error=str(exc))


def is_assembly(item_type: str) -> bool:
    return item_type in ASSEMBLY_ITEM_TYPES
