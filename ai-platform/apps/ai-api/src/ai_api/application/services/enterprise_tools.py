"""Authorized enterprise tools for the Copilot (Stage 5).

Design rules:

* Every tool calls an **existing** enterprise endpoint through the ordinary HTTP
  API, forwarding the caller's own session token. Authorization is therefore
  evaluated by the enterprise services exactly as for a direct request; the AI
  platform never re-implements BOM/PDM/quality/change logic and never holds a
  privileged service credential.
* The tool registry here is an explicit allowlist of read endpoints. There is no
  generic "call any path" escape hatch, so a prompt cannot widen the surface.
* Results are reduced to a bounded, non-sensitive summary before they reach the
  model, the transcript or the tool-invocation trace. Full enterprise payloads
  never enter the conversation store.
* A tool whose capability the caller lacks is refused *before* the network call
  and recorded as `denied`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    ValidationError,
)
from ai_api.security.policies import Policy, Principal
from ai_api.security.request_token import current_session_token
from ai_api.telemetry.logging import get_logger
from ai_api.telemetry.metrics import observe_tool_call

logger = get_logger("copilot.tools")

TOOL_ENTERPRISE_SEARCH = "enterprise.search"
TOOL_PRODUCT_LOOKUP = "product.lookup"
TOOL_BOM_LOOKUP = "bom.lookup"
TOOL_QUALITY_LOOKUP = "quality.lookup"
TOOL_CHANGE_LOOKUP = "change.lookup"
TOOL_PREDICTIVE_LOOKUP = "predictive.lookup"
# Knowledge graph tools execute inside the AI platform (PostgreSQL-backed) but
# obey exactly the same allowlist, capability check and bounded-summary rules as
# the enterprise HTTP tools.
TOOL_GRAPH_SEARCH = "graph.search"
TOOL_GRAPH_NEIGHBORS = "graph.neighbors"
TOOL_GRAPH_WHERE_USED = "graph.where_used"
TOOL_GRAPH_CHANGE_IMPACT = "graph.change_impact"
TOOL_GRAPH_DIGITAL_THREAD = "graph.digital_thread"
# Product & BOM intelligence tools (Stage 8). Like the graph tools they execute
# in-process against tenant-scoped data and obey the same capability check and
# bounded-summary contract.
TOOL_PRODUCT_ITEM_LOOKUP = "product.item_lookup"
TOOL_BOM_EXPAND = "bom.expand"
TOOL_BOM_COMPARE = "bom.compare"
TOOL_BOM_RECONCILE = "bom.reconcile"
TOOL_BOM_WHERE_USED = "bom.where_used"
TOOL_BOM_REUSE = "bom.reuse"
TOOL_BOM_QUALITY = "bom.quality"
TOOL_BOM_DUPLICATES = "bom.duplicates"
TOOL_BOM_CHANGE_IMPACT = "bom.change_impact"
# Manufacturing & quality intelligence tools (Stage 9). Same allowlist and
# bounded-summary contract; these execute in-process against tenant-scoped data.
TOOL_MFG_PROCESS_LOOKUP = "manufacturing.process_lookup"
TOOL_MFG_PROCESS_STRUCTURE = "manufacturing.process_structure"
TOOL_MFG_PROCESS_VALIDATE = "manufacturing.process_validate"
TOOL_MFG_WORK_CENTRE_LOOKUP = "manufacturing.work_centre_lookup"
TOOL_QUALITY_ISSUE_LOOKUP = "quality.issue_lookup"
TOOL_QUALITY_TRACEABILITY = "quality.traceability"
TOOL_QUALITY_REPEAT = "quality.repeat_issues"
TOOL_QUALITY_SUPPLIER = "quality.supplier_quality"
TOOL_QUALITY_IMPACT = "quality.impact"
# Predictive intelligence tools (Stage 10). These expose bounded, evidence-backed
# predictions and recommendations; they never present a prediction as fact.
TOOL_PRED_RISK_LOOKUP = "predictive.risk_lookup"
TOOL_PRED_EXPLAIN = "predictive.explain"
TOOL_PRED_RECOMMENDATIONS = "predictive.recommendations"
TOOL_PRED_RECOMMENDATION_FEEDBACK = "predictive.recommendation_feedback"

_LOCAL_PREDICTIVE_TOOLS: frozenset[str] = frozenset(
    {
        TOOL_PRED_RISK_LOOKUP,
        TOOL_PRED_EXPLAIN,
        TOOL_PRED_RECOMMENDATIONS,
        TOOL_PRED_RECOMMENDATION_FEEDBACK,
    }
)

_LOCAL_PRODUCT_TOOLS: frozenset[str] = frozenset(
    {
        TOOL_PRODUCT_ITEM_LOOKUP,
        TOOL_BOM_EXPAND,
        TOOL_BOM_COMPARE,
        TOOL_BOM_RECONCILE,
        TOOL_BOM_WHERE_USED,
        TOOL_BOM_REUSE,
        TOOL_BOM_QUALITY,
        TOOL_BOM_DUPLICATES,
        TOOL_BOM_CHANGE_IMPACT,
    }
)

_LOCAL_MQ_TOOLS: frozenset[str] = frozenset(
    {
        TOOL_MFG_PROCESS_LOOKUP,
        TOOL_MFG_PROCESS_STRUCTURE,
        TOOL_MFG_PROCESS_VALIDATE,
        TOOL_MFG_WORK_CENTRE_LOOKUP,
        TOOL_QUALITY_ISSUE_LOOKUP,
        TOOL_QUALITY_TRACEABILITY,
        TOOL_QUALITY_REPEAT,
        TOOL_QUALITY_SUPPLIER,
        TOOL_QUALITY_IMPACT,
    }
)


@dataclass(frozen=True, slots=True)
class EnterpriseToolSpec:
    """Declarative description of one allowlisted enterprise read."""

    name: str
    description: str
    capability: str
    method: str
    path: str | None
    intent_keywords: tuple[str, ...]
    input_schema: dict[str, Any] = field(default_factory=dict)
    read_only: bool = True
    requires_approval: bool = False


@dataclass(slots=True)
class ToolOutcome:
    name: str
    status: str
    read_only: bool
    summary: dict[str, Any]
    error_class: str | None = None
    duration_ms: int | None = None


def _trim(value: Any, limit: int = 300) -> str:
    text = "" if value is None else str(value)
    return text[:limit]


def _as_rows(payload: Any) -> tuple[list[dict[str, Any]], int]:
    """Normalize the handful of enterprise list/search envelopes we consume."""

    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)], len(payload)
    if not isinstance(payload, dict):
        return [], 0
    for key in ("results", "items", "data", "records"):
        value = payload.get(key)
        if isinstance(value, list):
            rows = [row for row in value if isinstance(row, dict)]
            total = payload.get("total") or payload.get("count") or len(rows)
            try:
                total = int(total)
            except (TypeError, ValueError):
                total = len(rows)
            return rows, total
    return [], 0


def _summarize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Keep identifiers and lifecycle facts only; drop free-form blobs."""

    summary: dict[str, Any] = {}
    mapping = (
        ("objectType", "type"),
        ("type", "type"),
        ("objectId", "id"),
        ("id", "id"),
        ("ref", "id"),
        ("reference", "id"),
        ("item_ref", "id"),
        ("bom_ref", "id"),
        ("request_ref", "id"),
        ("prediction_ref", "id"),
        ("code", "code"),
        ("item_number", "code"),
        ("request_number", "code"),
        ("bom_number", "code"),
        ("title", "title"),
        ("name", "title"),
        ("status", "status"),
        ("lifecycleState", "lifecycle_state"),
        ("lifecycle_state", "lifecycle_state"),
        ("revision", "revision"),
        ("revision_code", "revision"),
        ("severity", "severity"),
        ("overall_result", "result"),
        ("score", "score"),
        ("updatedAt", "updated_at"),
        ("updated_at", "updated_at"),
    )
    for source, target in mapping:
        if target in summary:
            continue
        value = row.get(source)
        if value is None or isinstance(value, (dict, list)):
            continue
        summary[target] = _trim(value) if isinstance(value, str) else value
    return summary


class EnterpriseToolClient:
    """Executes allowlisted enterprise reads as the calling user."""

    def __init__(
        self,
        settings: Settings,
        policy: Policy,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        graph: Any = None,
        products: Any = None,
        boms: Any = None,
        manufacturing: Any = None,
        quality: Any = None,
        predictive: Any = None,
    ) -> None:
        self._settings = settings
        self._policy = policy
        self._transport = transport
        self._graph = graph
        self._products = products
        self._boms = boms
        self._manufacturing = manufacturing
        self._quality = quality
        self._predictive = predictive
        self._specs = _build_specs()
        self._by_name = {spec.name: spec for spec in self._specs}

    def describe(self) -> list[dict[str, Any]]:
        return [
            {
                "name": spec.name,
                "description": spec.description,
                "capability": spec.capability,
                "read_only": spec.read_only,
                "requires_approval": spec.requires_approval,
                "input_schema": spec.input_schema,
            }
            for spec in self._specs
        ]

    def names(self) -> list[str]:
        return [spec.name for spec in self._specs]

    def select(self, instruction: str, *, limit: int) -> list[str]:
        """Deterministic intent-to-tool selection.

        Keyword routing keeps tool choice explainable and prevents a prompt from
        requesting an arbitrary tool by name. Calls are capped and de-duplicated.
        """

        text = (instruction or "").lower()
        scored: list[tuple[int, str]] = []
        for spec in self._specs:
            hits = sum(1 for keyword in spec.intent_keywords if keyword in text)
            if hits:
                scored.append((hits, spec.name))
        scored.sort(key=lambda item: (-item[0], item[1]))
        selected: list[str] = []
        for _, name in scored:
            if name not in selected:
                selected.append(name)
            if len(selected) >= limit:
                break
        return selected

    async def run(self, principal: Principal, name: str, args: dict[str, Any]) -> ToolOutcome:
        spec = self._by_name.get(name)
        if spec is None:
            return ToolOutcome(
                name=name,
                status="denied",
                read_only=True,
                summary={},
                error_class="unknown_tool",
            )
        try:
            self._policy.require(
                principal,
                spec.capability,
                message="not authorized to use this enterprise tool",
            )
        except AuthorizationError:
            logger.info("copilot.tool.denied", tool=name)
            return ToolOutcome(
                name=name,
                status="denied",
                read_only=spec.read_only,
                summary={},
                error_class="authorization_denied",
            )

        if spec.name.startswith("graph."):
            return await self._run_graph(principal, spec, args)
        if spec.name in _LOCAL_PRODUCT_TOOLS:
            return await self._run_product(principal, spec, args)
        if spec.name in _LOCAL_MQ_TOOLS:
            return await self._run_mq(principal, spec, args)
        if spec.name in _LOCAL_PREDICTIVE_TOOLS:
            return await self._run_predictive(principal, spec, args)

        token = current_session_token()
        if not token:
            return ToolOutcome(
                name=name,
                status="denied",
                read_only=spec.read_only,
                summary={},
                error_class="missing_session_token",
            )

        started = time.perf_counter()
        outcome = "success"
        try:
            payload = await self._request(spec, args, token)
        except httpx.TimeoutException:
            outcome = "timeout"
            logger.warning("copilot.tool.timeout", tool=name)
            return ToolOutcome(
                name=name,
                status="timeout",
                read_only=spec.read_only,
                summary={},
                error_class="timeout",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except PermissionError:
            outcome = "denied"
            return ToolOutcome(
                name=name,
                status="denied",
                read_only=spec.read_only,
                summary={},
                error_class="enterprise_denied",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            outcome = "error"
            logger.warning("copilot.tool.failed", tool=name)
            return ToolOutcome(
                name=name,
                status="failed",
                read_only=spec.read_only,
                summary={},
                error_class="enterprise_error",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        finally:
            observe_tool_call(
                tool=name,
                outcome=outcome,
                duration_seconds=time.perf_counter() - started,
            )

        rows, total = _as_rows(payload)
        limit = self._settings.ai_copilot_tool_result_limit
        summary = {
            "tool": name,
            "total": total,
            "returned": min(len(rows), limit),
            "rows": [_summarize_row(row) for row in rows[:limit]],
        }
        return ToolOutcome(
            name=name,
            status="succeeded",
            read_only=spec.read_only,
            summary=summary,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _run_graph(
        self, principal: Principal, spec: EnterpriseToolSpec, args: dict[str, Any]
    ) -> ToolOutcome:
        if self._graph is None:
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="graph_unavailable",
            )
        started = time.perf_counter()
        try:
            summary = await self._graph.run_tool(principal, spec.name, args)
        except Exception as exc:  # noqa: BLE001 - graph failures must not leak
            logger.warning("copilot.graph_tool.failed", tool=spec.name, error=str(exc))
            return ToolOutcome(
                name=spec.name,
                status="failed",
                read_only=True,
                summary={},
                error_class="graph_error",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        observe_tool_call(
            tool=spec.name,
            outcome="success",
            duration_seconds=time.perf_counter() - started,
        )
        return ToolOutcome(
            name=spec.name,
            status="succeeded",
            read_only=True,
            summary=summary,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _run_product(
        self, principal: Principal, spec: EnterpriseToolSpec, args: dict[str, Any]
    ) -> ToolOutcome:
        if self._products is None or self._boms is None:
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="product_service_unavailable",
            )
        started = time.perf_counter()
        try:
            summary = await self._product_summary(principal, spec.name, args)
        except AuthorizationError:
            logger.info("copilot.product_tool.denied", tool=spec.name)
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="authorization_denied",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception as exc:  # noqa: BLE001 - never leak internals to model
            logger.warning("copilot.product_tool.failed", tool=spec.name, error=str(exc))
            return ToolOutcome(
                name=spec.name,
                status="failed",
                read_only=True,
                summary={},
                error_class="product_error",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        observe_tool_call(
            tool=spec.name,
            outcome="success",
            duration_seconds=time.perf_counter() - started,
        )
        return ToolOutcome(
            name=spec.name,
            status="succeeded",
            read_only=True,
            summary=summary,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _product_summary(
        self, principal: Principal, name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        limit = self._settings.ai_copilot_tool_result_limit

        def _int_arg(key: str) -> int:
            try:
                return int(args.get(key))
            except (TypeError, ValueError) as exc:
                raise ValidationError(f"tool argument '{key}' is required") from exc

        if name == TOOL_PRODUCT_ITEM_LOOKUP:
            query = str(args.get("query") or "").strip() or None
            item_type = str(args.get("item_type") or "").strip() or None
            items, total = await self._products.list_items(
                principal,
                item_types=[item_type] if item_type else None,
                query=query,
                lifecycle_status=None,
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "total": total,
                "returned": min(len(items), limit),
                "rows": [
                    {
                        "id": item["id"],
                        "item_key": item["item_key"],
                        "name": item.get("name"),
                        "item_type": item.get("item_type"),
                        "lifecycle_status": item.get("lifecycle_status"),
                    }
                    for item in items[:limit]
                ],
            }
        if name == TOOL_BOM_EXPAND:
            result = await self._boms.structure(
                principal,
                _int_arg("header_id"),
                max_depth=min(int(args.get("max_depth") or 5), 20),
                limit=min(limit * 10, 5000),
                direction="down",
            )
            return {
                "tool": name,
                "total": result["total"],
                "returned": min(len(result["rows"]), limit),
                "max_depth_reached": result["max_depth_reached"],
                "truncated": result["truncated"],
                "cycle_detected": result["cycle_detected"],
                "rows": [
                    {
                        "line_id": row["line_id"],
                        "child_item_id": row["child_item_id"],
                        "child_item_key": row["child_item_key"],
                        "quantity": row["quantity"],
                        "depth": row["depth"],
                    }
                    for row in result["rows"][:limit]
                ],
            }
        if name == TOOL_BOM_COMPARE:
            result = await self._boms.compare(
                principal, _int_arg("left_header_id"), _int_arg("right_header_id")
            )
            changed = [diff for diff in result["diffs"] if diff["change_type"] != "unchanged"]
            return {
                "tool": name,
                "summary": result["summary"],
                "truncated": result["truncated"],
                "returned": min(len(changed), limit),
                "rows": [
                    {
                        "change_type": diff["change_type"],
                        "line_key": diff.get("line_key"),
                        "child_item_id": diff.get("child_item_id"),
                        "changes": diff.get("changes"),
                    }
                    for diff in changed[:limit]
                ],
            }
        if name == TOOL_BOM_RECONCILE:
            result = await self._boms.reconcile(
                principal,
                source_header_id=_int_arg("source_header_id"),
                target_header_id=_int_arg("target_header_id"),
            )
            return {
                "tool": name,
                "status": result.get("status"),
                "summary": result.get("summary"),
                "returned": min(len(result.get("exceptions") or []), limit),
                "rows": (result.get("exceptions") or [])[:limit],
            }
        if name == TOOL_BOM_WHERE_USED:
            result = await self._boms.where_used(principal, _int_arg("item_id"))
            return {
                "tool": name,
                "total": result["total"],
                "truncated": result["truncated"],
                "returned": min(len(result["rows"]), limit),
                "rows": result["rows"][:limit],
            }
        if name == TOOL_BOM_REUSE:
            result = await self._boms.reuse_analysis(principal)
            return {
                "tool": name,
                "summary": result["summary"],
                "truncated": result["truncated"],
                "returned": min(len(result["rows"]), limit),
                "rows": result["rows"][:limit],
            }
        if name == TOOL_BOM_QUALITY:
            result = await self._boms.quality(principal, _int_arg("header_id"))
            return {
                "tool": name,
                "status": result["status"],
                "score": result["score"],
                "summary": result["summary"],
                "returned": min(len(result["issues"]), limit),
                "rows": result["issues"][:limit],
            }
        if name == TOOL_BOM_DUPLICATES:
            result = await self._boms.duplicate_candidates(principal)
            return {
                "tool": name,
                "summary": result["summary"],
                "truncated": result["truncated"],
                "returned": min(len(result["rows"]), limit),
                "rows": result["rows"][:limit],
            }
        if name == TOOL_BOM_CHANGE_IMPACT:
            result = await self._boms.change_impact(principal, _int_arg("entity_id"), max_depth=3)
            rows = [*result.get("affected_items", []), *result.get("affected_boms", [])]
            return {
                "tool": name,
                "inferred": result.get("inferred"),
                "truncated": result.get("truncated"),
                "returned": min(len(rows), limit),
                "rows": rows[:limit],
            }
        raise ValidationError("unknown product tool")

    async def _run_mq(
        self, principal: Principal, spec: EnterpriseToolSpec, args: dict[str, Any]
    ) -> ToolOutcome:
        if self._manufacturing is None or self._quality is None:
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="manufacturing_quality_service_unavailable",
            )
        started = time.perf_counter()
        try:
            summary = await self._mq_summary(principal, spec.name, args)
        except AuthorizationError:
            logger.info("copilot.mq_tool.denied", tool=spec.name)
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="authorization_denied",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception as exc:  # noqa: BLE001 - never leak internals to model
            logger.warning("copilot.mq_tool.failed", tool=spec.name, error=str(exc))
            return ToolOutcome(
                name=spec.name,
                status="failed",
                read_only=True,
                summary={},
                error_class="manufacturing_quality_error",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        observe_tool_call(
            tool=spec.name,
            outcome="success",
            duration_seconds=time.perf_counter() - started,
        )
        return ToolOutcome(
            name=spec.name,
            status="succeeded",
            read_only=True,
            summary=summary,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _mq_summary(
        self, principal: Principal, name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        limit = self._settings.ai_copilot_tool_result_limit

        def _int_arg(key: str) -> int:
            try:
                return int(args.get(key))
            except (TypeError, ValueError) as exc:
                raise ValidationError(f"tool argument '{key}' is required") from exc

        if name == TOOL_MFG_PROCESS_LOOKUP:
            query = str(args.get("query") or "").strip() or None
            process_type = str(args.get("process_type") or "").strip() or None
            processes, total = await self._manufacturing.list_processes(
                principal,
                process_type=process_type,
                root_item_id=None,
                mbom_header_id=None,
                query=query,
                lifecycle_status=None,
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "total": total,
                "returned": min(len(processes), limit),
                "rows": [
                    {
                        "id": process["id"],
                        "process_key": process["process_key"],
                        "process_type": process.get("process_type"),
                        "name": process.get("name"),
                        "lifecycle_status": process.get("lifecycle_status"),
                    }
                    for process in processes[:limit]
                ],
            }
        if name == TOOL_MFG_WORK_CENTRE_LOOKUP:
            query = str(args.get("query") or "").strip() or None
            centres, total = await self._manufacturing.list_work_centres(
                principal,
                plant_id=None,
                line_id=None,
                query=query,
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "total": total,
                "returned": min(len(centres), limit),
                "rows": [
                    {
                        "id": centre["id"],
                        "work_centre_key": centre["work_centre_key"],
                        "name": centre.get("name"),
                        "plant_id": centre.get("plant_id"),
                    }
                    for centre in centres[:limit]
                ],
            }
        if name == TOOL_MFG_PROCESS_STRUCTURE:
            result = await self._manufacturing.structure(
                principal,
                _int_arg("process_id"),
                max_depth=min(int(args.get("max_depth") or 5), 20),
                limit=min(limit * 10, 5000),
            )
            return {
                "tool": name,
                "total": result["total"],
                "returned": min(len(result["operations"]), limit),
                "truncated": result["truncated"],
                "cycle_detected": result["cycle_detected"],
                "rows": [
                    {
                        "operation_id": row["operation_id"],
                        "operation_key": row["operation_key"],
                        "sequence": row["sequence"],
                        "work_centre_id": row.get("work_centre_id"),
                        "depth": row["depth"],
                        "has_instruction": row["has_instruction"],
                    }
                    for row in result["operations"][:limit]
                ],
            }
        if name == TOOL_MFG_PROCESS_VALIDATE:
            result = await self._manufacturing.validate(
                principal, _int_arg("process_id")
            )
            return {
                "tool": name,
                "status": result["status"],
                "score": result["score"],
                "summary": result["summary"],
                "returned": min(len(result["checks"]), limit),
                "rows": result["checks"][:limit],
            }
        if name == TOOL_QUALITY_ISSUE_LOOKUP:
            query = str(args.get("query") or "").strip() or None
            issues, total = await self._quality.list_issues(
                principal,
                status=None,
                severity=str(args.get("severity") or "").strip() or None,
                issue_type=None,
                component_item_id=None,
                product_item_id=None,
                supplier_ref=None,
                plant_id=None,
                operation_id=None,
                query=query,
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "total": total,
                "returned": min(len(issues), limit),
                "rows": [
                    {
                        "id": issue["id"],
                        "issue_key": issue["issue_key"],
                        "issue_type": issue.get("issue_type"),
                        "severity": issue.get("severity"),
                        "status": issue.get("status"),
                        "component_item_id": issue.get("component_item_id"),
                    }
                    for issue in issues[:limit]
                ],
            }
        if name == TOOL_QUALITY_TRACEABILITY:
            result = await self._quality.traceability(principal, _int_arg("issue_id"))
            return {
                "tool": name,
                "issue": result["issue"],
                "product": result.get("product"),
                "component": result.get("component"),
                "process": result.get("process"),
                "operation": result.get("operation"),
                "plant": result.get("plant"),
                "work_centre": result.get("work_centre"),
                "work_instructions": result.get("work_instructions", [])[:limit],
                "root_causes": result.get("root_causes", [])[:limit],
                "actions": result.get("actions", [])[:limit],
            }
        if name == TOOL_QUALITY_REPEAT:
            result = await self._quality.repeat_issues(
                principal, window_days=min(int(args.get("window_days") or 90), 3650)
            )
            return {
                "tool": name,
                "total": result["total"],
                "truncated": result["truncated"],
                "window_days": result["window_days"],
                "returned": min(len(result["groups"]), limit),
                "rows": result["groups"][:limit],
            }
        if name == TOOL_QUALITY_SUPPLIER:
            result = await self._quality.supplier_quality(principal)
            return {
                "tool": name,
                "total": result["total"],
                "truncated": result["truncated"],
                "returned": min(len(result["rows"]), limit),
                "rows": result["rows"][:limit],
            }
        if name == TOOL_QUALITY_IMPACT:
            result = await self._quality.impact(
                principal, _int_arg("entity_id"), max_depth=3
            )
            return {
                "tool": name,
                "inferred": result.get("inferred"),
                "truncated": result.get("truncated"),
                "returned": min(len(result["affected"]), limit),
                "rows": result["affected"][:limit],
            }
        raise ValidationError("unknown manufacturing/quality tool")

    async def _run_predictive(
        self, principal: Principal, spec: EnterpriseToolSpec, args: dict[str, Any]
    ) -> ToolOutcome:
        if self._predictive is None:
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="predictive_service_unavailable",
            )
        started = time.perf_counter()
        try:
            summary = await self._predictive_summary(principal, spec.name, args)
        except AuthorizationError:
            logger.info("copilot.predictive_tool.denied", tool=spec.name)
            return ToolOutcome(
                name=spec.name,
                status="denied",
                read_only=True,
                summary={},
                error_class="authorization_denied",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception as exc:  # noqa: BLE001 - never leak internals to model
            logger.warning(
                "copilot.predictive_tool.failed", tool=spec.name, error=str(exc)
            )
            return ToolOutcome(
                name=spec.name,
                status="failed",
                read_only=True,
                summary={},
                error_class="predictive_error",
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        observe_tool_call(
            tool=spec.name,
            outcome="success",
            duration_seconds=time.perf_counter() - started,
        )
        return ToolOutcome(
            name=spec.name,
            status="succeeded",
            read_only=True,
            summary=summary,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def _predictive_summary(
        self, principal: Principal, name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        limit = self._settings.ai_copilot_tool_result_limit

        def _int_arg(key: str) -> int:
            try:
                return int(args.get(key))
            except (TypeError, ValueError) as exc:
                raise ValidationError(f"tool argument '{key}' is required") from exc

        if name == TOOL_PRED_RISK_LOOKUP:
            rows, total = await self._predictive.list_predictions(
                principal,
                prediction_type=str(args.get("prediction_type") or "").strip() or None,
                subject_type=str(args.get("subject_type") or "").strip() or None,
                subject_id=None,
                risk_category=str(args.get("risk_category") or "").strip() or None,
                status="active",
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "disclaimer": (
                    "Predictions are indicators derived from rule-based or "
                    "statistical methods, not confirmed facts."
                ),
                "total": total,
                "returned": min(len(rows), limit),
                "rows": [
                    {
                        "id": row["id"],
                        "prediction_key": row["prediction_key"],
                        "prediction_type": row.get("prediction_type"),
                        "subject_type": row.get("subject_type"),
                        "subject_id": row.get("subject_id"),
                        "risk_category": row.get("risk_category"),
                        "score": row.get("score"),
                        "method": row.get("method"),
                        "model_version": row.get("model_version"),
                        "status": row.get("status"),
                        "stale": row.get("stale"),
                        "limitations": row.get("limitations", []),
                    }
                    for row in rows[:limit]
                ],
            }
        if name == TOOL_PRED_EXPLAIN:
            result = await self._predictive.explain_prediction(
                principal, _int_arg("prediction_id")
            )
            prediction = result["prediction"]
            return {
                "tool": name,
                "disclaimer": (
                    "Explanation describes method inputs and evidence; it does "
                    "not confirm the predicted outcome."
                ),
                "prediction_id": prediction["id"],
                "prediction_key": prediction["prediction_key"],
                "risk_category": prediction.get("risk_category"),
                "method": prediction.get("method"),
                "summary": result.get("summary"),
                "contributing_factors": result.get("contributing_factors", [])[:limit],
                "evidence": result.get("evidence", [])[:limit],
                "limitations": result.get("limitations", [])[:limit],
                "data_freshness": result.get("data_freshness", {}),
            }
        if name == TOOL_PRED_RECOMMENDATIONS:
            overdue_only = bool(args.get("overdue_only"))
            rows, total = await self._predictive.list_recommendations(
                principal,
                status=str(args.get("status") or "").strip() or None,
                severity=str(args.get("severity") or "").strip() or None,
                priority=None,
                prediction_id=None,
                owner_role=None,
                overdue_only=overdue_only,
                limit=limit,
                offset=0,
            )
            return {
                "tool": name,
                "disclaimer": (
                    "Recommendations are proposed actions; they never modify "
                    "authoritative enterprise records on their own."
                ),
                "total": total,
                "returned": min(len(rows), limit),
                "rows": [
                    {
                        "id": row["id"],
                        "recommendation_key": row["recommendation_key"],
                        "title": row.get("title"),
                        "severity": row.get("severity"),
                        "priority": row.get("priority"),
                        "status": row.get("status"),
                        "suggested_action": row.get("suggested_action"),
                        "owner_role": row.get("owner_role"),
                        "due_at": row.get("due_at"),
                        "overdue": row.get("overdue"),
                    }
                    for row in rows[:limit]
                ],
            }
        if name == TOOL_PRED_RECOMMENDATION_FEEDBACK:
            rows = await self._predictive.list_recommendation_feedback(
                principal, _int_arg("recommendation_id"), limit=limit
            )
            return {
                "tool": name,
                "recommendation_id": _int_arg("recommendation_id"),
                "returned": min(len(rows), limit),
                "rows": rows[:limit],
            }
        raise ValidationError("unknown predictive tool")

    async def _request(self, spec: EnterpriseToolSpec, args: dict[str, Any], token: str) -> Any:
        path, params, body = _prepare(spec, args)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        async with httpx.AsyncClient(
            base_url=self._settings.enterprise_api_base_url.rstrip("/"),
            timeout=self._settings.ai_copilot_tool_timeout_seconds,
            transport=self._transport,
        ) as client:
            response = await client.request(
                spec.method, path, params=params, json=body, headers=headers
            )
        if response.status_code in (401, 403):
            raise PermissionError("enterprise denied the tool call")
        if response.status_code >= 400:
            raise ValueError(f"enterprise tool returned {response.status_code}")
        return response.json()


def _require_text(args: dict[str, Any], name: str, *, required: bool) -> str:
    value = str(args.get(name) or "").strip()
    if required and not value:
        raise ValidationError(f"tool argument '{name}' is required")
    return value[:500]


def _prepare(
    spec: EnterpriseToolSpec, args: dict[str, Any]
) -> tuple[str, dict[str, Any], dict[str, Any] | None]:
    """Map bounded model-supplied arguments onto an allowlisted request."""

    if spec.name == TOOL_ENTERPRISE_SEARCH:
        text = _require_text(args, "query", required=True)
        body: dict[str, Any] = {"text": text, "page": 0, "pageSize": 10}
        object_types = args.get("object_types")
        if isinstance(object_types, list):
            allowed = [str(item)[:60] for item in object_types[:10] if isinstance(item, (str, int))]
            if allowed:
                body["objectTypes"] = allowed
        return spec.path, {}, body

    query = _require_text(args, "query", required=False)
    params: dict[str, Any] = {"page": 1, "pageSize": 10}
    if query:
        params["q"] = query
    item_type = str(args.get("item_type") or "").strip().upper()
    if spec.name == TOOL_PRODUCT_LOOKUP and item_type in ("PART", "PRODUCT"):
        params["itemType"] = item_type
    return spec.path, params, None


def _build_specs() -> list[EnterpriseToolSpec]:
    return [
        EnterpriseToolSpec(
            name=TOOL_ENTERPRISE_SEARCH,
            description=(
                "Search all authorized enterprise objects (documents, parts, "
                "BOMs, change objects) by free text."
            ),
            capability="iam.search.global:read",
            method="POST",
            path="/api/v1/search",
            intent_keywords=("search", "find", "look up", "lookup", "locate", "where is"),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "object_types": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["query"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRODUCT_LOOKUP,
            description="Look up authorized PDM parts or products by name or number.",
            capability="iam.pdm.items:read",
            method="GET",
            path="/api/v1/pdm/items",
            intent_keywords=("part", "product", "item", "component", "sku"),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "item_type": {"type": "string", "enum": ["PART", "PRODUCT"]},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_LOOKUP,
            description="Look up authorized BOM definitions by number or name.",
            capability="iam.bom.boms:read",
            method="GET",
            path="/api/v1/bom/boms",
            intent_keywords=("bom", "bill of materials", "structure", "where-used"),
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_LOOKUP,
            description=("Look up authorized manufacturing quality issues and non-conformances."),
            capability="iam.manufacturing-quality.issues:read",
            method="GET",
            path="/api/v1/manufacturing-quality/issues",
            intent_keywords=("quality", "defect", "non-conformance", "nonconformance", "issue"),
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_CHANGE_LOOKUP,
            description="Look up authorized engineering change requests (ECR).",
            capability="iam.change.requests:read",
            method="GET",
            path="/api/v1/change/requests",
            intent_keywords=("change request", "ecr", "engineering change", "change order"),
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PREDICTIVE_LOOKUP,
            description="Look up authorized predictive-intelligence predictions.",
            capability="iam.predictive-intelligence.predictions:read",
            method="GET",
            path="/api/v1/predictive-intelligence/predictions",
            intent_keywords=("prediction", "predict", "forecast", "risk score"),
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_GRAPH_SEARCH,
            description=(
                "Search the authorized knowledge graph for enterprise entities "
                "(products, parts, documents, BOMs, changes)."
            ),
            capability="iam.graph.entities:read",
            method="LOCAL",
            path=None,
            intent_keywords=("graph", "related to", "connected", "linked", "relationship"),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "minLength": 1},
                    "entity_types": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["query"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_GRAPH_NEIGHBORS,
            description="List the direct graph relationships of an entity.",
            capability="iam.graph.entities:read",
            method="LOCAL",
            path=None,
            intent_keywords=("neighbour", "neighbor", "adjacent", "directly related"),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_GRAPH_WHERE_USED,
            description="Find the parent products, assemblies and BOMs that use a part.",
            capability="iam.graph.entities:read",
            method="LOCAL",
            path=None,
            intent_keywords=("where used", "where-used", "which products use", "used by"),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_GRAPH_CHANGE_IMPACT,
            description="Identify products, parts, BOMs and documents affected by a change.",
            capability="iam.graph.entities:read",
            method="LOCAL",
            path=None,
            intent_keywords=("impact", "affected by", "what will break", "affected"),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_GRAPH_DIGITAL_THREAD,
            description=(
                "Navigate a product's digital thread: parts, CAD, BOMs, documents, "
                "changes, manufacturing and quality."
            ),
            capability="iam.graph.entities:read",
            method="LOCAL",
            path=None,
            intent_keywords=("digital thread", "product structure", "trace product"),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRODUCT_ITEM_LOOKUP,
            description=(
                "Look up authorized product/part items in the product intelligence "
                "catalog by key or name."
            ),
            capability="iam.pdm.items:read",
            method="LOCAL",
            path=None,
            intent_keywords=("product item", "part number", "catalog", "find part"),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "item_type": {"type": "string"},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_EXPAND,
            description="Expand an authorized BOM structure to a bounded depth.",
            capability="iam.bom.boms:read",
            method="LOCAL",
            path=None,
            intent_keywords=("expand bom", "bom structure", "bill of materials", "explode bom"),
            input_schema={
                "type": "object",
                "properties": {
                    "header_id": {"type": "integer"},
                    "max_depth": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["header_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_COMPARE,
            description="Compare two authorized BOMs and summarize added/removed/modified lines.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("compare bom", "bom diff", "difference between boms", "ebom vs mbom"),
            input_schema={
                "type": "object",
                "properties": {
                    "left_header_id": {"type": "integer"},
                    "right_header_id": {"type": "integer"},
                },
                "required": ["left_header_id", "right_header_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_RECONCILE,
            description="Reconcile an EBOM against an MBOM and summarize alignment exceptions.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("reconcile", "ebom mbom alignment", "bom exceptions"),
            input_schema={
                "type": "object",
                "properties": {
                    "source_header_id": {"type": "integer"},
                    "target_header_id": {"type": "integer"},
                },
                "required": ["source_header_id", "target_header_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_WHERE_USED,
            description="Find the parent BOMs and assemblies that use a product item.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("bom where used", "which bom uses", "used in bom", "parent assembly"),
            input_schema={
                "type": "object",
                "properties": {"item_id": {"type": "integer"}},
                "required": ["item_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_REUSE,
            description="Summarize the most reused parts across authorized BOMs.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("reuse", "reused parts", "common parts", "standardization"),
            input_schema={"type": "object", "properties": {}},
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_QUALITY,
            description="Run bounded BOM quality checks on an authorized BOM.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("bom quality", "bom check", "bom validation", "bom issues"),
            input_schema={
                "type": "object",
                "properties": {"header_id": {"type": "integer"}},
                "required": ["header_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_DUPLICATES,
            description="List exact and similar duplicate part candidates.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("duplicate parts", "duplicates", "similar parts", "redundant parts"),
            input_schema={"type": "object", "properties": {}},
        ),
        EnterpriseToolSpec(
            name=TOOL_BOM_CHANGE_IMPACT,
            description="Summarize the BOM/product impact of a change entity.",
            capability="iam.bom.compare:read",
            method="LOCAL",
            path=None,
            intent_keywords=("bom impact", "change impact on bom", "affected bom"),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_MFG_PROCESS_LOOKUP,
            description="Look up authorized manufacturing process plans by key or name.",
            capability="iam.manufacturing-quality.manufacturing:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "manufacturing process",
                "process plan",
                "routing",
                "production process",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "process_type": {"type": "string"},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_MFG_WORK_CENTRE_LOOKUP,
            description="Look up authorized manufacturing work centres.",
            capability="iam.manufacturing-quality.manufacturing:read",
            method="LOCAL",
            path=None,
            intent_keywords=("work centre", "work center", "production resource"),
            input_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_MFG_PROCESS_STRUCTURE,
            description="Expand a manufacturing process plan to a bounded depth.",
            capability="iam.manufacturing-quality.manufacturing:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "process structure",
                "operation sequence",
                "manufacturing steps",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "process_id": {"type": "integer"},
                    "max_depth": {"type": "integer", "minimum": 1, "maximum": 20},
                },
                "required": ["process_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_MFG_PROCESS_VALIDATE,
            description="Run bounded completeness validation on a manufacturing process.",
            capability="iam.manufacturing-quality.manufacturing:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "process completeness",
                "validate process",
                "missing work instruction",
                "manufacturing readiness",
            ),
            input_schema={
                "type": "object",
                "properties": {"process_id": {"type": "integer"}},
                "required": ["process_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_ISSUE_LOOKUP,
            description="Look up authorized quality issues and nonconformances.",
            capability="iam.manufacturing-quality.quality:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "quality issue",
                "nonconformance",
                "defect",
                "quality problem",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "severity": {"type": "string"},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_TRACEABILITY,
            description=(
                "Trace a quality issue to its product, part, process, operation, "
                "plant, work instructions, root causes and corrective actions."
            ),
            capability="iam.manufacturing-quality.quality:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "quality traceability",
                "trace quality issue",
                "corrective actions for quality",
                "quality issue affected",
            ),
            input_schema={
                "type": "object",
                "properties": {"issue_id": {"type": "integer"}},
                "required": ["issue_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_REPEAT,
            description="Detect repeated quality issues for the same part and failure code.",
            capability="iam.manufacturing-quality.quality:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "recurring quality",
                "repeat issue",
                "repeated defect",
                "recurring defect",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "window_days": {"type": "integer", "minimum": 1, "maximum": 3650}
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_SUPPLIER,
            description="Summarize supplier quality (issues and defects by supplier).",
            capability="iam.manufacturing-quality.quality:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "supplier quality",
                "defects by supplier",
                "supplier issues",
            ),
            input_schema={"type": "object", "properties": {}},
        ),
        EnterpriseToolSpec(
            name=TOOL_QUALITY_IMPACT,
            description="Summarize the impact of a graph entity across the digital thread.",
            capability="iam.manufacturing-quality.quality:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "quality impact",
                "which products use",
                "affected components",
                "affected suppliers",
            ),
            input_schema={
                "type": "object",
                "properties": {"entity_id": {"type": "integer"}},
                "required": ["entity_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRED_RISK_LOOKUP,
            description=(
                "Look up evidence-backed risk predictions for products, "
                "components, suppliers, operations or changes. Results are "
                "indicators, not confirmed facts."
            ),
            capability="iam.predictive-intelligence.predictions:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "risk", "predict", "forecast", "elevated risk", "at risk",
                "quality risk", "supplier risk",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "prediction_type": {"type": "string"},
                    "subject_type": {"type": "string"},
                    "risk_category": {"type": "string"},
                    "query": {"type": "string"},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRED_EXPLAIN,
            description=(
                "Explain a stored prediction: contributing factors, evidence, "
                "provenance, uncertainty and data freshness."
            ),
            capability="iam.predictive-intelligence.predictions:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "why", "explain prediction", "what evidence", "how was",
                "why classified",
            ),
            input_schema={
                "type": "object",
                "properties": {"prediction_id": {"type": "integer"}},
                "required": ["prediction_id"],
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRED_RECOMMENDATIONS,
            description=(
                "Look up recommended actions with severity, priority and "
                "lifecycle status. Recommendations never modify source records."
            ),
            capability="iam.predictive-intelligence.predictions:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "recommendation", "recommended action", "overdue",
                "what should we do", "next action",
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "status": {"type": "string"},
                    "severity": {"type": "string"},
                    "overdue_only": {"type": "boolean"},
                    "query": {"type": "string"},
                },
            },
        ),
        EnterpriseToolSpec(
            name=TOOL_PRED_RECOMMENDATION_FEEDBACK,
            description="Read reviewer feedback recorded for a recommendation.",
            capability="iam.predictive-intelligence.predictions:read",
            method="LOCAL",
            path=None,
            intent_keywords=(
                "recommendation feedback", "reviewer decision",
                "was recommendation accepted",
            ),
            input_schema={
                "type": "object",
                "properties": {"recommendation_id": {"type": "integer"}},
                "required": ["recommendation_id"],
            },
        ),
    ]


def build_enterprise_tool_client(
    settings: Settings,
    policy: Policy,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    graph: Any = None,
    products: Any = None,
    boms: Any = None,
    manufacturing: Any = None,
    quality: Any = None,
    predictive: Any = None,
) -> EnterpriseToolClient:
    return EnterpriseToolClient(
        settings,
        policy,
        transport=transport,
        graph=graph,
        products=products,
        boms=boms,
        manufacturing=manufacturing,
        quality=quality,
        predictive=predictive,
    )


def _tool_category(name: str) -> str:
    if name.startswith("graph."):
        return "graph"
    if name.startswith("bom.") or name.startswith("product."):
        return "product"
    if name.startswith("manufacturing."):
        return "manufacturing"
    if name.startswith("quality."):
        return "quality"
    if name.startswith("predictive."):
        return "predictive"
    return "enterprise"


def builtin_local_tool_seeds() -> list[dict[str, Any]]:
    """Seed definitions for the in-process tools shared with the Copilot.

    These mirror the authoritative ``_build_specs`` allowlist so the Agent
    Platform can reference the same graph, product/BOM, manufacturing, quality
    and predictive tools the Copilot uses. Keeping one source of truth prevents
    the tool registry from drifting away from the executable allowlist.
    """

    seeds: list[dict[str, Any]] = []
    for spec in _build_specs():
        if not (
            spec.name.startswith("graph.")
            or spec.name in _LOCAL_PRODUCT_TOOLS
            or spec.name in _LOCAL_MQ_TOOLS
            or spec.name in _LOCAL_PREDICTIVE_TOOLS
        ):
            continue
        seeds.append(
            {
                "code": spec.name,
                "name": spec.name.replace(".", " ").replace("_", " ").title(),
                "description": spec.description,
                "category": _tool_category(spec.name),
                "capability": spec.capability,
                "read_only": True,
                "risk_class": "read_only",
                "requires_approval": spec.requires_approval,
                "input_schema": spec.input_schema,
                "output_schema": {"type": "object"},
            }
        )
    return seeds
