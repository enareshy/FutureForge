"""Durable agent execution engine (Stage 6).

The engine runs validated, deterministic workflow steps against pinned tool
versions. It owns no second execution ledger: it writes to ``ai.executions`` and
the Stage 6 step/invocation/checkpoint tables. Tool effects are limited to
read-only retrieval and the platform-owned draft artifact, so no enterprise
business record can be mutated.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jsonschema

from ai_api.application.ports import AiRepository
from ai_api.application.services.agent_tool_service import AgentToolService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    ConflictError,
    FeatureUnavailableError,
    NotFoundError,
    ValidationError,
)
from ai_api.security.policies import PermissionMap, Policy, Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("agent.execution")

_EXECUTION_TERMINAL = {"completed", "succeeded", "failed", "cancelled", "timed_out"}
_MUTATING_RISK = {"controlled_mutation", "consequential"}
_READ_ONLY_RISK = {"read_only", "low_risk_preparation"}
_BUDGET_CEILINGS = {
    "max_steps": 25,
    "max_tool_calls": 30,
    "max_elapsed_seconds": 600,
}
_NON_RETRYABLE_ERRORS = {
    "denied",
    "approval_rejected",
    "approval_invalid",
    "approval_consumed",
    "invalid_input",
    "invalid_output",
    "reconciliation_required",
}
_CAPABILITY_RISK = {
    "knowledge.read": "read_only",
    "platform.draft": "controlled_mutation",
    "iam.search.global:read": "read_only",
    "iam.pdm.items:read": "read_only",
    "iam.bom.boms:read": "read_only",
    "iam.bom.compare:read": "read_only",
    "iam.graph.entities:read": "read_only",
    "iam.manufacturing-quality.issues:read": "read_only",
    "iam.manufacturing-quality.manufacturing:read": "read_only",
    "iam.manufacturing-quality.quality:read": "read_only",
    "iam.change.requests:read": "read_only",
    "iam.predictive-intelligence.predictions:read": "read_only",
}

_ENTERPRISE_TOOL_NAMES = frozenset(
    {
        "enterprise.search",
        "product.lookup",
        "bom.lookup",
        "quality.lookup",
        "change.lookup",
        "predictive.lookup",
    }
)
_DELEGATION_TOOL = "agent.delegate"
_MAX_DELEGATION_DEPTH = 3
_MAX_STORED_RESULT_BYTES = 100_000


class _LeaseLost(Exception):
    """The worker no longer owns the execution lease."""


class _Denied(Exception):
    def __init__(self, error_class: str, message: str) -> None:
        super().__init__(message)
        self.error_class = error_class
        self.message = message


def _text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def operation_hash(
    agent_version_id: int,
    step_key: str,
    tool_version_id: int | None,
    target: str,
    arguments: dict[str, Any],
) -> str:
    payload = {
        "agent_version_id": agent_version_id,
        "step_key": step_key,
        "tool_version_id": tool_version_id,
        "target": target,
        "arguments": arguments,
    }
    return hashlib.sha256(_text(payload).encode("utf-8")).hexdigest()


def _summary(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "<truncated>"
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            lowered = str(key).lower()
            if any(token in lowered for token in ("password", "secret", "token", "key")):
                out[key] = "<redacted>"
            else:
                out[key] = _summary(child, depth=depth + 1)
        return out
    if isinstance(value, list):
        return [_summary(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, str):
        return value[:500]
    return value


def _visited_agents(definition: dict[str, Any]) -> set[int]:
    chain = definition.get("delegation_chain") or []
    return {int(item) for item in chain if isinstance(item, int)}


def _resolve_args(template: Any, inputs: dict[str, Any]) -> Any:
    if isinstance(template, dict):
        return {key: _resolve_args(value, inputs) for key, value in template.items()}
    if isinstance(template, list):
        return [_resolve_args(value, inputs) for value in template]
    if isinstance(template, str) and template.startswith("{{") and template.endswith("}}"):
        path = template[2:-2].strip().split(".")
        current: Any = inputs
        for part in path:
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        return current
    return template


@dataclass(slots=True)
class AgentExecutionService:
    repository: AiRepository
    retrieval: RetrievalService
    audit: AuditService
    policy: Policy
    settings: Settings
    tools: AgentToolService
    permissions: PermissionMap
    enterprise_tools: Any = None
    memory: Any = None

    # --- API operations -------------------------------------------------

    async def create(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self.repository.get_agent(tenant_id, payload.agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": payload.agent_id})
        if not agent.get("enabled", True):
            raise ValidationError("agent is disabled")
        if agent.get("lifecycle_status") not in (None, "published", "draft"):
            raise ValidationError(
                "agent lifecycle does not allow new executions",
                details={"lifecycle_status": agent.get("lifecycle_status")},
            )
        version = None
        if agent.get("current_version_id"):
            version = await self.repository.get_agent_version(
                tenant_id, payload.agent_id, int(agent["current_version_id"])
            )
        if version is None:
            version = await self.repository.get_active_agent_version(
                tenant_id, payload.agent_id
            )
        if version is None:
            raise ValidationError("agent has no published version")
        definition = dict(version.get("definition") or {})
        warnings: list[str] = []
        if not definition:
            raise ValidationError("agent definition is empty")

        inputs = dict(payload.input or {})
        if payload.input_text:
            inputs.setdefault("text", payload.input_text)
            inputs.setdefault("query", payload.input_text)
        if len(json.dumps(inputs, default=str)) > 200_000:
            raise ValidationError("execution input is too large")

        steps = self._plan_steps(definition)
        await self._preflight_tools(tenant_id, int(version["id"]), steps, principal)
        budgets = self._clamp_budgets(definition, payload.budgets or {})
        plan = {
            "mode": "workflow",
            "steps": steps,
            "warnings": warnings,
            "approval_policy": dict(definition.get("approval_policy") or {}),
            "output_schema": definition.get("output_schema"),
            "caller": {
                "user_id": principal.user_id,
                "username": principal.username,
                "actor_id": principal.actor_id,
                "tenant_id": principal.tenant_id,
                "permissions": sorted(principal.permissions),
            },
        }
        input_hash = hashlib.sha256(
            json.dumps(inputs, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        execution = await self.repository.create_agent_execution(
            tenant_id,
            {
                "actor_id": principal.actor_id,
                "agent_id": payload.agent_id,
                "agent_version_id": version["id"],
                "idempotency_key": payload.idempotency_key,
                "status": "queued",
                "plan": plan,
                "budgets": budgets,
                "input": inputs,
                "input_snapshot": _summary(inputs),
                "input_hash": input_hash,
            },
        )
        if (
            int(execution.get("agent_id") or 0) != int(payload.agent_id)
            or int(execution.get("agent_version_id") or 0) != int(version["id"])
            or execution.get("input_hash") != input_hash
        ):
            raise ConflictError(
                "idempotency key was already used with a different request",
                details={"idempotency_key": payload.idempotency_key},
            )
        await self._audit(principal, "ai.agent.execution.create", execution["id"], {
            "agent_id": payload.agent_id,
            "agent_version_id": version["id"],
        })
        return await self._detail(tenant_id, execution)

    async def list(
        self,
        principal: Principal,
        *,
        state: str | None,
        agent_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        items, total = await self.repository.list_agent_executions(
            tenant_id, state=state, agent_id=agent_id, limit=limit, offset=offset
        )
        return [self._public(item) for item in items], total

    async def get(self, principal: Principal, execution_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        execution = await self._execution(tenant_id, execution_id)
        return await self._detail(tenant_id, execution)

    async def trace(self, principal: Principal, execution_id: int) -> dict[str, Any]:
        detail = await self.get(principal, execution_id)
        return {
            "execution_id": execution_id,
            "status": detail["status"],
            "steps": detail["steps"],
            "invocations": detail["invocations"],
            "checkpoints": detail.get("checkpoints", []),
        }

    async def result(self, principal: Principal, execution_id: int) -> dict[str, Any]:
        detail = await self.get(principal, execution_id)
        if detail["status"] not in ("completed", "succeeded"):
            raise ConflictError(
                "execution has not completed", details={"status": detail["status"]}
            )
        return {
            "execution_id": execution_id,
            "output": detail.get("output"),
            "artifacts": detail.get("artifacts", []),
        }

    async def cancel(
        self, principal: Principal, execution_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        execution = await self._execution(tenant_id, execution_id)
        if execution["status"] in _EXECUTION_TERMINAL:
            raise ConflictError("execution already finished")
        updated = await self.repository.update_agent_execution(
            tenant_id,
            execution_id,
            expected_state=None,
            fields={
                "cancel_requested_at": datetime.now(UTC),
                "status": "cancelled"
                if execution["status"] in ("queued", "waiting_approval")
                else "cancel_requested",
                "completed_at": datetime.now(UTC),
            },
        )
        assert updated is not None
        await self._audit(principal, "ai.agent.execution.cancel", execution_id, {})
        return await self._detail(tenant_id, updated)

    async def retry(self, principal: Principal, execution_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        execution = await self._execution(tenant_id, execution_id)
        if execution["status"] != "failed":
            raise ConflictError("only failed executions can be retried")
        error_class = str((execution.get("error") or {}).get("class") or "")
        if error_class in _NON_RETRYABLE_ERRORS:
            raise ConflictError(
                "this failure is not retryable",
                details={"error_class": error_class},
            )
        invocations = await self.repository.list_tool_invocations(
            tenant_id, execution_id
        )
        if any(
            invocation.get("status") == "running"
            or invocation.get("outcome_certainty") == "unknown"
            for invocation in invocations
        ):
            raise ConflictError(
                "an uncertain tool outcome requires reconciliation before retry"
            )
        step_count = int(execution.get("step_count") or 0)
        if step_count >= int((execution.get("budgets") or {}).get("max_steps", 25)):
            raise ConflictError("execution step budget is exhausted")
        updated = await self.repository.update_agent_execution(
            tenant_id,
            execution_id,
            expected_state="failed",
            fields={
                "status": "queued",
                "error": None,
                "completed_at": None,
                "lease_owner": None,
                "lease_expires_at": None,
            },
        )
        if updated is None:
            raise ConflictError("execution state changed")
        await self._audit(principal, "ai.agent.execution.retry", execution_id, {})
        return await self._detail(tenant_id, updated)

    # --- Worker ---------------------------------------------------------

    async def run_claimed(self, execution: dict[str, Any]) -> None:
        tenant_id = int(execution["tenant_id"])
        execution_id = int(execution["id"])
        worker_id = str(execution.get("lease_owner") or "")
        lease_generation = int(execution.get("lease_generation") or 0)
        if not worker_id:
            raise ValidationError("execution was not claimed by a worker")
        lease_seconds = int(self.settings.ai_agent_execution_lease_seconds)
        heartbeat = asyncio.create_task(
            self._heartbeat(
                tenant_id,
                execution_id,
                worker_id,
                lease_generation,
                lease_seconds,
            )
        )
        try:
            await self._run_claimed(
                execution, worker_id, lease_generation, lease_seconds
            )
        except _LeaseLost:
            logger.warning(
                "agent.execution.lease_lost",
                tenant_id=tenant_id,
                execution_id=execution_id,
                worker_id=worker_id,
                lease_generation=lease_generation,
            )
            await self._audit_worker(
                tenant_id,
                execution_id,
                execution.get("actor_id"),
                "ai.agent.execution.lease_lost",
                "failure",
                {"worker_id": worker_id, "lease_generation": lease_generation},
            )
        except AuthorizationError as exc:
            await self._deny_and_fail(
                execution,
                worker_id,
                lease_generation,
                "denied",
                str(exc),
            )
        except _Denied as exc:
            await self._deny_and_fail(
                execution,
                worker_id,
                lease_generation,
                exc.error_class,
                exc.message,
            )
        except Exception as exc:  # noqa: BLE001 - worker must persist failures
            with contextlib.suppress(_LeaseLost):
                await self._fail(
                    tenant_id,
                    execution_id,
                    "engine_error",
                    str(exc),
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat

    async def _run_claimed(
        self,
        execution: dict[str, Any],
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> None:
        tenant_id = int(execution["tenant_id"])
        execution_id = int(execution["id"])
        current = await self._renew(
            tenant_id, execution_id, worker_id, lease_generation, lease_seconds
        )
        checkpoint = await self.repository.latest_execution_checkpoint(
            tenant_id, execution_id
        )
        state = dict((checkpoint or {}).get("state") or {})
        completed: list[str] = list(state.get("completed") or [])
        results: dict[str, Any] = dict(state.get("results") or {})
        approvals: dict[str, int] = dict(state.get("approvals") or {})
        plan = dict(current.get("plan") or execution.get("plan") or {})
        caller = dict(plan.get("caller") or {})
        principal = self._caller_principal(tenant_id, caller)
        inputs = dict(current.get("input") or execution.get("input") or {})
        budgets = dict(current.get("budgets") or execution.get("budgets") or {})
        started_at = current.get("started_at") or datetime.now(UTC)
        deadline = started_at + timedelta(
            seconds=int(budgets.get("max_elapsed_seconds", 600))
        )
        version_id = int(current.get("agent_version_id") or 0)
        tools = await self._load_tools(tenant_id, version_id)
        agent_definition = await self._version_definition(tenant_id, current)
        chain = plan.get("delegation_chain")
        if isinstance(chain, list) and chain:
            agent_definition = {**agent_definition, "delegation_chain": chain}
        delegation = dict(agent_definition.get("delegation") or {})
        max_depth = int(delegation.get("max_depth") or 1)
        depth = int(current.get("delegation_depth") or 0)

        for step in plan.get("steps") or []:
            key = str(step.get("key"))
            if key in completed:
                continue
            current = await self._renew(
                tenant_id, execution_id, worker_id, lease_generation, lease_seconds
            )
            if current.get("cancel_requested_at"):
                await self._cancel_execution(
                    tenant_id,
                    execution_id,
                    worker_id,
                    lease_generation,
                    error_class=None,
                    message="execution was cancelled",
                )
                return
            if datetime.now(UTC) > deadline:
                await self._fail(
                    tenant_id,
                    execution_id,
                    "timed_out",
                    "elapsed budget exceeded",
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                return
            if len(completed) >= int(budgets.get("max_steps", 25)):
                await self._fail(
                    tenant_id,
                    execution_id,
                    "budget",
                    "step budget exceeded",
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                return
            if step.get("delegate_to") is not None:
                key = str(step.get("key"))
                result = await self._run_delegation_step(
                    tenant_id=tenant_id,
                    execution_id=execution_id,
                    parent_agent_id=int(current.get("agent_id") or 0),
                    principal=principal,
                    step=step,
                    agent_definition=agent_definition,
                    delegation=delegation,
                    depth=depth,
                    max_depth=max_depth,
                    inputs=inputs,
                    worker_id=worker_id,
                    lease_generation=lease_generation,
                    lease_seconds=lease_seconds,
                    completed=completed,
                )
                await self._complete_step(
                    tenant_id,
                    execution_id,
                    key,
                    step,
                    result,
                    completed,
                    results,
                    approvals,
                    worker_id,
                    lease_generation,
                )
                continue

            tool_code = str(step.get("tool") or "")
            tool, link, tool_version, definition, risk, target = await self._runtime_tool(
                tenant_id, step, tools, principal
            )
            tool_version_id = int(tool_version["id"])
            arguments = self._step_arguments(step, inputs)
            arguments_hash = hashlib.sha256(
                _text(arguments).encode("utf-8")
            ).hexdigest()
            self._validate_payload(
                definition.get("input_schema"), arguments, "tool input"
            )

            step_record = await self.repository.upsert_execution_step(
                tenant_id,
                execution_id,
                {
                    "step_key": key,
                    "sequence": int(step.get("sequence") or len(completed) + 1),
                    "tool_code": tool_code,
                    "tool_version_id": tool_version_id,
                    "status": "running",
                    "attempts": 1,
                    "input_summary": _summary(arguments),
                    "started_at": datetime.now(UTC),
                },
                lease_owner=worker_id,
                lease_generation=lease_generation,
            )
            if step_record is None:
                raise _LeaseLost
            await self._update_execution(
                tenant_id,
                execution_id,
                {"current_step": key, "step_count": len(completed) + 1},
                worker_id,
                lease_generation,
            )

            requires_approval = self._requires_approval(risk, definition, plan)
            op_hash = operation_hash(
                version_id, key, tool_version_id, target, arguments
            )
            if requires_approval:
                approval = None
                approval_id = approvals.get(key)
                if approval_id:
                    approval = await self.repository.get_agent_approval(
                        tenant_id, approval_id
                    )
                if approval is not None and self._approval_expired(approval):
                    approval = None
                if approval is None:
                    approval = await self.repository.find_pending_approval(
                        tenant_id, execution_id, op_hash
                    )
                if approval is None:
                    approval = await self.repository.create_agent_approval(
                        tenant_id,
                        {
                            "execution_id": execution_id,
                            "step_id": step_record["id"],
                            "step_key": key,
                            "tool_code": tool_code,
                            "tool_version_id": tool_version_id,
                            "operation_hash": op_hash,
                            "target": target,
                            "input_summary": _summary(arguments),
                            "expected_effect": step.get("expected_effect"),
                            "evidence": state.get("evidence", []),
                            "risk_class": risk,
                            "requested_by": principal.actor_id,
                            "requested_by_name": principal.username,
                            "expires_at": datetime.now(UTC) + timedelta(hours=24),
                        },
                    )
                approvals[key] = int(approval["id"])
                if approval["status"] == "pending":
                    await self.repository.upsert_execution_step(
                        tenant_id,
                        execution_id,
                        {
                            "step_key": key,
                            "sequence": int(step.get("sequence") or len(completed) + 1),
                            "status": "waiting_approval",
                        },
                        lease_owner=worker_id,
                        lease_generation=lease_generation,
                    )
                    await self.repository.record_tool_invocation(
                        tenant_id,
                        execution_id,
                        {
                            "step_id": step_record["id"],
                            "tool_code": tool_code,
                            "tool_version_id": tool_version_id,
                            "status": "approval_required",
                            "arguments_hash": arguments_hash,
                            "arguments_summary": _summary(arguments),
                        },
                        lease_owner=worker_id,
                        lease_generation=lease_generation,
                    )
                    await self._checkpoint(
                        tenant_id,
                        execution_id,
                        {
                            "completed": completed,
                            "results": results,
                            "approvals": approvals,
                        },
                        lease_owner=worker_id,
                        lease_generation=lease_generation,
                    )
                    await self._update_execution(
                        tenant_id,
                        execution_id,
                        {
                            "status": "waiting_approval",
                            "current_step": key,
                            "lease_owner": None,
                            "lease_expires_at": None,
                        },
                        worker_id,
                        lease_generation,
                    )
                    return
                if approval["status"] != "approved" or not self._approval_matches(
                    approval,
                    execution_id=execution_id,
                    key=key,
                    tool_version_id=tool_version_id,
                    op_hash=op_hash,
                    target=target,
                ):
                    await self._cancel_execution(
                        tenant_id,
                        execution_id,
                        worker_id,
                        lease_generation,
                        error_class="approval_invalid",
                        message="approval does not match the planned operation",
                    )
                    return
                consumed = await self.repository.consume_agent_approval(
                    tenant_id,
                    int(approval["id"]),
                    execution_id=execution_id,
                    operation_hash=op_hash,
                    consumed_by=worker_id,
                )
                if consumed is None:
                    raise _Denied(
                        "approval_consumed",
                        "approval was already consumed or is no longer valid",
                    )
                await self._audit_worker(
                    tenant_id,
                    execution_id,
                    principal.actor_id,
                    "ai.agent.approval.consumed",
                    "success",
                    {
                        "approval_id": approval["id"],
                        "operation_hash": op_hash,
                        "worker_id": worker_id,
                    },
                )

            previous = await self.repository.latest_tool_invocation(
                tenant_id, execution_id, int(step_record["id"])
            )
            if previous and previous.get("arguments_hash") == arguments_hash:
                if previous.get("status") == "succeeded" and previous.get("result") is not None:
                    result = previous["result"]
                    await self._complete_step(
                        tenant_id,
                        execution_id,
                        key,
                        step,
                        result,
                        completed,
                        results,
                        approvals,
                        worker_id,
                        lease_generation,
                    )
                    continue
                if (
                    previous.get("status") == "running"
                    or previous.get("outcome_certainty") == "unknown"
                    or previous.get("status") == "succeeded"
                ):
                    if risk in _READ_ONLY_RISK:
                        logger.info(
                            "agent.execution.read_only_replay",
                            execution_id=execution_id,
                            step_key=key,
                        )
                    else:
                        raise _Denied(
                            "reconciliation_required",
                            "a previous tool attempt has an uncertain outcome; "
                            "reconcile before retrying",
                        )

            if int(current.get("tool_call_count") or 0) + len(completed) >= int(
                budgets.get("max_tool_calls", 30)
            ):
                await self._fail(
                    tenant_id,
                    execution_id,
                    "budget",
                    "tool budget exceeded",
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                return
            invocation = await self.repository.record_tool_invocation(
                tenant_id,
                execution_id,
                {
                    "step_id": step_record["id"],
                    "tool_code": tool_code,
                    "tool_version_id": tool_version_id,
                    "status": "running",
                    "idempotency_key": f"{execution_id}:{key}:{arguments_hash}",
                    "outcome_certainty": (
                        "unknown" if risk in _MUTATING_RISK else "certain"
                    ),
                    "arguments_hash": arguments_hash,
                    "arguments_summary": _summary(arguments),
                },
                lease_owner=worker_id,
                lease_generation=lease_generation,
            )
            if invocation is None:
                raise _LeaseLost
            await self._renew(
                tenant_id,
                execution_id,
                worker_id,
                lease_generation,
                max(
                    lease_seconds,
                    int(definition.get("timeout_seconds") or 30) + 15,
                ),
            )
            try:
                result = await asyncio.wait_for(
                    self._execute_tool(
                        principal, execution_id, tool_code, definition, arguments
                    ),
                    timeout=float(definition.get("timeout_seconds") or 30),
                )
            except TimeoutError:
                await self.repository.update_tool_invocation(
                    tenant_id,
                    int(invocation["id"]),
                    {
                        "status": "failed",
                        "error_class": "timeout",
                        "error_message": "tool timed out",
                        "outcome_certainty": (
                            "unknown" if risk in _MUTATING_RISK else "certain"
                        ),
                        "finished_at": datetime.now(UTC),
                    },
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                raise _Denied("timeout", f"{tool_code} timed out") from None
            except Exception as exc:  # noqa: BLE001 - tool errors are data
                await self.repository.update_tool_invocation(
                    tenant_id,
                    int(invocation["id"]),
                    {
                        "status": "failed",
                        "error_class": type(exc).__name__,
                        "error_message": str(exc)[:500],
                        "outcome_certainty": (
                            "unknown" if risk in _MUTATING_RISK else "certain"
                        ),
                        "finished_at": datetime.now(UTC),
                    },
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                raise _Denied("tool_error", str(exc)) from exc
            try:
                self._validate_payload(
                    definition.get("output_schema"), result, "tool output"
                )
            except _Denied as exc:
                await self.repository.update_tool_invocation(
                    tenant_id,
                    int(invocation["id"]),
                    {
                        "status": "failed",
                        "error_class": exc.error_class,
                        "error_message": exc.message[:500],
                        "outcome_certainty": (
                            "unknown" if risk in _MUTATING_RISK else "certain"
                        ),
                        "finished_at": datetime.now(UTC),
                    },
                    lease_owner=worker_id,
                    lease_generation=lease_generation,
                )
                raise
            stored = self._stored_result(result)
            updated = await self.repository.update_tool_invocation(
                tenant_id,
                int(invocation["id"]),
                {
                    "status": "succeeded",
                    "result": stored,
                    "result_summary": _summary(result),
                    "outcome_certainty": "certain",
                    "finished_at": datetime.now(UTC),
                },
                lease_owner=worker_id,
                lease_generation=lease_generation,
            )
            if updated is None:
                raise _LeaseLost
            await self._complete_step(
                tenant_id,
                execution_id,
                key,
                step,
                result,
                completed,
                results,
                approvals,
                worker_id,
                lease_generation,
            )

        output = {
            "results": results,
            "last": results.get(completed[-1]) if completed else None,
        }
        self._validate_payload(plan.get("output_schema"), output, "agent output")
        updated = await self._update_execution(
            tenant_id,
            execution_id,
            {
                "status": "completed",
                "output": output,
                "output_snapshot": _summary(output),
                "current_step": None,
                "step_count": len(completed),
                "tool_call_count": len(completed),
                "completed_at": datetime.now(UTC),
                "lease_owner": None,
                "lease_expires_at": None,
            },
            worker_id,
            lease_generation,
        )
        if updated is None:
            raise _LeaseLost
        await self._audit_worker(
            tenant_id,
            execution_id,
            principal.actor_id,
            "ai.agent.execution.completed",
            "success",
            {"steps": len(completed), "worker_id": worker_id},
        )

    async def _version_definition(
        self, tenant_id: int, execution: dict[str, Any]
    ) -> dict[str, Any]:
        version_id = int(execution.get("agent_version_id") or 0)
        agent_id = int(execution.get("agent_id") or 0)
        if not version_id:
            return {}
        version = await self.repository.get_agent_version(
            tenant_id, agent_id, version_id
        )
        return dict((version or {}).get("definition") or {})

    async def _run_delegation_step(
        self,
        *,
        tenant_id: int,
        execution_id: int,
        parent_agent_id: int,
        principal: Principal,
        step: dict[str, Any],
        agent_definition: dict[str, Any],
        delegation: dict[str, Any],
        depth: int,
        max_depth: int,
        inputs: dict[str, Any],
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
        completed: list[str],
    ) -> dict[str, Any]:
        """Delegate a step to a child agent, then run it inline.

        Loop prevention: the configured ``max_depth`` caps the chain, a child may
        not be the parent agent, the child must be in the parent's declared
        ``delegation.agents`` allowlist, and delegation records are unique per
        (parent execution, step) so a retry cannot spawn a second child.
        """

        key = str(step.get("key"))
        child_agent_id = int(step.get("delegate_to") or 0)
        if not delegation.get("enabled"):
            raise _Denied("delegation_disabled", "delegation is not enabled for this agent")
        allowed_children = {int(c) for c in delegation.get("agents") or []}
        if child_agent_id not in allowed_children:
            raise _Denied(
                "delegation_not_allowed",
                f"agent {child_agent_id} is not in the delegation allowlist",
            )
        if child_agent_id == parent_agent_id:
            raise _Denied("delegation_loop", "an agent cannot delegate to itself")
        if depth + 1 > min(max_depth, _MAX_DELEGATION_DEPTH):
            raise _Denied("delegation_depth", "maximum delegation depth exceeded")
        if child_agent_id in _visited_agents(agent_definition):
            raise _Denied("delegation_loop", "delegation chain revisited an agent")

        child_agent = await self.repository.get_agent(tenant_id, child_agent_id)
        if child_agent is None or child_agent.get("deleted_at") is not None:
            raise _Denied("delegation_target_missing", "child agent not found")
        if not child_agent.get("enabled", False):
            raise _Denied(
                "delegation_target_inactive",
                "child agent is not active",
            )
        child_version_id = child_agent.get("current_version_id")
        if child_version_id is None:
            raise _Denied(
                "delegation_target_unpublished", "child agent has no active version"
            )

        child_inputs = dict(inputs)
        overrides = step.get("input")
        if isinstance(overrides, dict):
            child_inputs.update(_resolve_args(overrides, inputs) or {})
        child_inputs.setdefault("query", inputs.get("query") or inputs.get("text") or "")

        mode = "parallel" if step.get("mode") == "parallel" else "sequential"
        delegation_record = await self.repository.create_agent_delegation(
            tenant_id,
            {
                "parent_execution_id": execution_id,
                "parent_agent_id": parent_agent_id,
                "child_agent_id": child_agent_id,
                "step_key": key,
                "mode": mode,
                "status": "running",
                "depth": depth + 1,
                "input_summary": _summary(child_inputs),
            },
        )
        if delegation_record.get("child_execution_id"):
            existing = await self.repository.get_agent_execution(
                tenant_id, int(delegation_record["child_execution_id"])
            )
            if existing and existing.get("status") in ("completed", "succeeded"):
                return dict(existing.get("output") or {})

        child_plan = {
            "mode": "workflow",
            "steps": [],
            "warnings": [],
            "approval_policy": {},
            "output_schema": None,
        }
        child_version = await self.repository.get_agent_version(
            tenant_id, child_agent_id, int(child_version_id)
        )
        child_definition = dict((child_version or {}).get("definition") or {})
        child_steps = self._plan_steps(child_definition)
        child_plan["steps"] = child_steps
        child_warnings: list[str] = []
        child_plan["warnings"] = child_warnings
        child_budgets = self._clamp_budgets(child_definition, {})
        execution = await self.repository.create_agent_execution(
            tenant_id,
            {
                "actor_id": principal.actor_id,
                "agent_id": child_agent_id,
                "agent_version_id": int(child_version_id),
                "idempotency_key": f"delegate:{execution_id}:{key}",
                "status": "queued",
                "plan": {
                    **child_plan,
                    "delegation_chain": [
                        *[int(item) for item in agent_definition.get("delegation_chain") or []
                          if isinstance(item, int)],
                        parent_agent_id,
                    ],
                    "caller": {
                        "user_id": principal.user_id,
                        "username": principal.username,
                        "actor_id": principal.actor_id,
                        "tenant_id": principal.tenant_id,
                        "permissions": sorted(principal.permissions),
                    },
                },
                "budgets": child_budgets,
                "input": child_inputs,
                "input_snapshot": _summary(child_inputs),
                "parent_execution_id": execution_id,
                "delegation_depth": depth + 1,
                "delegated_by_agent_id": parent_agent_id,
            },
        )
        await self.repository.update_agent_delegation(
            tenant_id,
            delegation_record["id"],
            {"child_execution_id": execution["id"]},
        )
        await self._audit_worker(
            tenant_id,
            execution_id,
            principal.actor_id,
            "ai.agent.delegation.created",
            "success",
            {
                "child_execution_id": execution["id"],
                "child_agent_id": child_agent_id,
                "depth": depth + 1,
            },
        )
        started = await self.repository.start_agent_execution(
            tenant_id,
            int(execution["id"]),
            worker_id=f"{worker_id}:delegate",
            lease_seconds=lease_seconds,
        )
        if started is None:
            await self.repository.update_agent_delegation(
                tenant_id,
                delegation_record["id"],
                {"status": "failed", "error_class": "child_not_claimable"},
            )
            raise _Denied("delegation_failed", "child execution could not start")
        await self.run_claimed(started)
        finished = await self.repository.get_agent_execution(
            tenant_id, int(execution["id"])
        )
        status = (finished or {}).get("status")
        if status not in ("completed", "succeeded"):
            error_class = str(((finished or {}).get("error") or {}).get("class") or "child_failed")
            await self.repository.update_agent_delegation(
                tenant_id,
                delegation_record["id"],
                {"status": "failed", "error_class": error_class},
            )
            raise _Denied(
                "delegation_failed",
                f"child agent execution ended with status {status}",
            )
        output = dict((finished or {}).get("output") or {})
        await self.repository.update_agent_delegation(
            tenant_id,
            delegation_record["id"],
            {
                "status": "completed",
                "result_summary": _summary(output),
            },
        )
        return output

    async def _heartbeat(
        self,
        tenant_id: int,
        execution_id: int,
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> None:
        interval = max(1.0, float(lease_seconds) / 3.0)
        while True:
            await asyncio.sleep(interval)
            renewed = await self.repository.renew_agent_execution_lease(
                tenant_id,
                execution_id,
                worker_id=worker_id,
                lease_generation=lease_generation,
                lease_seconds=lease_seconds,
            )
            if renewed is None:
                logger.warning(
                    "agent.execution.heartbeat_lost",
                    tenant_id=tenant_id,
                    execution_id=execution_id,
                    worker_id=worker_id,
                    lease_generation=lease_generation,
                )
                return

    async def _renew(
        self,
        tenant_id: int,
        execution_id: int,
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> dict[str, Any]:
        renewed = await self.repository.renew_agent_execution_lease(
            tenant_id,
            execution_id,
            worker_id=worker_id,
            lease_generation=lease_generation,
            lease_seconds=lease_seconds,
        )
        if renewed is None:
            raise _LeaseLost
        return renewed

    async def _update_execution(
        self,
        tenant_id: int,
        execution_id: int,
        fields: dict[str, Any],
        worker_id: str,
        lease_generation: int,
    ) -> dict[str, Any] | None:
        updated = await self.repository.update_agent_execution(
            tenant_id,
            execution_id,
            expected_state=None,
            fields=fields,
            lease_owner=worker_id,
            lease_generation=lease_generation,
        )
        if updated is None:
            raise _LeaseLost
        return updated

    async def _complete_step(
        self,
        tenant_id: int,
        execution_id: int,
        key: str,
        step: dict[str, Any],
        result: dict[str, Any],
        completed: list[str],
        results: dict[str, Any],
        approvals: dict[str, int],
        worker_id: str,
        lease_generation: int,
    ) -> None:
        step_done = await self.repository.upsert_execution_step(
            tenant_id,
            execution_id,
            {
                "step_key": key,
                "sequence": int(step.get("sequence") or len(completed) + 1),
                "status": "completed",
                "output_summary": _summary(result),
                "finished_at": datetime.now(UTC),
            },
            lease_owner=worker_id,
            lease_generation=lease_generation,
        )
        if step_done is None:
            raise _LeaseLost
        completed.append(key)
        results[key] = result
        await self._checkpoint(
            tenant_id,
            execution_id,
            {"completed": completed, "results": results, "approvals": approvals},
            lease_owner=worker_id,
            lease_generation=lease_generation,
        )

    async def _cancel_execution(
        self,
        tenant_id: int,
        execution_id: int,
        worker_id: str,
        lease_generation: int,
        *,
        error_class: str | None,
        message: str,
    ) -> None:
        fields: dict[str, Any] = {
            "status": "cancelled",
            "current_step": None,
            "completed_at": datetime.now(UTC),
            "lease_owner": None,
            "lease_expires_at": None,
        }
        if error_class:
            fields["error"] = {"class": error_class, "message": message[:1000]}
        await self._update_execution(
            tenant_id, execution_id, fields, worker_id, lease_generation
        )

    async def _deny_and_fail(
        self,
        execution: dict[str, Any],
        worker_id: str,
        lease_generation: int,
        error_class: str,
        message: str,
    ) -> None:
        tenant_id = int(execution["tenant_id"])
        execution_id = int(execution["id"])
        await self._audit_worker(
            tenant_id,
            execution_id,
            execution.get("actor_id"),
            "ai.agent.execution.denied",
            "denied",
            {"error_class": error_class, "message": message[:500]},
        )
        with contextlib.suppress(_LeaseLost):
            await self._fail(
                tenant_id,
                execution_id,
                error_class,
                message,
                lease_owner=worker_id,
                lease_generation=lease_generation,
            )

    async def _load_tools(
        self, tenant_id: int, version_id: int
    ) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
        links = await self.repository.list_agent_version_tools(tenant_id, version_id)
        tools: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        for link in links:
            tool = await self.repository.get_agent_tool(tenant_id, int(link["tool_id"]))
            if tool:
                tools[str(tool["code"])] = (tool, link)
        return tools

    async def _preflight_tools(
        self,
        tenant_id: int,
        version_id: int,
        steps: list[dict[str, Any]],
        principal: Principal,
    ) -> None:
        tools = await self._load_tools(tenant_id, version_id)
        for step in steps:
            if step.get("delegate_to") is not None:
                continue
            try:
                await self._runtime_tool(tenant_id, step, tools, principal)
            except _Denied as exc:
                raise ValidationError(
                    exc.message,
                    details={"tool": str(step.get("tool") or "")},
                ) from exc

    async def _runtime_tool(
        self,
        tenant_id: int,
        step: dict[str, Any],
        tools: dict[str, tuple[dict[str, Any], dict[str, Any]]],
        principal: Principal,
    ) -> tuple[
        dict[str, Any],
        dict[str, Any],
        dict[str, Any],
        dict[str, Any],
        str,
        str,
    ]:
        code = str(step.get("tool") or "")
        entry = tools.get(code)
        if entry is None:
            raise _Denied("denied", f"tool is not in the published allowlist: {code}")
        tool, link = entry
        if not tool.get("enabled", False):
            raise _Denied("denied", f"tool is disabled: {code}")
        if tool.get("lifecycle_status") not in ("published",):
            raise _Denied("denied", f"tool is not published: {code}")
        tool_version = await self.repository.get_agent_tool_version(
            tenant_id, int(tool["id"]), int(link["tool_version_id"])
        )
        if tool_version is None or tool_version.get("status") != "published":
            raise _Denied("denied", f"tool version is not published: {code}")
        definition = dict(tool_version.get("definition") or {})
        capability = str(definition.get("capability") or "")
        if not capability:
            raise _Denied("denied", f"tool has no capability: {code}")
        risk = str(definition.get("risk_class") or "read_only")
        expected_risk = _CAPABILITY_RISK.get(capability)
        if expected_risk is not None and expected_risk != risk:
            raise _Denied(
                "denied",
                f"tool risk class does not match capability: {code}",
            )
        if risk in ("prohibited", "consequential"):
            raise _Denied("denied", f"tool risk class is not executable: {code}")
        self.policy.require(
            principal,
            self.permissions.permission_for(capability),
            message=f"not authorized to use tool capability: {capability}",
        )
        target = f"{code}:{capability}"
        return tool, link, tool_version, definition, risk, target

    @staticmethod
    def _approval_expired(approval: dict[str, Any]) -> bool:
        expires_at = approval.get("expires_at")
        return (
            approval.get("consumed_at") is None
            and approval.get("status") in ("pending", "approved")
            and (expires_at is None or expires_at <= datetime.now(UTC))
        )

    def _approval_matches(
        self,
        approval: dict[str, Any],
        *,
        execution_id: int,
        key: str,
        tool_version_id: int,
        op_hash: str,
        target: str,
    ) -> bool:
        expires_at = approval.get("expires_at")
        return (
            int(approval.get("execution_id") or 0) == execution_id
            and approval.get("step_key") == key
            and int(approval.get("tool_version_id") or 0) == tool_version_id
            and approval.get("operation_hash") == op_hash
            and approval.get("target") == target
            and approval.get("status") == "approved"
            and approval.get("consumed_at") is None
            and (expires_at is None or expires_at > datetime.now(UTC))
        )

    def _validate_payload(self, schema: Any, value: Any, label: str) -> None:
        if not schema:
            return
        try:
            jsonschema.validate(instance=value, schema=schema)
        except jsonschema.ValidationError as exc:
            error_class = (
                "invalid_output" if "output" in label else "invalid_input"
            )
            raise _Denied(error_class, f"{label} does not satisfy schema: {exc.message}") from exc

    @staticmethod
    def _stored_result(result: Any) -> Any:
        try:
            encoded = _text(result)
        except (TypeError, ValueError):
            return None
        if len(encoded.encode("utf-8")) > _MAX_STORED_RESULT_BYTES:
            return None
        try:
            return json.loads(encoded)
        except ValueError:
            return None

    def _clamp_budgets(
        self, definition: dict[str, Any], payload_budgets: dict[str, Any]
    ) -> dict[str, int]:
        limits = definition.get("limits") or {}
        if not isinstance(limits, dict) or not isinstance(payload_budgets, dict):
            raise ValidationError("budgets must be an object")
        budgets: dict[str, int] = {}
        for key, ceiling in _BUDGET_CEILINGS.items():
            candidates = [ceiling]
            for source in (limits, payload_budgets):
                if key not in source:
                    continue
                value = source[key]
                if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                    raise ValidationError(
                        f"budget {key} must be a positive integer",
                        details={"budget": key},
                    )
                candidates.append(value)
            budgets[key] = min(candidates)
        return budgets

    # --- Internal -------------------------------------------------------

    def _plan_steps(self, definition: dict[str, Any]) -> list[dict[str, Any]]:
        steps = definition.get("steps") or []
        if isinstance(steps, list) and steps:
            return sorted(
                [dict(step) for step in steps if isinstance(step, dict)],
                key=lambda step: int(step.get("sequence") or 0),
            )
        tools = definition.get("tools") or []
        planned = []
        for index, raw in enumerate(tools):
            code = raw if isinstance(raw, str) else str((raw or {}).get("code") or "")
            if code:
                planned.append(
                    {
                        "key": f"step_{index + 1}",
                        "sequence": index + 1,
                        "tool": code,
                        "depends_on": [],
                    }
                )
        return planned

    def _step_arguments(
        self, step: dict[str, Any], inputs: dict[str, Any]
    ) -> dict[str, Any]:
        raw = step.get("args")
        if isinstance(raw, dict):
            resolved = _resolve_args(raw, inputs)
            if isinstance(resolved, dict) and resolved:
                return resolved
        return dict(inputs)

    def _requires_approval(
        self,
        risk: str,
        definition: dict[str, Any],
        plan: dict[str, Any],
    ) -> bool:
        if risk in _MUTATING_RISK:
            return True
        if definition.get("requires_approval"):
            return True
        approval_policy = plan.get("approval_policy") or {}
        require_for = set(approval_policy.get("require_for_risk") or [])
        return risk in require_for

    async def _execute_tool(
        self,
        principal: Principal,
        execution_id: int,
        code: str,
        definition: dict[str, Any],
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        implementation = str(definition.get("implementation") or "")
        capability = str(definition.get("capability") or "")
        if code == "knowledge.search" or capability == "knowledge.read":
            query = str(
                arguments.get("query")
                or arguments.get("text")
                or ""
            ).strip()
            if not query:
                raise ValidationError("knowledge.search requires a query")
            limit = min(int(arguments.get("limit") or 5), 20)
            ranked, mode, fallback = await self.retrieval.ranked_documents(
                principal,
                query=query,
                mode="hybrid",
                filters=[],
                sort="relevance",
                limit=limit,
            )
            return {
                "documents": [
                    {
                        "source_code": doc.get("source_code"),
                        "title": doc.get("title"),
                        "text": doc.get("text") or doc.get("content"),
                        "score": doc.get("score"),
                    }
                    for doc in ranked[:limit]
                ],
                "count": len(ranked),
                "mode": mode,
                "fallback": fallback,
            }
        if code == "platform.draft.create" or capability == "platform.draft":
            title = str(arguments.get("title") or "Draft artifact")[:200]
            content = str(arguments.get("content") or "")
            artifact = await self.repository.create_agent_artifact(
                principal.tenant_id,
                {
                    "execution_id": execution_id,
                    "artifact_type": "draft",
                    "title": title,
                    "content": content,
                    "created_by": principal.actor_id,
                },
            )
            return {
                "artifact_id": artifact["id"],
                "title": title,
                "note": "platform-owned draft; no enterprise record was changed",
            }
        if implementation in ("retrieval.search", "knowledge.search"):
            return await self._execute_tool(
                principal,
                execution_id,
                "knowledge.search",
                {**definition, "capability": "knowledge.read"},
                arguments,
            )
        if self.enterprise_tools is not None and (
            self._is_enterprise_tool(code) or self._is_enterprise_tool(implementation)
        ):
            tool_name = code if self._is_enterprise_tool(code) else implementation
            outcome = await self.enterprise_tools.run(principal, tool_name, arguments)
            if outcome.status != "succeeded":
                raise _Denied(
                    outcome.error_class or "tool_error",
                    f"{tool_name} failed: {outcome.status}",
                )
            return dict(outcome.summary or {})
        if code in _ENTERPRISE_TOOL_NAMES or implementation in _ENTERPRISE_TOOL_NAMES:
            raise FeatureUnavailableError(
                "enterprise tools are not enabled in this release",
                details={"tool": code},
            )
        raise FeatureUnavailableError(
            "tool implementation is not enabled in this release",
            details={"tool": code},
        )

    def _is_enterprise_tool(self, name: str) -> bool:
        if not name:
            return False
        if name in _ENTERPRISE_TOOL_NAMES:
            return True
        names = getattr(self.enterprise_tools, "names", None)
        if callable(names):
            try:
                return name in names()
            except Exception:  # noqa: BLE001 - never fail dispatch on introspection
                return False
        return False

    async def _checkpoint(
        self,
        tenant_id: int,
        execution_id: int,
        state: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> None:
        checkpoint = await self.repository.add_execution_checkpoint(
            tenant_id,
            execution_id,
            {"state": state},
            lease_owner=lease_owner,
            lease_generation=lease_generation,
        )
        if (
            checkpoint is None
            and lease_owner is not None
            and lease_generation is not None
        ):
            raise _LeaseLost

    async def _fail(
        self,
        tenant_id: int,
        execution_id: int,
        error_class: str,
        message: str,
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> None:
        updated = await self.repository.update_agent_execution(
            tenant_id,
            execution_id,
            expected_state=None,
            fields={
                "status": "failed",
                "error": {"class": error_class, "message": message[:1000]},
                "completed_at": datetime.now(UTC),
                "lease_owner": None,
                "lease_expires_at": None,
            },
            lease_owner=lease_owner,
            lease_generation=lease_generation,
        )
        if (
            updated is None
            and lease_owner is not None
            and lease_generation is not None
        ):
            raise _LeaseLost
        logger.warning(
            "agent.execution.failed",
            tenant_id=tenant_id,
            execution_id=execution_id,
            error_class=error_class,
        )

    async def _execution(self, tenant_id: int, execution_id: int) -> dict[str, Any]:
        execution = await self.repository.get_agent_execution(tenant_id, execution_id)
        if execution is None:
            raise NotFoundError(
                "execution not found", details={"execution_id": execution_id}
            )
        return execution

    async def _detail(
        self, tenant_id: int, execution: dict[str, Any]
    ) -> dict[str, Any]:
        execution_id = int(execution["id"])
        steps = await self.repository.list_execution_steps(tenant_id, execution_id)
        artifacts, _ = await self.repository.list_agent_artifacts(
            tenant_id, execution_id=execution_id, limit=100, offset=0
        )
        invocations = await self._invocations(tenant_id, execution_id)
        checkpoint = await self.repository.latest_execution_checkpoint(
            tenant_id, execution_id
        )
        return {
            **self._public(execution),
            "steps": steps,
            "invocations": invocations,
            "artifacts": artifacts,
            "checkpoints": [checkpoint] if checkpoint else [],
        }

    async def _invocations(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]:
        return await self.repository.list_tool_invocations(tenant_id, execution_id)

    @staticmethod
    def _public(execution: dict[str, Any]) -> dict[str, Any]:
        return {
            key: execution.get(key)
            for key in (
                "id",
                "agent_id",
                "agent_version_id",
                "status",
                "current_step",
                "step_count",
                "tool_call_count",
                "model_call_count",
                "plan",
                "budgets",
                "input",
                "output",
                "error",
                "cancel_requested_at",
                "lease_expires_at",
                "started_at",
                "completed_at",
                "created_at",
            )
        }

    @staticmethod
    def _caller_principal(tenant_id: int, caller: dict[str, Any]) -> Principal:
        return Principal(
            user_id=str(caller.get("user_id") or "system"),
            username=str(caller.get("username") or "system"),
            tenant_id=tenant_id,
            permissions=frozenset(caller.get("permissions") or ()),
            actor_id=caller.get("actor_id"),
            roles=frozenset(),
        )

    async def _audit_worker(
        self,
        tenant_id: int,
        execution_id: int,
        actor_id: int | None,
        action: str,
        outcome: str,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=actor_id,
            action=action,
            resource_type="agent_execution",
            resource_id=str(execution_id),
            outcome=outcome,
            detail=detail,
        )

    async def _audit(
        self, principal: Principal, action: str, execution_id: int, detail: dict[str, Any]
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="agent_execution",
            resource_id=str(execution_id),
            outcome="success",
            detail=detail,
        )
