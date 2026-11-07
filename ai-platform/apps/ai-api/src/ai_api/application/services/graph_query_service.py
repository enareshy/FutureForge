"""Knowledge graph query and traversal engine (Stage 7).

Every traversal step re-checks object-level authorization. A user can never
discover an entity they could not open directly by walking a relationship from
an entity they *can* open, so the engine filters unauthorized endpoints at each
hop instead of relying on the first node's authorization.

Safety limits are enforced here, not by callers:

* ``max_depth`` is capped at ``MAX_DEPTH``;
* every result set is capped at ``MAX_RESULTS``;
* expansion is bounded per frontier so a hub node cannot explode the walk;
* cycles are detected and never re-expanded.

The engine only ever returns *observed* relationships. Where a capability is
explicitly inferential (for example change impact through ``AFFECTS`` chains) the
response is flagged ``inferred`` so callers never present a guess as a fact.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.graph_service import GraphService
from ai_api.domain.errors import NotFoundError, ValidationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("knowledge_graph.query")

MAX_DEPTH = 6
MAX_RESULTS = 500
_MAX_FANOUT = 100
_MAX_PATHS = 20


def _confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 1.0
    return max(0.0, min(1.0, number))


def _entity_summary(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entity.get("id"),
        "entity_type": entity.get("entity_type"),
        "stable_key": entity.get("stable_key"),
        "name": entity.get("name"),
        "lifecycle_status": entity.get("lifecycle_status"),
        "confidence": _confidence(entity.get("confidence")),
        "source_system": entity.get("source_system"),
    }


@dataclass(slots=True)
class GraphQueryService:
    repository: Any
    graph: GraphService
    audit: AuditService

    # --- Direct lookup / neighbourhood ---------------------------------
    async def neighbors(
        self,
        principal: Principal,
        entity_id: int,
        *,
        direction: str = "both",
        relationship_types: list[str] | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        root = await self.graph.get_entity(principal, entity_id)
        if direction not in ("outgoing", "incoming", "both"):
            raise ValidationError("direction must be outgoing, incoming or both")
        limit = max(1, min(limit, MAX_RESULTS))
        relationships = await self.repository.list_graph_neighbors(
            tenant_id,
            entity_ids=[entity_id],
            relationship_types=relationship_types,
            direction=direction,
            limit=limit,
        )
        nodes: dict[int, dict[str, Any]] = {}
        visible_relationships: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        other_ids = {
            rel["target_entity_id"]
            if rel["source_entity_id"] == entity_id
            else rel["source_entity_id"]
            for rel in relationships
        }
        for other_id in other_ids:
            entity = await self._visible_entity(principal, other_id)
            if entity is not None:
                nodes[entity["id"]] = entity
        for rel in relationships:
            if (
                rel["source_entity_id"] not in nodes
                and rel["source_entity_id"] != entity_id
            ):
                continue
            if (
                rel["target_entity_id"] not in nodes
                and rel["target_entity_id"] != entity_id
            ):
                continue
            other_id = (
                rel["target_entity_id"]
                if rel["source_entity_id"] == entity_id
                else rel["source_entity_id"]
            )
            direction_label = (
                "outgoing" if rel["source_entity_id"] == entity_id else "incoming"
            )
            visible_relationships.append(rel)
            items.append(
                {
                    "entity": nodes[other_id],
                    "relationship": rel,
                    "direction": direction_label,
                    "depth": 1,
                }
            )
        await self._audit_query(principal, "neighbors", entity_id, {"depth": 1})
        return {
            "root": root,
            "nodes": list(nodes.values()),
            "relationships": visible_relationships,
            "neighbors": items,
            "truncated": len(relationships) >= limit,
        }

    # --- Multi-hop traversal -------------------------------------------
    async def traverse(
        self,
        principal: Principal,
        entity_id: int,
        *,
        direction: str = "outgoing",
        relationship_types: list[str] | None = None,
        entity_types: list[str] | None = None,
        max_depth: int = 2,
        limit: int = 50,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        if direction not in ("outgoing", "incoming", "both"):
            raise ValidationError("direction must be outgoing, incoming or both")
        max_depth = max(1, min(int(max_depth), MAX_DEPTH))
        limit = max(1, min(int(limit), MAX_RESULTS))
        root = await self.graph.get_entity(principal, entity_id)

        visited: dict[int, dict[str, Any]] = {root["id"]: root}
        visited_relationships: dict[int, dict[str, Any]] = {}
        parent_of: dict[int, int] = {}
        edge_to: dict[int, dict[str, Any]] = {}
        frontier = [root["id"]]
        depth_reached = 0
        truncated = False
        cycle_detected = False
        allowed_types = set(entity_types or [])

        for depth in range(1, max_depth + 1):
            if not frontier:
                break
            remaining = limit - len(visited) + 1
            if remaining <= 0:
                truncated = True
                break
            per_node = max(1, min(_MAX_FANOUT, remaining))
            next_frontier: list[int] = []
            for node_id in frontier:
                relationships = await self.repository.list_graph_neighbors(
                    tenant_id,
                    entity_ids=[node_id],
                    relationship_types=relationship_types,
                    direction=direction,
                    limit=per_node,
                )
                for rel in relationships:
                    other_id = (
                        rel["target_entity_id"]
                        if rel["source_entity_id"] == node_id
                        else rel["source_entity_id"]
                    )
                    if other_id == root["id"]:
                        cycle_detected = True
                    if other_id in visited:
                        visited_relationships.setdefault(rel["id"], rel)
                        continue
                    if len(visited) >= limit:
                        truncated = True
                        break
                    entity = await self._visible_entity(principal, other_id)
                    if entity is None:
                        continue
                    if allowed_types and entity["entity_type"] not in allowed_types:
                        continue
                    visited[entity["id"]] = entity
                    visited_relationships[rel["id"]] = rel
                    parent_of[entity["id"]] = node_id
                    edge_to[entity["id"]] = rel
                    next_frontier.append(entity["id"])
                if truncated:
                    break
            if next_frontier:
                depth_reached = depth
            frontier = next_frontier

        nodes = [node for node_id, node in visited.items() if node_id != root["id"]]
        paths = self._build_paths(root["id"], nodes, parent_of, edge_to, visited)
        await self._audit_query(
            principal,
            "traverse",
            entity_id,
            {"max_depth": max_depth, "nodes": len(nodes)},
        )
        return {
            "root": root,
            "nodes": nodes,
            "relationships": list(visited_relationships.values()),
            "paths": paths,
            "depth_reached": depth_reached,
            "truncated": truncated,
            "cycle_detected": cycle_detected,
        }

    # --- Path discovery ------------------------------------------------
    async def find_paths(
        self,
        principal: Principal,
        source_id: int,
        *,
        target_id: int,
        direction: str = "outgoing",
        relationship_types: list[str] | None = None,
        max_depth: int = 4,
        max_paths: int = 5,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        if direction not in ("outgoing", "incoming", "both"):
            raise ValidationError("direction must be outgoing, incoming or both")
        max_depth = max(1, min(int(max_depth), MAX_DEPTH))
        max_paths = max(1, min(int(max_paths), _MAX_PATHS))
        source = await self.graph.get_entity(principal, source_id)
        target = await self.graph.get_entity(principal, target_id)
        if source_id == target_id:
            raise ValidationError("source and target must differ")

        paths: list[dict[str, Any]] = []
        truncated = False

        async def _walk(
            node_id: int,
            node: dict[str, Any],
            chain: list[dict[str, Any]],
            rels: list[dict[str, Any]],
            visited: set[int],
        ) -> None:
            nonlocal truncated
            if len(paths) >= max_paths:
                truncated = True
                return
            if node_id == target_id and len(chain) > 1:
                paths.append(
                    self._path(chain, rels)
                )
                return
            if len(chain) - 1 >= max_depth:
                return
            relationships = await self.repository.list_graph_neighbors(
                tenant_id,
                entity_ids=[node_id],
                relationship_types=relationship_types,
                direction=direction,
                limit=_MAX_FANOUT,
            )
            for rel in relationships:
                other_id = (
                    rel["target_entity_id"]
                    if rel["source_entity_id"] == node_id
                    else rel["source_entity_id"]
                )
                if other_id in visited:
                    continue
                entity = await self._visible_entity(principal, other_id)
                if entity is None:
                    continue
                await _walk(
                    other_id,
                    entity,
                    [*chain, entity],
                    [*rels, rel],
                    {*visited, other_id},
                )
                if len(paths) >= max_paths:
                    truncated = True
                    return

        await _walk(
            source_id, source, [source], [], {source_id}
        )
        await self._audit_query(
            principal, "paths", source_id, {"target": target_id, "paths": len(paths)}
        )
        return {
            "source": source,
            "target": target,
            "paths": paths,
            "truncated": truncated,
        }

    # --- Product digital thread ---------------------------------------
    async def digital_thread(
        self, principal: Principal, product_id: int
    ) -> dict[str, Any]:
        root = await self.graph.get_entity(principal, product_id)
        if root["entity_type"] != "product":
            raise ValidationError("digital thread requires a product entity")
        result = await self.traverse(
            principal,
            product_id,
            direction="both",
            max_depth=4,
            limit=MAX_RESULTS,
        )
        sections: dict[str, list[dict[str, Any]]] = {
            "parts": [],
            "cad_models": [],
            "boms": [],
            "bom_lines": [],
            "documents": [],
            "changes": [],
            "releases": [],
            "requirements": [],
            "manufacturing": [],
            "quality": [],
        }
        mapping = {
            "part": "parts",
            "cad_model": "cad_models",
            "ebom": "boms",
            "mbom": "boms",
            "bom_line": "bom_lines",
            "document": "documents",
            "specification": "documents",
            "engineering_change": "changes",
            "change_request": "changes",
            "release": "releases",
            "requirement": "requirements",
            "manufacturing_process": "manufacturing",
            "operation": "manufacturing",
            "work_instruction": "manufacturing",
            "plant": "manufacturing",
            "work_center": "manufacturing",
            "quality_issue": "quality",
            "nonconformance": "quality",
            "corrective_action": "quality",
        }
        for node in result["nodes"]:
            bucket = mapping.get(node["entity_type"])
            if bucket:
                sections[bucket].append(node)
        await self._audit_query(
            principal, "digital_thread", product_id, {"nodes": len(result["nodes"])}
        )
        return {
            "product": root,
            "sections": sections,
            "relationships": result["relationships"],
            "paths": result["paths"],
            "truncated": result.get("truncated", False),
        }

    # --- Where-used analysis ------------------------------------------
    async def where_used(
        self, principal: Principal, part_id: int, *, max_depth: int = 3
    ) -> dict[str, Any]:
        max_depth = max(1, min(int(max_depth), MAX_DEPTH))
        part = await self.graph.get_entity(principal, part_id)
        if part["entity_type"] != "part":
            raise ValidationError("where-used requires a part entity")
        traversal = await self.traverse(
            principal,
            part_id,
            direction="incoming",
            max_depth=max_depth,
            limit=MAX_RESULTS,
        )
        direct = await self.neighbors(
            principal,
            part_id,
            direction="incoming",
            limit=MAX_RESULTS,
        )
        used_by: list[dict[str, Any]] = []
        products: dict[int, dict[str, Any]] = {}
        boms: dict[int, dict[str, Any]] = {}
        for item in direct["neighbors"]:
            entity = item["entity"]
            used_by.append(
                {
                    "entity": entity,
                    "path": [part, entity],
                    "relationships": [item["relationship"]],
                    "depth": 1,
                }
            )
            if entity["entity_type"] == "product":
                products[entity["id"]] = entity
            if entity["entity_type"] in ("ebom", "mbom"):
                boms[entity["id"]] = entity
        for node in traversal["nodes"]:
            if node["entity_type"] == "product":
                products.setdefault(node["id"], node)
            if node["entity_type"] in ("ebom", "mbom"):
                boms.setdefault(node["id"], node)
        await self._audit_query(principal, "where_used", part_id, {"results": len(used_by)})
        return {
            "part": part,
            "used_by": used_by,
            "products": list(products.values()),
            "boms": list(boms.values()),
            "truncated": traversal.get("truncated", False),
        }

    # --- Change impact analysis ---------------------------------------
    async def change_impact(
        self, principal: Principal, change_id: int, *, max_depth: int = 3
    ) -> dict[str, Any]:
        max_depth = max(1, min(int(max_depth), MAX_DEPTH))
        change = await self.graph.get_entity(principal, change_id)
        if change["entity_type"] not in ("engineering_change", "change_request"):
            raise ValidationError(
                "impact analysis requires an engineering change or change request"
            )
        direct = await self.neighbors(
            principal,
            change_id,
            direction="outgoing",
            relationship_types=["affects", "results_in"],
            limit=MAX_RESULTS,
        )
        traversal = await self.traverse(
            principal,
            change_id,
            direction="outgoing",
            relationship_types=["affects", "results_in"],
            max_depth=max_depth,
            limit=MAX_RESULTS,
        )
        affected: list[dict[str, Any]] = []
        seen: set[int] = set()
        for item in direct["neighbors"]:
            entity = item["entity"]
            if entity["id"] == change_id or entity["id"] in seen:
                continue
            seen.add(entity["id"])
            affected.append(
                {
                    "entity": entity,
                    "impact": "direct",
                    "confidence": _confidence(item["relationship"].get("confidence")),
                    "path": [change, entity],
                    "relationships": [item["relationship"]],
                    "depth": 1,
                }
            )
        for path in traversal["paths"]:
            last = path["nodes"][-1]
            if last["id"] == change_id or last["id"] in seen:
                continue
            seen.add(last["id"])
            affected.append(
                {
                    "entity": last,
                    "impact": "indirect",
                    "confidence": _confidence(path.get("confidence")),
                    "path": path["nodes"],
                    "relationships": path["relationships"],
                    "depth": len(path["nodes"]) - 1,
                }
            )
        # Downstream operations and quality records reachable from affected
        # parts are explicitly flagged as inferred.
        affected_ids = [item["entity"]["id"] for item in affected]
        inferred = False
        if affected_ids:
            downstream = await self.traverse(
                principal,
                affected_ids[0],
                direction="outgoing",
                max_depth=2,
                limit=MAX_RESULTS,
            )
            for node in downstream["nodes"]:
                if node["id"] in seen or node["id"] == change_id:
                    continue
                if node["entity_type"] not in (
                    "manufacturing_process",
                    "operation",
                    "quality_issue",
                    "nonconformance",
                ):
                    continue
                seen.add(node["id"])
                inferred = True
                affected.append(
                    {
                        "entity": node,
                        "impact": "inferred_downstream",
                        "confidence": 0.5,
                        "path": [change, node],
                        "relationships": [],
                        "depth": 2,
                    }
                )
        direct_count = sum(1 for item in affected if item["impact"] == "direct")
        await self._audit_query(
            principal, "change_impact", change_id, {"affected": len(affected)}
        )
        return {
            "change": change,
            "affected": affected,
            "direct_count": direct_count,
            "indirect_count": len(affected) - direct_count,
            "truncated": traversal.get("truncated", False),
            "inferred": inferred,
        }

    # --- Traceability --------------------------------------------------
    async def traceability(
        self,
        principal: Principal,
        root_id: int,
        *,
        max_depth: int = 4,
    ) -> dict[str, Any]:
        max_depth = max(1, min(int(max_depth), MAX_DEPTH))
        root = await self.graph.get_entity(principal, root_id)
        traversal = await self.traverse(
            principal,
            root_id,
            direction="both",
            max_depth=max_depth,
            limit=MAX_RESULTS,
        )
        nodes = {root["id"]: root}
        for node in traversal["nodes"]:
            nodes[node["id"]] = node
        links: list[dict[str, Any]] = []
        linked: set[int] = set()
        for relationship in traversal["relationships"]:
            source = nodes.get(relationship["source_entity_id"])
            target = nodes.get(relationship["target_entity_id"])
            if source is None or target is None:
                continue
            links.append(
                {
                    "source": source,
                    "target": target,
                    "relationship_type": relationship["relationship_type"],
                    "inferred": False,
                    "confidence": _confidence(relationship.get("confidence")),
                    "path": [source, target],
                }
            )
            linked.add(source["id"])
            linked.add(target["id"])
        orphaned = [
            node
            for node in traversal["nodes"]
            if node["id"] not in linked
        ]
        await self._audit_query(
            principal, "traceability", root_id, {"links": len(links)}
        )
        return {
            "root": root,
            "links": links,
            "orphaned": orphaned,
            "truncated": traversal.get("truncated", False),
        }

    # --- Tool surface (Copilot / agents) -------------------------------
    async def run_tool(
        self, principal: Principal, name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        """Execute an allowlisted graph read and return a bounded summary.

        The result is deliberately small: identifiers, types and confidence.
        Full entity bodies are never returned to a model, mirroring the
        enterprise tool contract so retrieved graph content stays untrusted and
        cannot be used to smuggle instructions.
        """

        if name == "graph.search":
            query = str(args.get("query") or "").strip()
            if not query:
                raise ValidationError("query is required")
            entity_types = args.get("entity_types")
            entities, total = await self.graph.list_entities(
                principal,
                entity_types=[
                    str(item)[:64]
                    for item in (entity_types or [])
                    if isinstance(item, (str, int))
                ][:10]
                or None,
                query=query[:200],
                lifecycle_status=None,
                source_system=None,
                limit=10,
                offset=0,
            )
            return {
                "tool": name,
                "total": total,
                "rows": [_entity_summary(entity) for entity in entities[:10]],
            }
        entity_id = args.get("entity_id")
        try:
            resolved_id = int(entity_id)
        except (TypeError, ValueError) as exc:
            raise ValidationError("entity_id is required") from exc
        if name == "graph.neighbors":
            result = await self.neighbors(
                principal, resolved_id, direction="both", limit=25
            )
            return {
                "tool": name,
                "root": _entity_summary(result["root"]),
                "rows": [
                    {
                        "entity": _entity_summary(item["entity"]),
                        "relationship_type": item["relationship"]["relationship_type"],
                        "direction": item["direction"],
                    }
                    for item in result["neighbors"][:25]
                ],
            }
        if name == "graph.where_used":
            result = await self.where_used(principal, resolved_id)
            return {
                "tool": name,
                "part": _entity_summary(result["part"]),
                "rows": [
                    _entity_summary(item["entity"]) for item in result["used_by"][:25]
                ],
                "products": [_entity_summary(e) for e in result["products"][:25]],
                "boms": [_entity_summary(e) for e in result["boms"][:25]],
            }
        if name == "graph.change_impact":
            result = await self.change_impact(principal, resolved_id)
            return {
                "tool": name,
                "change": _entity_summary(result["change"]),
                "rows": [
                    {
                        **_entity_summary(item["entity"]),
                        "impact": item["impact"],
                        "confidence": item["confidence"],
                    }
                    for item in result["affected"][:25]
                ],
                "inferred": result["inferred"],
            }
        if name == "graph.digital_thread":
            result = await self.digital_thread(principal, resolved_id)
            return {
                "tool": name,
                "product": _entity_summary(result["product"]),
                "sections": {
                    key: [_entity_summary(entity) for entity in values[:10]]
                    for key, values in result["sections"].items()
                    if values
                },
            }
        raise ValidationError("unknown graph tool")

    # --- Helpers -------------------------------------------------------
    async def _visible_entity(
        self, principal: Principal, entity_id: int
    ) -> dict[str, Any] | None:
        try:
            return await self.graph.get_entity(principal, entity_id)
        except NotFoundError:
            return None

    def _build_paths(
        self,
        root_id: int,
        nodes: list[dict[str, Any]],
        parent_of: dict[int, int],
        edge_to: dict[int, dict[str, Any]],
        visited: dict[int, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        paths: list[dict[str, Any]] = []
        for node in nodes:
            chain = [node]
            rels: list[dict[str, Any]] = []
            current = node["id"]
            seen = {current}
            while current in parent_of and len(chain) <= MAX_DEPTH + 1:
                edge = edge_to.get(current)
                parent = parent_of[current]
                if edge is not None:
                    rels.append(edge)
                chain.append(visited[parent])
                current = parent
                if current in seen:
                    break
                seen.add(current)
            chain.reverse()
            rels.reverse()
            if len(chain) > 1:
                paths.append(self._path(chain, rels))
        return paths

    @staticmethod
    def _path(
        nodes: list[dict[str, Any]], rels: list[dict[str, Any]]
    ) -> dict[str, Any]:
        confidence = 1.0
        for rel in rels:
            confidence *= _confidence(rel.get("confidence"))
        return {
            "nodes": nodes,
            "relationships": rels,
            "confidence": round(confidence, 3),
            "score": round(confidence / max(1, len(rels)), 3),
        }

    async def _audit_query(
        self,
        principal: Principal,
        action: str,
        entity_id: int,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=f"ai.graph.query.{action}",
            resource_type="graph_entity",
            resource_id=str(entity_id),
            detail=detail,
        )
