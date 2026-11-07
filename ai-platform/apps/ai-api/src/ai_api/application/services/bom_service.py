"""BOM structure, comparison and intelligence services (Stage 8 / Step 6).

Built directly on the product-domain records (items, revisions, BOM headers and
lines) that Stage 8 adds. The knowledge graph is used only for cross-domain
navigation (where-used, change impact, digital thread); BOM structure itself is
read from the domain tables so the services never duplicate the graph model.

Safety properties enforced here, not by callers:

* multi-level expansion is depth- and result-bounded and cycle-safe;
* comparison matches lines by stable identity (parent + component + line key),
  so a reordered line is not reported as an add/remove;
* transformation produces *proposals* only and never writes authoritative BOM
  lines;
* similarity/duplicate detection is advisory: exact identity is labelled
  ``exact`` and every heuristic candidate carries the reason it was flagged.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.graph_query_service import GraphQueryService
from ai_api.application.services.graph_service import GraphService
from ai_api.application.services.product_service import ProductService
from ai_api.domain.errors import ValidationError
from ai_api.domain.product import (
    CHANGE_ADDED,
    CHANGE_MODIFIED,
    CHANGE_MOVED,
    CHANGE_REMOVED,
    CHANGE_UNCHANGED,
    COMPARED_LINE_ATTRIBUTES,
    DUPLICATE_EXACT,
    DUPLICATE_SIMILAR,
    EXCEPTION_MISSING_IN_MBOM,
    EXCEPTION_MULTIPLE_MAPPINGS,
    EXCEPTION_QUANTITY_MISMATCH,
    EXCEPTION_REVISION_MISMATCH,
    EXCEPTION_UNEXPECTED_IN_MBOM,
    EXCEPTION_UNIT_MISMATCH,
    MAPPING_CONSTANT,
    MAPPING_MANY_TO_ONE,
    MAPPING_ONE_TO_MANY,
    MAPPING_ONE_TO_ONE,
    MAPPING_UNMATCHED,
    MAX_BOM_DEPTH,
    MAX_BOM_LINES,
    MAX_COMPARE_LINES,
    MAX_INTELLIGENCE_ROWS,
    RECONCILIATION_EXCEPTIONS,
    RECONCILIATION_MATCHED,
    SIMILARITY_ATTRIBUTE_KEYS,
)
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("bom_intelligence")


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _line_identity(line: dict[str, Any]) -> str:
    """Stable identity independent of position/reordering."""

    return f"{line['parent_revision_id']}:{line['child_item_id']}:{line['line_key']}"


class BomService:
    def __init__(
        self,
        repository: AiRepository,
        products: ProductService,
        audit: AuditService,
        graph: GraphService,
        graph_query: GraphQueryService,
        events: EventPublisher | None = None,
    ) -> None:
        self.repository = repository
        self.products = products
        self.audit = audit
        self.graph = graph
        self.graph_query = graph_query
        self.events = events

    # --- Structure / explosion -----------------------------------------
    async def structure(
        self,
        principal: Principal,
        header_id: int,
        *,
        max_depth: int = 5,
        limit: int = 500,
        direction: str = "both",
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        header = await self.products.get_header(principal, header_id)
        if direction not in ("up", "down", "both"):
            raise ValidationError("direction must be up, down or both")
        max_depth = max(1, min(int(max_depth), MAX_BOM_DEPTH))
        limit = max(1, min(int(limit), MAX_BOM_LINES))

        root_item = (
            await self.repository.get_product_item(tenant_id, header["root_item_id"])
            if header.get("root_item_id")
            else None
        )

        # Downward expansion: start from the header's root revision when set,
        # otherwise from every parent revision present in the header.
        rows: list[dict[str, Any]] = []
        cycles: list[list[int]] = []
        truncated = False
        max_depth_reached = 0

        roots: list[int] = []
        if header.get("root_revision_id"):
            roots = [header["root_revision_id"]]
        else:
            parents, _ = await self.repository.list_bom_lines(
                tenant_id,
                header_id=header_id,
                parent_revision_id=None,
                child_item_id=None,
                active_only=True,
                limit=MAX_BOM_LINES,
                offset=0,
            )
            roots = sorted({line["parent_revision_id"] for line in parents})

        # Cache child item/revision lookups for readable labels.
        item_cache: dict[int, dict[str, Any] | None] = {}
        revision_cache: dict[int, dict[str, Any] | None] = {}

        async def item(item_id: int) -> dict[str, Any] | None:
            if item_id not in item_cache:
                item_cache[item_id] = await self.repository.get_product_item(
                    tenant_id, item_id
                )
            return item_cache[item_id]

        async def revision(revision_id: int | None) -> dict[str, Any] | None:
            if revision_id is None:
                return None
            if revision_id not in revision_cache:
                revision_cache[revision_id] = await self.repository.get_product_revision(
                    tenant_id, revision_id
                )
            return revision_cache[revision_id]

        frontier: list[tuple[int, int, tuple[int, ...], float]] = [
            (root_id, 1, (root_id,), 1.0) for root_id in roots
        ]
        # child item -> revision of the child used for further expansion, taken
        # from line.child_revision_id or the latest revision of the child item.
        expanded_revisions: set[int] = set()
        while frontier and not truncated:
            next_frontier: list[tuple[int, int, tuple[int, ...], float]] = []
            parent_ids = [entry[0] for entry in frontier]
            lines = await self.repository.list_bom_lines_by_parents(
                tenant_id, header_id, parent_ids
            )
            by_parent: dict[int, list[dict[str, Any]]] = defaultdict(list)
            for line in lines:
                by_parent[line["parent_revision_id"]].append(line)
            readable_ids = {
                row["id"]
                for row in await self.products._readable_many(  # noqa: SLF001
                    principal, lines
                )
            }
            for parent_revision_id, depth, path, cumulative in frontier:
                for line in by_parent.get(parent_revision_id, []):
                    if len(rows) >= limit:
                        truncated = True
                        break
                    if line["id"] not in readable_ids:
                        continue
                    child_revision_id = line.get("child_revision_id")
                    child_rev = await revision(child_revision_id)
                    child_item = await item(line["child_item_id"])
                    child_label_key = child_item["item_key"] if child_item else None
                    line_cumulative = cumulative * _num(line["quantity"], 1.0)
                    rows.append(
                        {
                            "line_id": line["id"],
                            "line_key": line["line_key"],
                            "child_item_id": line["child_item_id"],
                            "child_item_key": child_label_key,
                            "child_name": (child_item or {}).get("name"),
                            "child_revision_id": child_revision_id,
                            "child_revision": (child_rev or {}).get("revision"),
                            "quantity": _num(line["quantity"], 1.0),
                            "unit_of_measure": line["unit_of_measure"],
                            "find_number": line.get("find_number"),
                            "sequence": int(line.get("sequence") or 0),
                            "depth": depth,
                            "path": list(path),
                            "cumulative_quantity": round(line_cumulative, 6),
                            "is_phantom": bool(line.get("is_phantom")),
                            "is_reference": bool(line.get("is_reference")),
                            "has_children": False,
                        }
                    )
                    max_depth_reached = max(max_depth_reached, depth)
                    if depth >= max_depth:
                        continue
                    # Determine the revision to expand this child through. Only
                    # expand when the child has a usable revision.
                    expand_revision = child_revision_id
                    if expand_revision is None:
                        revisions, _ = await self.repository.list_product_revisions(
                            tenant_id,
                            item_id=line["child_item_id"],
                            lifecycle_status=None,
                            limit=1,
                            offset=0,
                        )
                        expand_revision = revisions[0]["id"] if revisions else None
                    if expand_revision is None:
                        continue
                    if expand_revision in path:
                        cycle = [*path, expand_revision]
                        if cycle not in cycles:
                            cycles.append(cycle)
                        continue
                    expanded_revisions.add(expand_revision)
                    next_frontier.append(
                        (expand_revision, depth + 1, (*path, expand_revision), line_cumulative)
                    )
                if truncated:
                    break
            frontier = next_frontier

        for row in rows:
            row["has_children"] = row["child_revision_id"] in expanded_revisions

        await self._audit(principal, "structure", header_id, {"rows": len(rows)})
        return {
            "header": header,
            "root_item": root_item,
            "rows": rows,
            "total": len(rows),
            "max_depth_reached": max_depth_reached,
            "truncated": truncated,
            "cycle_detected": bool(cycles),
            "cycles": cycles,
        }

    # --- Comparison -----------------------------------------------------
    async def compare(
        self,
        principal: Principal,
        left_header_id: int,
        right_header_id: int,
        *,
        scope: str = "line",
    ) -> dict[str, Any]:
        if scope not in ("line", "recursive"):
            raise ValidationError("scope must be line or recursive")
        left_header = await self.products.get_header(principal, left_header_id)
        right_header = await self.products.get_header(principal, right_header_id)
        left_lines = await self._all_lines(principal, left_header_id)
        right_lines = await self._all_lines(principal, right_header_id)

        left_index = {_line_identity(line): line for line in left_lines}
        right_index = {_line_identity(line): line for line in right_lines}
        diffs: list[dict[str, Any]] = []
        truncated = len(left_index) > MAX_COMPARE_LINES or len(right_index) > MAX_COMPARE_LINES
        matched: set[str] = set()

        for identity, left in left_index.items():
            right = right_index.get(identity)
            if right is None:
                diffs.append(
                    self._diff(CHANGE_REMOVED, identity, left=left, right=None)
                )
                continue
            matched.add(identity)
            changes = self._changed_attributes(left, right)
            positional = self._position_changed(left, right)
            if changes or positional:
                change_type = CHANGE_MODIFIED
                if not changes and positional:
                    change_type = CHANGE_MOVED
                diffs.append(
                    self._diff(
                        change_type,
                        identity,
                        left=left,
                        right=right,
                        changes=changes
                        + (["position"] if positional else []),
                    )
                )
            else:
                diffs.append(
                    self._diff(CHANGE_UNCHANGED, identity, left=left, right=right)
                )

        for identity, right in right_index.items():
            if identity in matched:
                continue
            diffs.append(self._diff(CHANGE_ADDED, identity, left=None, right=right))

        summary = {
            CHANGE_ADDED: sum(1 for d in diffs if d["change_type"] == CHANGE_ADDED),
            CHANGE_REMOVED: sum(1 for d in diffs if d["change_type"] == CHANGE_REMOVED),
            CHANGE_MODIFIED: sum(1 for d in diffs if d["change_type"] == CHANGE_MODIFIED),
            CHANGE_MOVED: sum(1 for d in diffs if d["change_type"] == CHANGE_MOVED),
            CHANGE_UNCHANGED: sum(
                1 for d in diffs if d["change_type"] == CHANGE_UNCHANGED
            ),
            "total": len(diffs),
        }
        await self._audit(
            principal,
            "compare",
            left_header_id,
            {
                "right_header_id": right_header_id,
                "scope": scope,
                "changed": summary[CHANGE_ADDED]
                + summary[CHANGE_REMOVED]
                + summary[CHANGE_MODIFIED]
                + summary[CHANGE_MOVED],
            },
        )
        return {
            "left_header_id": left_header["id"],
            "right_header_id": right_header["id"],
            "scope": scope,
            "summary": summary,
            "diffs": diffs,
            "truncated": truncated,
        }

    async def _all_lines(
        self, principal: Principal, header_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        lines, _ = await self.repository.list_bom_lines(
            tenant_id,
            header_id=header_id,
            parent_revision_id=None,
            child_item_id=None,
            active_only=True,
            limit=MAX_COMPARE_LINES,
            offset=0,
        )
        return await self.products._readable_many(principal, lines)  # noqa: SLF001

    @staticmethod
    def _changed_attributes(
        left: dict[str, Any], right: dict[str, Any]
    ) -> list[str]:
        changes: list[str] = []
        for attribute in COMPARED_LINE_ATTRIBUTES:
            if attribute == "quantity":
                if round(_num(left.get(attribute)), 6) != round(
                    _num(right.get(attribute)), 6
                ):
                    changes.append(attribute)
            elif attribute == "child_revision_id":
                if left.get(attribute) != right.get(attribute):
                    changes.append(attribute)
            elif attribute == "reference_designators":
                if sorted(left.get(attribute) or []) != sorted(right.get(attribute) or []):
                    changes.append(attribute)
            elif left.get(attribute) != right.get(attribute):
                changes.append(attribute)
        return changes

    @staticmethod
    def _position_changed(left: dict[str, Any], right: dict[str, Any]) -> bool:
        return (
            left.get("find_number") != right.get("find_number")
            or int(left.get("sequence") or 0) != int(right.get("sequence") or 0)
        )

    @staticmethod
    def _diff(
        change_type: str,
        identity: str,
        *,
        left: dict[str, Any] | None,
        right: dict[str, Any] | None,
        changes: list[str] | None = None,
    ) -> dict[str, Any]:
        anchor = left or right or {}
        return {
            "change_type": change_type,
            "line_key": anchor.get("line_key"),
            "child_item_id": anchor.get("child_item_id"),
            "left_line_id": (left or {}).get("id"),
            "right_line_id": (right or {}).get("id"),
            "parent_revision_id": anchor.get("parent_revision_id"),
            "changes": changes or [],
            "before": _line_snapshot(left),
            "after": _line_snapshot(right),
        }

    # --- EBOM -> MBOM transformation -----------------------------------
    async def transform(
        self,
        principal: Principal,
        *,
        source_header_id: int,
        target_header_id: int | None,
        mode: str = "DRY_RUN",
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        if mode not in ("DRY_RUN", "EXECUTE"):
            raise ValidationError("mode must be DRY_RUN or EXECUTE")
        source = await self.products.get_header(principal, source_header_id)
        if source["bom_type"] not in ("EBOM", "BOP", "OTHER"):
            raise ValidationError("source BOM must be an engineering BOM")
        target = None
        if target_header_id is not None:
            target = await self.products.get_header(principal, target_header_id)
            if target["bom_type"] != "MBOM":
                raise ValidationError("target BOM must be a manufacturing BOM")

        source_lines = await self._all_lines(principal, source_header_id)
        target_by_identity: dict[str, dict[str, Any]] = {}
        if target is not None:
            for line in await self._all_lines(principal, target["id"]):
                target_by_identity[_line_identity(line)] = line

        entries: list[dict[str, Any]] = []
        counts = {
            MAPPING_ONE_TO_ONE: 0,
            MAPPING_ONE_TO_MANY: 0,
            MAPPING_MANY_TO_ONE: 0,
            MAPPING_UNMATCHED: 0,
            MAPPING_CONSTANT: 0,
        }
        grouped_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for line in source_lines:
            grouped_source[_line_identity(line)].append(line)

        for identity, lines in grouped_source.items():
            matches = [target_by_identity.get(identity)]
            matches = [m for m in matches if m is not None]
            if len(lines) > 1 and len(matches) >= 1:
                mapping = MAPPING_MANY_TO_ONE
            elif len(matches) == 1:
                mapping = MAPPING_ONE_TO_ONE
            else:
                mapping = MAPPING_UNMATCHED
            counts[mapping] += len(lines)
            for line in lines:
                entries.append(
                    {
                        "source_line_id": line["id"],
                        "target_line_id": (matches[0]["id"] if matches else None),
                        "mapping_type": mapping,
                        "quantity": _num(line["quantity"], 1.0)
                        * (len(lines) if mapping == MAPPING_MANY_TO_ONE else 1),
                        "unit_of_measure": line["unit_of_measure"],
                        "notes": None
                        if mapping != MAPPING_UNMATCHED
                        else "no matching MBOM line",
                    }
                )

        summary = {
            "source_header_id": source["id"],
            "target_header_id": (target or {}).get("id"),
            "mode": mode,
            "source_lines": len(source_lines),
            "counts": counts,
        }
        # A DRY_RUN never persists a proposal. An EXECUTE run persists the
        # proposal (entries), never authoritative BOM lines.
        if mode == "EXECUTE":
            run = await self.repository.add_bom_transformation_run(
                tenant_id,
                {
                    "source_header_id": source["id"],
                    "target_header_id": (target or {}).get("id"),
                    "mode": mode,
                    "status": "completed",
                    "summary": summary,
                    "entries": entries,
                    "created_by": principal.username,
                },
            )
        else:
            run = {
                "id": None,
                "source_header_id": source["id"],
                "target_header_id": (target or {}).get("id"),
                "mode": mode,
                "status": "completed",
                "summary": summary,
                "entries": entries,
                "created_by": principal.username,
            }
        await self._audit(
            principal,
            "transform",
            source["id"],
            {"mode": mode, "entries": len(entries)},
        )
        return run

    # --- Reconciliation -------------------------------------------------
    async def reconcile(
        self,
        principal: Principal,
        *,
        source_header_id: int,
        target_header_id: int,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        source = await self.products.get_header(principal, source_header_id)
        target = await self.products.get_header(principal, target_header_id)
        if source["bom_type"] not in ("EBOM", "BOP", "OTHER"):
            raise ValidationError("source BOM must be an engineering BOM")
        if target["bom_type"] != "MBOM":
            raise ValidationError("target BOM must be a manufacturing BOM")

        source_lines = await self._all_lines(principal, source_header_id)
        target_lines = await self._all_lines(principal, target_header_id)
        target_index = {_line_identity(line): line for line in target_lines}
        exceptions: list[dict[str, Any]] = []
        matched = 0

        for line in source_lines:
            identity = _line_identity(line)
            candidates = [
                t
                for t in target_lines
                if t["child_item_id"] == line["child_item_id"]
                and t["parent_revision_id"] == line["parent_revision_id"]
            ]
            if not candidates:
                exceptions.append(
                    {
                        "type": EXCEPTION_MISSING_IN_MBOM,
                        "source_line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {"line_key": line["line_key"]},
                    }
                )
                continue
            if len(candidates) > 1:
                exceptions.append(
                    {
                        "type": EXCEPTION_MULTIPLE_MAPPINGS,
                        "source_line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {"candidates": [c["id"] for c in candidates]},
                    }
                )
                continue
            target_line = candidates[0]
            target_index.pop(identity, None)
            matched += 1
            if round(_num(line["quantity"]), 6) != round(
                _num(target_line["quantity"]), 6
            ):
                exceptions.append(
                    {
                        "type": EXCEPTION_QUANTITY_MISMATCH,
                        "source_line_id": line["id"],
                        "target_line_id": target_line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {
                            "source": _num(line["quantity"]),
                            "target": _num(target_line["quantity"]),
                        },
                    }
                )
            if line["unit_of_measure"] != target_line["unit_of_measure"]:
                exceptions.append(
                    {
                        "type": EXCEPTION_UNIT_MISMATCH,
                        "source_line_id": line["id"],
                        "target_line_id": target_line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {
                            "source": line["unit_of_measure"],
                            "target": target_line["unit_of_measure"],
                        },
                    }
                )
            if line.get("child_revision_id") != target_line.get("child_revision_id"):
                exceptions.append(
                    {
                        "type": EXCEPTION_REVISION_MISMATCH,
                        "source_line_id": line["id"],
                        "target_line_id": target_line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {
                            "source": line.get("child_revision_id"),
                            "target": target_line.get("child_revision_id"),
                        },
                    }
                )

        for line in target_lines:
            identity = _line_identity(line)
            if identity in target_index:
                exceptions.append(
                    {
                        "type": EXCEPTION_UNEXPECTED_IN_MBOM,
                        "target_line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "detail": {"line_key": line["line_key"]},
                    }
                )

        status = RECONCILIATION_MATCHED if not exceptions else RECONCILIATION_EXCEPTIONS
        summary = {
            "source_lines": len(source_lines),
            "target_lines": len(target_lines),
            "matched": matched,
            "exceptions": len(exceptions),
        }
        record = await self.repository.add_bom_reconciliation(
            tenant_id,
            {
                "source_header_id": source["id"],
                "target_header_id": target["id"],
                "status": status,
                "exceptions": exceptions,
                "summary": summary,
                "created_by": principal.username,
            },
        )
        await self._audit(
            principal,
            "reconcile",
            source["id"],
            {"target_header_id": target["id"], "exceptions": len(exceptions)},
        )
        await self._emit(
            "BomReconciliationCompleted",
            tenant_id=tenant_id,
            principal=principal,
            data={
                "reconciliation_id": record["id"],
                "source_header_id": source["id"],
                "target_header_id": target["id"],
                "status": status,
                "exceptions": len(exceptions),
            },
        )
        return record

    # --- Where-used / reuse --------------------------------------------
    async def where_used(
        self,
        principal: Principal,
        item_id: int,
        *,
        bom_type: str | None = None,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        item = await self.products.get_item(principal, item_id)
        lines, _ = await self.repository.list_bom_lines(
            tenant_id,
            header_id=None,
            parent_revision_id=None,
            child_item_id=item_id,
            active_only=True,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        header_cache: dict[int, dict[str, Any] | None] = {}
        readable_line_ids = {
            row["id"]
            for row in await self.products._readable_many(  # noqa: SLF001
                principal, lines
            )
        }
        visible_lines = [line for line in lines if line["id"] in readable_line_ids]
        header_ids = {line["bom_header_id"] for line in visible_lines}
        for header_id in header_ids:
            header_cache[header_id] = await self.repository.get_bom_header(
                tenant_id, header_id
            )
        readable_headers = {
            header["id"]
            for header in await self.products._readable_many(  # noqa: SLF001
                principal,
                [header for header in header_cache.values() if header is not None],
            )
        }
        rows: list[dict[str, Any]] = []
        for line in visible_lines:
            header_id = line["bom_header_id"]
            header = header_cache.get(header_id)
            if header is None or header_id not in readable_headers:
                continue
            if bom_type and header["bom_type"] != bom_type:
                continue
            parent_revision = await self.repository.get_product_revision(
                tenant_id, line["parent_revision_id"]
            )
            parent_item = (
                await self.repository.get_product_item(
                    tenant_id, parent_revision["item_id"]
                )
                if parent_revision
                else None
            )
            rows.append(
                {
                    "item_id": item_id,
                    "item_key": item["item_key"],
                    "name": item.get("name"),
                    "kind": "where_used",
                    "occurrences": 1,
                    "reason": "direct BOM line",
                    "detail": {
                        "header_id": header["id"],
                        "bom_type": header["bom_type"],
                        "bom_key": header["bom_key"],
                        "line_id": line["id"],
                        "parent_item_id": (parent_item or {}).get("id"),
                        "parent_item_key": (parent_item or {}).get("item_key"),
                        "quantity": _num(line["quantity"]),
                    },
                }
            )

        # If the item is also a graph entity, add graph-based where-used.
        if item.get("graph_entity_id"):
            try:
                graph_result = await self.graph_query.where_used(
                    principal, item["graph_entity_id"]
                )
                for used in graph_result["used_by"]:
                    entity = used["entity"]
                    rows.append(
                        {
                            "item_id": entity.get("id"),
                            "item_key": entity.get("stable_key"),
                            "name": entity.get("name"),
                            "kind": "graph_where_used",
                            "reason": "knowledge graph relationship",
                            "detail": {"entity_type": entity.get("entity_type")},
                        }
                    )
            except Exception as exc:  # noqa: BLE001 - advisory enrichment
                logger.warning("bom.where_used_graph_failed", error=str(exc))

        await self._audit(principal, "where_used", item_id, {"rows": len(rows)})
        return {
            "item": item,
            "rows": rows,
            "total": len(rows),
            "truncated": len(rows) >= MAX_INTELLIGENCE_ROWS,
        }

    async def reuse_analysis(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        lines, _ = await self.repository.list_bom_lines(
            tenant_id,
            header_id=None,
            parent_revision_id=None,
            child_item_id=None,
            active_only=True,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        counts: dict[int, int] = defaultdict(int)
        headers_by_item: dict[int, set[int]] = defaultdict(set)
        for line in lines:
            counts[line["child_item_id"]] += 1
            headers_by_item[line["child_item_id"]].add(line["bom_header_id"])
        ordered = sorted(counts.items(), key=lambda kv: -kv[1])[:MAX_INTELLIGENCE_ROWS]
        items = [
            await self.repository.get_product_item(tenant_id, item_id)
            for item_id, _ in ordered
        ]
        visible_items = await self.products._readable_many(  # noqa: SLF001
            principal, [item for item in items if item is not None]
        )
        rows: list[dict[str, Any]] = []
        for item in visible_items:
            item_id = item["id"]
            count = counts[item_id]
            rows.append(
                {
                    "item_id": item_id,
                    "item_key": item["item_key"],
                    "name": item.get("name"),
                    "kind": "reuse",
                    "occurrences": count,
                    "score": float(count),
                    "reason": f"used in {len(headers_by_item[item_id])} BOM(s)",
                    "detail": {"bom_count": len(headers_by_item[item_id])},
                }
            )
        return {
            "kind": "reuse",
            "rows": rows,
            "total": len(rows),
            "truncated": len(rows) >= MAX_INTELLIGENCE_ROWS,
            "summary": {"items": len(rows)},
        }

    # --- Duplicate / similar detection ---------------------------------
    async def duplicate_candidates(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        items, _ = await self.repository.list_product_items(
            tenant_id,
            item_types=None,
            query=None,
            lifecycle_status=None,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        visible = await self.products._readable_many(principal, items)  # noqa: SLF001

        # Exact identity: same normalised item_key among different item rows.
        by_key: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in visible:
            by_key[item["item_key"]].append(item)
        rows: list[dict[str, Any]] = []
        for group in by_key.values():
            if len(group) < 2:
                continue
            for item in group:
                rows.append(
                    {
                        "item_id": item["id"],
                        "item_key": item["item_key"],
                        "name": item.get("name"),
                        "kind": DUPLICATE_EXACT,
                        "score": 1.0,
                        "reason": "identical normalised item key",
                        "detail": {
                            "duplicates": [
                                other["id"]
                                for other in group
                                if other["id"] != item["id"]
                            ],
                            "item_types": sorted({other["item_type"] for other in group}),
                        },
                    }
                )

        # Heuristic similarity: shared description/material/mpn. Never merged.
        for i, left in enumerate(visible):
            for right in visible[i + 1 :]:
                if left["item_key"] == right["item_key"]:
                    continue
                reason, score = self._similarity(left, right)
                if reason is None:
                    continue
                for item, other in ((left, right), (right, left)):
                    rows.append(
                        {
                            "item_id": item["id"],
                            "item_key": item["item_key"],
                            "name": item.get("name"),
                            "kind": DUPLICATE_SIMILAR,
                            "score": score,
                            "reason": reason,
                            "detail": {"candidate": other["id"]},
                        }
                    )
                if len(rows) >= MAX_INTELLIGENCE_ROWS:
                    break
            if len(rows) >= MAX_INTELLIGENCE_ROWS:
                break

        rows.sort(key=lambda r: (r["kind"] != DUPLICATE_EXACT, -r["score"]))
        await self._audit(principal, "duplicates", 0, {"rows": len(rows)})
        return {
            "kind": "duplicates",
            "rows": rows[:MAX_INTELLIGENCE_ROWS],
            "total": len(rows),
            "truncated": len(rows) >= MAX_INTELLIGENCE_ROWS,
            "summary": {
                "exact": sum(1 for r in rows if r["kind"] == DUPLICATE_EXACT),
                "similar": sum(1 for r in rows if r["kind"] == DUPLICATE_SIMILAR),
            },
        }

    @staticmethod
    def _similarity(
        left: dict[str, Any], right: dict[str, Any]
    ) -> tuple[str | None, float]:
        reasons: list[str] = []
        score = 0.0
        left_desc = str(left.get("description") or "").strip().lower()
        right_desc = str(right.get("description") or "").strip().lower()
        if left_desc and left_desc == right_desc:
            reasons.append("same description")
            score += 0.4
        left_conf = left.get("configuration") or {}
        right_conf = right.get("configuration") or {}
        for key in SIMILARITY_ATTRIBUTE_KEYS:
            if key == "description":
                continue
            lv = str(left_conf.get(key) or "").strip().lower()
            rv = str(right_conf.get(key) or "").strip().lower()
            if lv and lv == rv:
                reasons.append(f"same {key}")
                score += 0.3
        if left["unit_of_measure"] == right["unit_of_measure"]:
            score += 0.1
        if not reasons:
            return None, 0.0
        score = min(round(score, 3), 0.95)
        return "; ".join(reasons), score

    # --- BOM quality checks --------------------------------------------
    async def quality(
        self, principal: Principal, header_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        header = await self.products.get_header(principal, header_id)
        lines = await self._all_lines(principal, header_id)
        issues: list[dict[str, Any]] = []

        seen_child: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
        seen_find: dict[str, list[dict[str, Any]]] = defaultdict(list)
        seen_sequence: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for line in lines:
            seen_child[(line["parent_revision_id"], line["child_item_id"])].append(line)
            if line.get("find_number"):
                seen_find[str(line["find_number"])].append(line)
            seen_sequence[int(line.get("sequence") or 0)].append(line)
            child = await self.repository.get_product_item(tenant_id, line["child_item_id"])
            if child is None:
                issues.append(
                    {
                        "rule": "missing_child",
                        "severity": "error",
                        "line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "message": "BOM line references a missing item",
                        "detail": {},
                    }
                )
            elif child.get("lifecycle_status") in ("obsolete", "archived"):
                issues.append(
                    {
                        "rule": "obsolete_component",
                        "severity": "warning",
                        "line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "message": "BOM line references an obsolete component",
                        "detail": {"lifecycle_status": child.get("lifecycle_status")},
                    }
                )
            if _num(line["quantity"]) <= 0:
                issues.append(
                    {
                        "rule": "invalid_quantity",
                        "severity": "error",
                        "line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "message": "BOM line quantity must be positive",
                        "detail": {"quantity": _num(line["quantity"])},
                    }
                )
            if not line.get("unit_of_measure"):
                issues.append(
                    {
                        "rule": "missing_uom",
                        "severity": "error",
                        "line_id": line["id"],
                        "child_item_id": line["child_item_id"],
                        "message": "BOM line is missing a unit of measure",
                        "detail": {},
                    }
                )

        for (parent, child), group in seen_child.items():
            if len(group) > 1:
                for line in group:
                    issues.append(
                        {
                            "rule": "duplicate_line",
                            "severity": "warning",
                            "line_id": line["id"],
                            "child_item_id": child,
                            "message": "Component appears more than once under the same parent",
                            "detail": {
                                "parent_revision_id": parent,
                                "lines": [item["id"] for item in group],
                            },
                        }
                    )
        for find_number, group in seen_find.items():
            if len(group) > 1:
                for line in group:
                    issues.append(
                        {
                            "rule": "duplicate_find_number",
                            "severity": "warning",
                            "line_id": line["id"],
                            "child_item_id": line["child_item_id"],
                            "message": "Find number is not unique within the BOM",
                            "detail": {"find_number": find_number},
                        }
                    )

        # Cycle detection over the assembled structure.
        cycle = await self._detect_cycle(principal, header)
        if cycle:
            issues.append(
                {
                    "rule": "circular_structure",
                    "severity": "error",
                    "line_id": None,
                    "child_item_id": None,
                    "message": "BOM structure contains a circular reference",
                    "detail": {"cycle": cycle},
                }
            )

        errors = sum(1 for i in issues if i["severity"] == "error")
        warnings = sum(1 for i in issues if i["severity"] == "warning")
        status = "fail" if errors else ("warning" if warnings else "pass")
        score = 1.0 if not issues else max(0.0, 1.0 - (errors * 0.2 + warnings * 0.05))
        await self._audit(principal, "quality", header_id, {"issues": len(issues)})
        return {
            "header_id": header["id"],
            "status": status,
            "score": round(score, 3),
            "issues": issues,
            "summary": {"errors": errors, "warnings": warnings, "total": len(issues)},
            "truncated": False,
        }

    async def _detect_cycle(
        self, principal: Principal, header: dict[str, Any]
    ) -> list[int] | None:
        lines = await self._all_lines(principal, header["id"])
        by_parent: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for line in lines:
            by_parent[line["parent_revision_id"]].append(line)
        visited: set[int] = set()
        stack: list[int] = []

        async def walk(revision_id: int) -> list[int] | None:
            if revision_id in stack:
                start = stack.index(revision_id)
                return [*stack[start:], revision_id]
            if revision_id in visited:
                return None
            stack.append(revision_id)
            for line in by_parent.get(revision_id, []):
                child_revision = line.get("child_revision_id")
                if child_revision is None:
                    continue
                found = await walk(child_revision)
                if found:
                    return found
            stack.pop()
            visited.add(revision_id)
            return None

        for parent in list(by_parent):
            found = await walk(parent)
            if found:
                return found
        return None

    # --- Statistics -----------------------------------------------------
    async def stats(self, principal: Principal) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        counts = await self.repository.count_product_items_by_type(tenant_id)
        by_type = {row["item_type"]: int(row["total"]) for row in counts}
        _, total_revisions = await self.repository.list_product_revisions(
            tenant_id, item_id=None, lifecycle_status=None, limit=0, offset=0
        )
        _, ebom_total = await self.repository.list_bom_headers(
            tenant_id,
            bom_type="EBOM",
            root_item_id=None,
            query=None,
            lifecycle_status=None,
            limit=0,
            offset=0,
        )
        _, mbom_total = await self.repository.list_bom_headers(
            tenant_id,
            bom_type="MBOM",
            root_item_id=None,
            query=None,
            lifecycle_status=None,
            limit=0,
            offset=0,
        )
        all_lines, total_lines = await self.repository.list_bom_lines(
            tenant_id,
            header_id=None,
            parent_revision_id=None,
            child_item_id=None,
            active_only=False,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        items, item_total = await self.repository.list_product_items(
            tenant_id,
            item_types=None,
            query=None,
            lifecycle_status=None,
            limit=MAX_INTELLIGENCE_ROWS,
            offset=0,
        )
        obsolete = sum(
            1 for item in items if item.get("lifecycle_status") == "obsolete"
        )
        used_item_ids = {
            line["child_item_id"] for line in all_lines if line["line_status"] == "active"
        }
        orphan_parts = sum(
            1
            for item in items
            if item["item_type"] == "part" and item["id"] not in used_item_ids
        )
        return {
            "items": item_total,
            "products": by_type.get("product", 0),
            "parts": by_type.get("part", 0),
            "assemblies": by_type.get("assembly", 0),
            "revisions": total_revisions,
            "eboms": ebom_total,
            "mboms": mbom_total,
            "bom_lines": total_lines,
            "orphan_parts": orphan_parts,
            "obsolete_items": obsolete,
            "status": "ok",
        }

    # --- Change impact --------------------------------------------------
    async def change_impact(
        self, principal: Principal, change_entity_id: int, *, max_depth: int = 3
    ) -> dict[str, Any]:
        result = await self.graph_query.change_impact(
            principal, change_entity_id, max_depth=max_depth
        )
        affected_items: list[dict[str, Any]] = []
        affected_boms: list[dict[str, Any]] = []
        paths: list[dict[str, Any]] = []
        for item in result["affected"]:
            entity = item["entity"]
            row = {
                "item_id": entity.get("id"),
                "item_key": entity.get("stable_key"),
                "name": entity.get("name"),
                "kind": item["impact"],
                "score": item.get("confidence", 1.0),
                "reason": f"{item['impact']} impact via graph",
                "detail": {"entity_type": entity.get("entity_type")},
            }
            if entity.get("entity_type") in ("ebom", "mbom", "bom_line"):
                affected_boms.append(row)
            else:
                affected_items.append(row)
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
            principal,
            "change_impact",
            change_entity_id,
            {"affected": len(result["affected"])},
        )
        return {
            "change_entity_id": change_entity_id,
            "affected_items": affected_items,
            "affected_boms": affected_boms,
            "inferred": result.get("inferred", False),
            "paths": paths,
            "truncated": result.get("truncated", False),
        }

    # --- Helpers --------------------------------------------------------
    async def _audit(
        self,
        principal: Principal,
        action: str,
        resource_id: int,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=f"ai.bom.query.{action}",
            resource_type="bom_header",
            resource_id=str(resource_id),
            detail=detail,
        )

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
                subject_type="bom_header",
                data=data,
            )
        except Exception as exc:  # noqa: BLE001 - publishing must not break writes
            logger.warning("bom.event_publish_failed", error=str(exc))


def _line_snapshot(line: dict[str, Any] | None) -> dict[str, Any] | None:
    if line is None:
        return None
    return {
        "line_id": line.get("id"),
        "line_key": line.get("line_key"),
        "child_item_id": line.get("child_item_id"),
        "child_revision_id": line.get("child_revision_id"),
        "quantity": _num(line.get("quantity")),
        "unit_of_measure": line.get("unit_of_measure"),
        "find_number": line.get("find_number"),
        "sequence": int(line.get("sequence") or 0),
        "is_phantom": bool(line.get("is_phantom")),
        "is_reference": bool(line.get("is_reference")),
    }
