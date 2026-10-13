"""Agent registry and execution (Phase 9).

Registers the built-in read-only **Enterprise Knowledge Assistant**, resolves its
active versioned definition, and executes it through the LangGraph runtime with
timeouts, bounded iteration, tool-level authorization, traces, audit and usage.
V1 ships read-only agents only: execution never mutates business objects.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from ai_api.application.agents.knowledge_assistant import (
    KNOWLEDGE_ASSISTANT_DEFINITION,
    KNOWLEDGE_ASSISTANT_KIND,
)
from ai_api.application.agents.runtime import AgentExecutionContext, AgentRuntime
from ai_api.application.agents.tools import ToolRegistry, build_default_tools
from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    DomainError,
    FeatureUnavailableError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationError,
)
from ai_api.infrastructure.providers.registry import default_chat_model
from ai_api.security.policies import PermissionMap, Policy, Principal
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("agent")


@dataclass(slots=True)
class AgentService:
    repository: AiRepository
    gateway: ModelGateway
    governance: GovernanceService
    audit: AuditService
    retrieval: RetrievalService
    settings: Settings
    policy: Policy
    permissions: PermissionMap
    runtime: AgentRuntime
    events: EventPublisher | None = None

    # --- Registry -------------------------------------------------------

    async def ensure_registry(self, tenant_id: int) -> dict[str, Any]:
        """Idempotently register the built-in agents for a tenant."""

        agent = await self.repository.create_agent_if_absent(
            tenant_id,
            {
                "code": self.settings.ai_agent_default_code,
                "name": "Enterprise Knowledge Assistant",
                "description": (
                    "Answers questions from the tenant's authorized knowledge "
                    "base, cites sources, and states when evidence is insufficient."
                ),
                "kind": KNOWLEDGE_ASSISTANT_KIND,
                "config": {"builtin": True},
            },
        )
        await self.repository.create_agent_version_if_absent(
            tenant_id,
            agent["id"],
            {
                "version": self.settings.ai_agent_default_version,
                "definition": KNOWLEDGE_ASSISTANT_DEFINITION,
                "status": "active",
            },
        )
        return agent

    async def list_agents(self, principal: Principal) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.ensure_registry(tenant_id)
        return await self.repository.list_agents(tenant_id)

    async def get_agent(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.ensure_registry(tenant_id)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        return agent

    async def list_versions(
        self, principal: Principal, agent_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self.get_agent(principal, agent_id)
        return await self.repository.list_agent_versions(tenant_id, agent_id)

    async def list_executions(
        self, principal: Principal, *, agent_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_executions(
            tenant_id, agent_id=agent_id, operation="agent", limit=limit, offset=offset
        )

    # --- Execution ------------------------------------------------------

    async def execute(self, principal: Principal, agent_id: int, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self.get_agent(principal, agent_id)
        if not agent.get("enabled", True):
            raise ValidationError("agent is disabled", details={"agent_id": agent_id})

        version = await self.repository.get_active_agent_version(tenant_id, agent_id)
        definition = dict((version or {}).get("definition") or {})
        kind = str(definition.get("kind") or agent.get("kind") or KNOWLEDGE_ASSISTANT_KIND)
        version_number = int((version or {}).get("version") or 0)
        if definition and definition.get("read_only") is not True:
            raise FeatureUnavailableError(
                "only read-only agents are supported in this release",
                details={"agent_id": agent_id},
            )

        query = payload.input
        model = payload.model or default_chat_model(self.settings)
        policy = await self.governance.enforce(
            principal,
            operation="agent",
            model=model,
            prompt_text=query,
            feature="agents_execute",
        )
        guard = PromptGuard(block=policy.block_prompt_injection)
        scan = guard.scan(query)
        if guard.block and scan.suspicious:
            await self._audit(
                principal,
                agent_id,
                "denied",
                {"reason": "prompt_injection", "findings": len(scan.findings)},
            )
            raise AuthorizationError(
                "request rejected by content security policy",
                details={"findings": len(scan.findings)},
            )

        tools = ToolRegistry(
            tools=build_default_tools(self.retrieval, self.settings),
            policy=self.policy,
            permissions=self.permissions,
            require_approval=self.settings.ai_agent_require_approval,
        )
        context = AgentExecutionContext(
            principal=principal,
            tenant_id=tenant_id,
            model=model,
            tools=tools,
            retrieval=self.retrieval,
            gateway=self.gateway,
            settings=self.settings,
            approvals=frozenset(payload.approvals or ()),
            max_tool_calls=self.settings.ai_agent_max_tool_calls,
        )

        logger.info("agent.execute.start", agent_id=agent_id, kind=kind)
        started = time.perf_counter()
        try:
            result = await self.runtime.run(
                context, kind=kind, query=query, limit=payload.limit
            )
        except TimeoutError as exc:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await self._persist(
                principal, agent_id, "cancelled", query=None, latency_ms=latency_ms,
                token_usage={}, error={"code": "timeout"},
            )
            await self._audit(principal, agent_id, "failure", {"reason": "timeout"})
            raise ServiceUnavailableError(
                "agent execution timed out",
                details={"timeout_seconds": self.settings.ai_agent_timeout_seconds},
            ) from exc
        except asyncio.CancelledError:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await self._persist(
                principal, agent_id, "cancelled", query=None, latency_ms=latency_ms,
                token_usage={}, error={"code": "cancelled"},
            )
            await self._audit(principal, agent_id, "failure", {"reason": "cancelled"})
            raise
        except DomainError as exc:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await self._persist(
                principal, agent_id, "failed", query=None, latency_ms=latency_ms,
                token_usage={}, error={"code": exc.code, "message": exc.message},
            )
            outcome = "denied" if isinstance(exc, AuthorizationError) else "failure"
            await self._audit(principal, agent_id, outcome, {"reason": exc.code})
            raise
        except Exception as exc:  # noqa: BLE001 - normalize unexpected failures
            latency_ms = int((time.perf_counter() - started) * 1000)
            logger.warning("agent.execute.error", error=str(exc))
            await self._persist(
                principal, agent_id, "failed", query=None, latency_ms=latency_ms,
                token_usage={}, error={"code": "internal_error"},
            )
            await self._audit(principal, agent_id, "failure", {"reason": "internal_error"})
            raise ServiceUnavailableError(
                "agent execution failed", details={"reason": type(exc).__name__}
            ) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)
        output = {
            "answer": result.answer,
            "citations": result.citations,
            "insufficient_evidence": result.insufficient_evidence,
            "confidence": result.confidence,
            "trace": result.trace,
        }
        execution = await self._persist(
            principal,
            agent_id,
            "succeeded",
            query=query,
            latency_ms=latency_ms,
            token_usage=result.usage,
            output=output,
            model=model,
            kind=kind,
            version=version_number,
        )
        await self._record_usage(principal, execution, model, result.usage)
        await self._emit_completed(principal, model, latency_ms, result)
        await self._audit(
            principal,
            agent_id,
            "success",
            {
                "insufficient_evidence": result.insufficient_evidence,
                "citations": len(result.citations),
                "confidence": result.confidence,
            },
        )
        return {
            "agent_id": agent_id,
            "code": agent.get("code"),
            "version": version_number,
            "status": result.status,
            "answer": result.answer,
            "citations": result.citations,
            "insufficient_evidence": result.insufficient_evidence,
            "confidence": result.confidence,
            "is_mock": result.is_mock,
            "provider": result.provider,
            "usage": result.usage,
            "trace": result.trace,
            "execution_id": execution.get("id") if execution else None,
            "request_id": request_id_var.get(),
        }

    # --- Persistence helpers -------------------------------------------

    async def _persist(
        self,
        principal: Principal,
        agent_id: int,
        status: str,
        *,
        query: str | None,
        latency_ms: int,
        token_usage: dict[str, Any],
        output: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        model: str | None = None,
        kind: str | None = None,
        version: int | None = None,
    ) -> dict[str, Any] | None:
        if principal.tenant_id is None:
            return None
        try:
            return await self.repository.record_execution(
                principal.tenant_id,
                {
                    "actor_id": principal.actor_id,
                    "agent_id": agent_id,
                    "operation": "agent",
                    "status": status,
                    "input": {
                        "query_length": len(query or ""),
                        "kind": kind,
                        "agent_version": version,
                        "model": model,
                    },
                    "output": output,
                    "error": error,
                    "token_usage": token_usage,
                    "latency_ms": latency_ms,
                    "request_id": request_id_var.get(),
                },
            )
        except Exception as exc:  # noqa: BLE001 - persistence must not fail the request
            logger.warning("agent.persist_failed", error=str(exc))
            return None

    async def _record_usage(
        self,
        principal: Principal,
        execution: dict[str, Any] | None,
        model: str,
        usage: dict[str, Any],
    ) -> None:
        if principal.tenant_id is None or execution is None:
            return
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        if not input_tokens and not output_tokens:
            return
        try:
            await self.repository.record_usage(
                principal.tenant_id,
                {
                    "execution_id": execution["id"],
                    "provider_code": self.settings.llm_provider,
                    "model_code": model,
                    "kind": "input",
                    "quantity": input_tokens,
                    "unit": "tokens",
                },
            )
            await self.repository.record_usage(
                principal.tenant_id,
                {
                    "execution_id": execution["id"],
                    "provider_code": self.settings.llm_provider,
                    "model_code": model,
                    "kind": "output",
                    "quantity": output_tokens,
                    "unit": "tokens",
                },
            )
        except Exception as exc:  # noqa: BLE001 - usage persistence is best-effort
            logger.warning("agent.usage_persist_failed", error=str(exc))

    async def _emit_completed(
        self, principal: Principal, model: str, latency_ms: int, result: Any
    ) -> None:
        if self.events is None or principal.tenant_id is None:
            return
        usage = result.usage or {}
        try:
            await self.events.ai_request_completed(
                tenant_id=principal.tenant_id,
                actor_id=principal.actor_id,
                operation="agent",
                model=model,
                provider=result.provider,
                status="succeeded",
                is_mock=result.is_mock,
                latency_ms=latency_ms,
                input_tokens=int(usage.get("input_tokens", 0) or 0),
                output_tokens=int(usage.get("output_tokens", 0) or 0),
                total_tokens=int(usage.get("total_tokens", 0) or 0),
            )
        except Exception as exc:  # noqa: BLE001 - event emission must not fail the request
            logger.warning("agent.event_failed", error=str(exc))

    async def _audit(
        self,
        principal: Principal,
        agent_id: int,
        outcome: str,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action="ai.agent.execute",
            resource_type="agent",
            resource_id=str(agent_id),
            outcome=outcome,
            request_id=request_id_var.get(),
            detail=detail,
        )
