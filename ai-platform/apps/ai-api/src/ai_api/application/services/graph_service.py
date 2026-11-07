"""Enterprise Knowledge Graph service (Stage 7).

Responsibilities
----------------
* Maintain the tenant-scoped registry of entity and relationship types.
* Upsert entities with stable identity so re-ingestion is idempotent.
* Validate and maintain typed, directional relationships.
* Bulk ingestion, reconciliation and stale-relationship handling.
* Object-level authorization on every read and mutation.

Design notes
------------
The graph is a *navigation* layer, not an authority. It stores references and a
bounded summary of enterprise objects; it never duplicates business logic or
grants access to the underlying enterprise record. Reads therefore require both
the graph capability and the entity's own ACL/classification, exactly like any
other AI knowledge object. A relationship between an authorized and an
unauthorized entity can never be used to reach the unauthorized one - the
traversal engine drops the unauthorized endpoint before it is returned.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.domain.graph import (
    ENTITY_TYPE_BY_CODE,
    ENTITY_TYPES,
    RELATIONSHIP_TYPE_BY_CODE,
    RELATIONSHIP_TYPES,
    EntityTypeSpec,
    RelationshipTypeSpec,
)
from ai_api.security.access_control import AccessControl, within_ceiling
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("knowledge_graph")

MAX_ENTITIES_PER_TENANT = 500_000
MAX_RELATIONSHIPS_PER_ENTITY = 5_000
_MAX_STABLE_KEY = 256


def _normalise_key(value: str) -> str:
    key = " ".join(str(value or "").split()).strip().lower()
    if not key:
        raise ValidationError("stable_key must not be empty")
    if len(key) > _MAX_STABLE_KEY:
        raise ValidationError("stable_key is too long")
    return key


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class GraphService:
    repository: AiRepository
    audit: AuditService
    access: AccessControl
    governance: GovernanceService
    events: EventPublisher | None = None

    # --- Type registry --------------------------------------------------
    async def list_types(self, principal: Principal) -> dict[str, list[dict[str, Any]]]:
        tenant_id = require_tenant(principal)
        await self._ensure_builtin_types(tenant_id)
        overrides_entity = {
            row["code"]: row
            for row in await self.repository.list_graph_entity_types(tenant_id)
        }
        overrides_rel = {
            row["code"]: row
            for row in await self.repository.list_graph_relationship_types(tenant_id)
        }
        entity_types = []
        for spec in ENTITY_TYPES:
            row = overrides_entity.get(spec.code)
            entity_types.append(
                {
                    "code": spec.code,
                    "name": (row or {}).get("name") or spec.name,
                    "description": (row or {}).get("description") or spec.description,
                    "category": (row or {}).get("category") or spec.category,
                    "source_types": [],
                    "target_types": [],
                    "directed": True,
                    "enabled": bool((row or {}).get("enabled", True)),
                    "builtin": True,
                }
            )
        for code, row in overrides_entity.items():
            if code in ENTITY_TYPE_BY_CODE:
                continue
            entity_types.append(self._type_row(row, builtin=False))
        relationship_types = []
        for spec in RELATIONSHIP_TYPES:
            row = overrides_rel.get(spec.code) or {}
            relationship_types.append(
                {
                    "code": spec.code,
                    "name": row.get("name") or spec.name,
                    "description": row.get("description") or spec.description,
                    "category": None,
                    "source_types": list(row.get("source_types") or spec.source_types),
                    "target_types": list(row.get("target_types") or spec.target_types),
                    "directed": bool(row.get("directed", spec.directed)),
                    "enabled": bool(row.get("enabled", True)),
                    "builtin": True,
                }
            )
        for code, row in overrides_rel.items():
            if code in RELATIONSHIP_TYPE_BY_CODE:
                continue
            relationship_types.append(self._type_row(row, builtin=False))
        return {
            "entity_types": entity_types,
            "relationship_types": relationship_types,
        }

    async def upsert_entity_type(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        code = str(payload.code or "").strip().lower()
        if not code:
            raise ValidationError("entity type code is required")
        row = await self.repository.upsert_graph_entity_type(
            tenant_id,
            {
                "code": code,
                "name": payload.name,
                "description": payload.description,
                "category": payload.category,
                "property_schema": payload.property_schema,
                "enabled": payload.enabled,
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.entity_type.upsert",
            resource_type="graph_entity_type",
            resource_id=code,
        )
        return self._type_row(row, builtin=code in ENTITY_TYPE_BY_CODE)

    async def upsert_relationship_type(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        code = str(payload.code or "").strip().lower()
        if not code:
            raise ValidationError("relationship type code is required")
        for entity_code in [*payload.source_types, *payload.target_types]:
            if entity_code not in ENTITY_TYPE_BY_CODE:
                raise ValidationError(
                    "relationship type references an unknown entity type",
                    details={"entity_type": entity_code},
                )
        row = await self.repository.upsert_graph_relationship_type(
            tenant_id,
            {
                "code": code,
                "name": payload.name,
                "description": payload.description,
                "source_types": payload.source_types,
                "target_types": payload.target_types,
                "directed": payload.directed,
                "property_schema": payload.property_schema,
                "enabled": payload.enabled,
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.relationship_type.upsert",
            resource_type="graph_relationship_type",
            resource_id=code,
        )
        return self._type_row(row, builtin=code in RELATIONSHIP_TYPE_BY_CODE)

    # --- Entities -------------------------------------------------------
    async def create_or_update_entity(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        entity_type = str(payload.entity_type or "").strip().lower()
        await self._require_entity_type(tenant_id, entity_type)
        stable_key = _normalise_key(payload.stable_key)
        existing = await self.repository.get_graph_entity_by_key(
            tenant_id, entity_type, stable_key
        )
        if existing is not None:
            await self._require_readable(principal, existing)
        data = {
            "entity_type": entity_type,
            "stable_key": stable_key,
            "external_id": payload.external_id,
            "source_system": payload.source_system,
            "source_ref": payload.source_ref,
            "name": payload.name,
            "description": payload.description,
            "classification": payload.classification,
            "acl": payload.acl,
            "lifecycle_status": payload.lifecycle_status,
            "confidence": payload.confidence,
            "properties": payload.properties,
            "metadata": payload.metadata,
            "valid_from": payload.valid_from,
            "valid_to": payload.valid_to,
            "created_by": principal.username,
            "updated_by": principal.username,
        }
        entity = await self.repository.upsert_graph_entity(tenant_id, data)
        await self.repository.add_graph_entity_version(
            tenant_id,
            {
                "entity_id": entity["id"],
                "version": entity["version"],
                "snapshot": self._entity_snapshot(entity),
                "change_reason": "upsert",
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.entity.upsert",
            resource_type="graph_entity",
            resource_id=str(entity["id"]),
            detail={"entity_type": entity_type, "created": existing is None},
        )
        await self._emit(
            "GraphEntityUpserted",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "entity_id": entity["id"],
                "entity_type": entity_type,
                "stable_key": stable_key,
                "version": entity["version"],
            },
        )
        return entity

    async def get_entity(self, principal: Principal, entity_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        entity = await self.repository.get_graph_entity(tenant_id, entity_id)
        if entity is None:
            raise NotFoundError("graph entity not found")
        await self._require_readable(principal, entity)
        return entity

    async def list_entities(
        self,
        principal: Principal,
        *,
        entity_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        source_system: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        if entity_types:
            for code in entity_types:
                await self._require_entity_type(tenant_id, code)
        items, total = await self.repository.list_graph_entities(
            tenant_id,
            entity_types=entity_types,
            query=query,
            lifecycle_status=lifecycle_status,
            source_system=source_system,
            limit=limit,
            offset=offset,
        )
        readable = await self._readable_many(principal, items)
        return readable, total

    async def update_entity(
        self, principal: Principal, entity_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        current = await self.get_entity(principal, entity_id)
        candidate = current.get("lifecycle_status")
        if payload.lifecycle_status is not None:
            candidate = payload.lifecycle_status
        if candidate not in (
            "active",
            "inactive",
            "draft",
            "released",
            "obsolete",
            "stale",
            "archived",
        ):
            raise ValidationError("invalid lifecycle status")
        fields = payload.model_dump(exclude_unset=True, exclude_none=True)
        change_reason = fields.pop("change_reason", None)
        fields["updated_by"] = principal.username
        entity = await self.repository.update_graph_entity(
            tenant_id, entity_id, fields
        )
        if entity is None:
            raise NotFoundError("graph entity not found")
        await self.repository.add_graph_entity_version(
            tenant_id,
            {
                "entity_id": entity_id,
                "version": entity["version"],
                "snapshot": self._entity_snapshot(entity),
                "change_reason": change_reason or "update",
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.entity.update",
            resource_type="graph_entity",
            resource_id=str(entity_id),
            detail={"fields": sorted(fields)},
        )
        return entity

    async def delete_entity(
        self, principal: Principal, entity_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_entity(principal, entity_id)
        entity = await self.repository.delete_graph_entity(
            tenant_id, entity_id, updated_by=principal.username
        )
        if entity is None:
            raise NotFoundError("graph entity not found")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.entity.delete",
            resource_type="graph_entity",
            resource_id=str(entity_id),
        )
        await self._emit(
            "GraphEntityDeleted",
            tenant_id=tenant_id,
            principal=principal,
            data={"entity_id": entity_id, "entity_type": entity["entity_type"]},
        )
        return entity

    async def entity_versions(
        self, principal: Principal, entity_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.get_entity(principal, entity_id)
        return await self.repository.list_graph_entity_versions(tenant_id, entity_id)

    # --- Relationships --------------------------------------------------
    async def create_relationship(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        if payload.source_entity_id == payload.target_entity_id:
            raise ValidationError("an entity cannot relate to itself")
        source = await self.get_entity(principal, payload.source_entity_id)
        target = await self.get_entity(principal, payload.target_entity_id)
        spec = await self._require_relationship_type(
            tenant_id,
            payload.relationship_type,
            source["entity_type"],
            target["entity_type"],
        )
        if spec["directed"] is False:
            # Unordered relationship: normalise the stored direction so a
            # duplicate received in reverse order still maps to one edge.
            if source["id"] > target["id"]:
                source, target = target, source
        relationship = await self.repository.upsert_graph_relationship(
            tenant_id,
            {
                "relationship_type": spec["code"],
                "source_entity_id": source["id"],
                "target_entity_id": target["id"],
                "properties": payload.properties,
                "confidence": payload.confidence,
                "source_system": payload.source_system
                or source.get("source_system"),
                "source_ref": payload.source_ref,
                "lifecycle_status": payload.lifecycle_status,
                "valid_from": payload.valid_from,
                "valid_to": payload.valid_to,
                "created_by": principal.username,
                "updated_by": principal.username,
            },
        )
        await self.repository.add_graph_relationship_version(
            tenant_id,
            {
                "relationship_id": relationship["id"],
                "version": relationship["version"],
                "snapshot": self._relationship_snapshot(relationship),
                "change_reason": payload.change_reason or "upsert",
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.relationship.upsert",
            resource_type="graph_relationship",
            resource_id=str(relationship["id"]),
            detail={
                "relationship_type": spec["code"],
                "source": source["id"],
                "target": target["id"],
            },
        )
        await self._emit(
            "GraphRelationshipChanged",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "relationship_id": relationship["id"],
                "relationship_type": spec["code"],
                "source_entity_id": source["id"],
                "target_entity_id": target["id"],
            },
        )
        return relationship

    async def get_relationship(
        self, principal: Principal, relationship_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        relationship = await self.repository.get_graph_relationship(
            tenant_id, relationship_id
        )
        if relationship is None:
            raise NotFoundError("graph relationship not found")
        await self.get_entity(principal, relationship["source_entity_id"])
        await self.get_entity(principal, relationship["target_entity_id"])
        return relationship

    async def list_relationships(
        self,
        principal: Principal,
        *,
        entity_ids: list[int] | None,
        relationship_types: list[str] | None,
        direction: str,
        include_inactive: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        if entity_ids:
            for entity_id in entity_ids:
                await self.get_entity(principal, entity_id)
        items, total = await self.repository.list_graph_relationships(
            tenant_id,
            entity_ids=entity_ids,
            relationship_types=relationship_types,
            direction=direction,
            include_inactive=include_inactive,
            limit=limit,
            offset=offset,
        )
        authorized = []
        for relationship in items:
            if await self._relationship_visible(principal, relationship):
                authorized.append(relationship)
        return authorized, total

    async def update_relationship(
        self, principal: Principal, relationship_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_relationship(principal, relationship_id)
        fields = payload.model_dump(exclude_unset=True, exclude_none=True)
        change_reason = fields.pop("change_reason", None)
        fields["updated_by"] = principal.username
        relationship = await self.repository.update_graph_relationship(
            tenant_id, relationship_id, fields
        )
        if relationship is None:
            raise NotFoundError("graph relationship not found")
        await self.repository.add_graph_relationship_version(
            tenant_id,
            {
                "relationship_id": relationship_id,
                "version": relationship["version"],
                "snapshot": self._relationship_snapshot(relationship),
                "change_reason": change_reason or "update",
                "created_by": principal.username,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.relationship.update",
            resource_type="graph_relationship",
            resource_id=str(relationship_id),
            detail={"fields": sorted(fields)},
        )
        return relationship

    async def delete_relationship(
        self, principal: Principal, relationship_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.get_relationship(principal, relationship_id)
        relationship = await self.repository.delete_graph_relationship(
            tenant_id, relationship_id, updated_by=principal.username
        )
        if relationship is None:
            raise NotFoundError("graph relationship not found")
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.relationship.delete",
            resource_type="graph_relationship",
            resource_id=str(relationship_id),
        )
        return relationship

    # --- Bulk ingestion -------------------------------------------------
    async def bulk_ingest(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        result = {
            "entities_created": 0,
            "entities_updated": 0,
            "relationships_created": 0,
            "relationships_updated": 0,
            "relationships_skipped": 0,
            "stale_relationships": 0,
        }
        keys: dict[tuple[str, str], int] = {}
        for item in payload.entities:
            entity_type = str(item.entity_type).strip().lower()
            await self._require_entity_type(tenant_id, entity_type)
            stable_key = _normalise_key(item.stable_key)
            existing = await self.repository.get_graph_entity_by_key(
                tenant_id, entity_type, stable_key
            )
            entity = await self.repository.upsert_graph_entity(
                tenant_id,
                {
                    "entity_type": entity_type,
                    "stable_key": stable_key,
                    "external_id": item.external_id,
                    "source_system": item.source_system or payload.source_system,
                    "source_ref": item.source_ref,
                    "name": item.name,
                    "description": item.description,
                    "classification": item.classification,
                    "acl": item.acl,
                    "lifecycle_status": item.lifecycle_status,
                    "confidence": item.confidence,
                    "properties": item.properties,
                    "metadata": item.metadata,
                    "created_by": principal.username,
                    "updated_by": principal.username,
                },
            )
            if existing is None:
                result["entities_created"] += 1
            else:
                result["entities_updated"] += 1
            keys[(entity_type, stable_key)] = entity["id"]
            await self.repository.add_graph_entity_version(
                tenant_id,
                {
                    "entity_id": entity["id"],
                    "version": entity["version"],
                    "snapshot": self._entity_snapshot(entity),
                    "change_reason": "bulk_ingest",
                    "created_by": principal.username,
                },
            )

        for item in payload.relationships:
            source_id = await self._resolve_bulk_entity(
                tenant_id, keys, item.source_stable_key, item.source_entity_type
            )
            target_id = await self._resolve_bulk_entity(
                tenant_id, keys, item.target_stable_key, item.target_entity_type
            )
            if source_id is None or target_id is None:
                result["relationships_skipped"] += 1
                continue
            if source_id == target_id:
                result["relationships_skipped"] += 1
                continue
            source = await self.repository.get_graph_entity(tenant_id, source_id)
            target = await self.repository.get_graph_entity(tenant_id, target_id)
            if source is None or target is None:
                result["relationships_skipped"] += 1
                continue
            try:
                spec = await self._require_relationship_type(
                    tenant_id,
                    item.relationship_type,
                    source["entity_type"],
                    target["entity_type"],
                )
            except ValidationError:
                result["relationships_skipped"] += 1
                continue
            existing_rel, _ = await self.repository.list_graph_relationships(
                tenant_id,
                entity_ids=[source_id],
                relationship_types=[spec["code"]],
                direction="outgoing",
                include_inactive=True,
                limit=1,
                offset=0,
            )
            was_present = any(
                rel["target_entity_id"] == target_id for rel in existing_rel
            )
            await self.repository.upsert_graph_relationship(
                tenant_id,
                {
                    "relationship_type": spec["code"],
                    "source_entity_id": source_id,
                    "target_entity_id": target_id,
                    "properties": item.properties,
                    "confidence": item.confidence,
                    "source_system": item.source_system or payload.source_system,
                    "source_ref": item.source_ref,
                    "lifecycle_status": item.lifecycle_status,
                    "created_by": principal.username,
                    "updated_by": principal.username,
                },
            )
            if was_present:
                result["relationships_updated"] += 1
            else:
                result["relationships_created"] += 1

        if payload.reconcile and payload.relationships:
            result["stale_relationships"] = await self._reconcile_relationships(
                principal, payload
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.bulk_ingest",
            resource_type="graph",
            detail={**result, "source_system": payload.source_system},
        )
        return result

    async def reconcile(
        self, principal: Principal, source_system: str | None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        if source_system is None:
            raise ValidationError("source_system is required for reconciliation")
        stale = await self.repository.list_graph_entities(
            tenant_id,
            entity_types=None,
            query=None,
            lifecycle_status=None,
            source_system=source_system,
            limit=1,
            offset=0,
        )
        if stale[1] == 0:
            return {"stale_entities": 0, "stale_relationships": 0}
        relationships, _ = await self.repository.list_graph_relationships(
            tenant_id,
            entity_ids=None,
            relationship_types=None,
            direction="both",
            include_inactive=False,
            limit=10_000,
            offset=0,
        )
        stale_count = 0
        for relationship in relationships:
            if relationship.get("source_system") != source_system:
                continue
            await self.repository.update_graph_relationship(
                tenant_id,
                relationship["id"],
                {"lifecycle_status": "stale", "updated_by": principal.username},
            )
            stale_count += 1
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.graph.reconcile",
            resource_type="graph",
            detail={"source_system": source_system, "stale_relationships": stale_count},
        )
        return {"stale_entities": 0, "stale_relationships": stale_count}

    # --- Statistics -----------------------------------------------------
    async def stats(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        stats = await self.repository.graph_stats(tenant_id)
        counts = await self.repository.graph_entity_type_counts(tenant_id)
        return {**stats, "entity_type_counts": counts, "status": "ok"}

    # --- Internals ------------------------------------------------------
    async def _resolve_bulk_entity(
        self,
        tenant_id: int,
        keys: dict[tuple[str, str], int],
        stable_key: str,
        entity_type: str | None,
    ) -> int | None:
        normalised = _normalise_key(stable_key)
        if entity_type:
            resolved = keys.get((entity_type, normalised))
            if resolved is not None:
                return resolved
            entity = await self.repository.get_graph_entity_by_key(
                tenant_id, entity_type, normalised
            )
            return entity["id"] if entity else None
        for (_, key), entity_id in keys.items():
            if key == normalised:
                return entity_id
        return None

    async def _reconcile_relationships(
        self, principal: Principal, payload: Any
    ) -> int:
        tenant_id = require_tenant(principal)
        keep = {
            (
                str(item.relationship_type),
                _normalise_key(item.source_stable_key),
                _normalise_key(item.target_stable_key),
            )
            for item in payload.relationships
        }
        if not payload.source_system:
            return 0
        relationships, _ = await self.repository.list_graph_relationships(
            tenant_id,
            entity_ids=None,
            relationship_types=None,
            direction="both",
            include_inactive=False,
            limit=10_000,
            offset=0,
        )
        stale = 0
        for relationship in relationships:
            if relationship.get("source_system") != payload.source_system:
                continue
            source = await self.repository.get_graph_entity(
                tenant_id, relationship["source_entity_id"]
            )
            target = await self.repository.get_graph_entity(
                tenant_id, relationship["target_entity_id"]
            )
            if source is None or target is None:
                continue
            key = (
                relationship["relationship_type"],
                source["stable_key"],
                target["stable_key"],
            )
            if key in keep:
                continue
            await self.repository.update_graph_relationship(
                tenant_id,
                relationship["id"],
                {"lifecycle_status": "stale", "updated_by": principal.username},
            )
            stale += 1
        return stale

    async def _ensure_builtin_types(self, tenant_id: int) -> None:
        existing_entity = {
            row["code"] for row in await self.repository.list_graph_entity_types(tenant_id)
        }
        for spec in ENTITY_TYPES:
            if spec.code in existing_entity:
                continue
            await self.repository.upsert_graph_entity_type(
                tenant_id, self._spec_to_row(spec)
            )
        existing_rel = {
            row["code"]
            for row in await self.repository.list_graph_relationship_types(tenant_id)
        }
        for spec in RELATIONSHIP_TYPES:
            if spec.code in existing_rel:
                continue
            await self.repository.upsert_graph_relationship_type(
                tenant_id, self._spec_to_row(spec)
            )

    async def _require_entity_type(self, tenant_id: int, code: str) -> None:
        if code in ENTITY_TYPE_BY_CODE:
            return
        overrides = await self.repository.list_graph_entity_types(tenant_id)
        if any(row["code"] == code and row.get("enabled", True) for row in overrides):
            return
        raise ValidationError(
            "unknown entity type", details={"entity_type": code}
        )

    async def _require_relationship_type(
        self,
        tenant_id: int,
        code: str,
        source_type: str,
        target_type: str,
    ) -> dict[str, Any]:
        normalised = str(code or "").strip().lower()
        spec = RELATIONSHIP_TYPE_BY_CODE.get(normalised)
        if spec is not None:
            if spec.source_types and source_type not in spec.source_types:
                raise ValidationError(
                    "relationship source type is not allowed",
                    details={"relationship_type": normalised, "source_type": source_type},
                )
            if spec.target_types and target_type not in spec.target_types:
                raise ValidationError(
                    "relationship target type is not allowed",
                    details={"relationship_type": normalised, "target_type": target_type},
                )
            return {
                "code": spec.code,
                "directed": spec.directed,
            }
        overrides = await self.repository.list_graph_relationship_types(tenant_id)
        for row in overrides:
            if row["code"] != normalised or not row.get("enabled", True):
                continue
            source_types = row.get("source_types") or []
            target_types = row.get("target_types") or []
            if source_types and source_type not in source_types:
                raise ValidationError("relationship source type is not allowed")
            if target_types and target_type not in target_types:
                raise ValidationError("relationship target type is not allowed")
            return {"code": row["code"], "directed": bool(row.get("directed", True))}
        raise ValidationError(
            "unknown relationship type", details={"relationship_type": normalised}
        )

    async def _relationship_visible(
        self, principal: Principal, relationship: dict[str, Any]
    ) -> bool:
        tenant_id = require_tenant(principal)
        source = await self.repository.get_graph_entity(
            tenant_id, relationship["source_entity_id"]
        )
        target = await self.repository.get_graph_entity(
            tenant_id, relationship["target_entity_id"]
        )
        if source is None or target is None:
            return False
        return await self._readable(principal, source) and await self._readable(
            principal, target
        )

    async def _readable(self, principal: Principal, entity: dict[str, Any]) -> bool:
        if entity.get("lifecycle_status") == "archived":
            return False
        policy = await self.governance.policy_for(principal.tenant_id)
        if not within_ceiling(
            entity.get("classification"), policy.data_classification_ceiling
        ):
            return False
        return self.access.allows(principal, entity.get("acl"))

    async def _readable_many(
        self, principal: Principal, entities: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Filter a page of entities with a single governance-policy lookup."""

        if not entities:
            return []
        policy = await self.governance.policy_for(principal.tenant_id)
        ceiling = policy.data_classification_ceiling
        return [
            entity
            for entity in entities
            if entity.get("lifecycle_status") != "archived"
            and within_ceiling(entity.get("classification"), ceiling)
            and self.access.allows(principal, entity.get("acl"))
        ]

    async def _require_readable(
        self, principal: Principal, entity: dict[str, Any]
    ) -> None:
        if not await self._readable(principal, entity):
            raise NotFoundError("graph entity not found")

    @staticmethod
    def _spec_to_row(spec: EntityTypeSpec | RelationshipTypeSpec) -> dict[str, Any]:
        if isinstance(spec, EntityTypeSpec):
            return {
                "code": spec.code,
                "name": spec.name,
                "description": spec.description,
                "category": spec.category,
                "property_schema": spec.property_schema,
                "enabled": True,
            }
        return {
            "code": spec.code,
            "name": spec.name,
            "description": spec.description,
            "source_types": list(spec.source_types),
            "target_types": list(spec.target_types),
            "directed": spec.directed,
            "property_schema": spec.property_schema,
            "enabled": True,
        }

    @staticmethod
    def _type_row(row: dict[str, Any], *, builtin: bool) -> dict[str, Any]:
        return {
            "code": row["code"],
            "name": row["name"],
            "description": row.get("description"),
            "category": row.get("category"),
            "source_types": list(row.get("source_types") or []),
            "target_types": list(row.get("target_types") or []),
            "directed": bool(row.get("directed", True)),
            "enabled": bool(row.get("enabled", True)),
            "builtin": builtin,
        }

    @staticmethod
    def _entity_snapshot(entity: dict[str, Any]) -> dict[str, Any]:
        return {
            "entity_type": entity["entity_type"],
            "stable_key": entity["stable_key"],
            "name": entity.get("name"),
            "lifecycle_status": entity.get("lifecycle_status"),
            "classification": entity.get("classification"),
            "confidence": float(entity.get("confidence", 1.0)),
            "properties": entity.get("properties", {}),
            "metadata": entity.get("metadata", {}),
        }

    @staticmethod
    def _relationship_snapshot(relationship: dict[str, Any]) -> dict[str, Any]:
        return {
            "relationship_type": relationship["relationship_type"],
            "source_entity_id": relationship["source_entity_id"],
            "target_entity_id": relationship["target_entity_id"],
            "lifecycle_status": relationship.get("lifecycle_status"),
            "confidence": float(relationship.get("confidence", 1.0)),
            "properties": relationship.get("properties", {}),
        }

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
                subject_type="graph_entity",
                data=data,
            )
        except Exception as exc:  # noqa: BLE001 - publishing must not break writes
            logger.warning("graph.event_publish_failed", error=str(exc))
