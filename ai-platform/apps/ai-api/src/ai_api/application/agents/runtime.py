"""Agent runtime: execution context, timeouts, iteration bounds, tracing.

The runtime is the single place that runs an agent graph. It enforces the
wall-clock timeout, bounds graph recursion (iteration), centralizes tool-call
accounting/tracing, and normalizes the result. Cancellation of the calling task
propagates through `asyncio` and is surfaced as a cancelled execution.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ai_api.application.agents.knowledge_assistant import (
    KNOWLEDGE_ASSISTANT_KIND,
    build_knowledge_assistant_graph,
)
from ai_api.application.agents.tools import ToolCallContext, ToolRegistry
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import Settings
from ai_api.domain.errors import FeatureUnavailableError, ValidationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("agent.runtime")


@dataclass(slots=True)
class AgentExecutionContext:
    """Everything an agent graph needs, plus its tool-call/trace bookkeeping."""

    principal: Principal
    tenant_id: int
    model: str
    tools: ToolRegistry
    retrieval: RetrievalService
    gateway: ModelGateway
    settings: Settings
    approvals: frozenset[str] = frozenset()
    max_tool_calls: int = 6
    trace: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: int = 0

    def record(self, step: str, **detail: Any) -> None:
        if len(self.trace) >= self.settings.ai_agent_trace_max_events:
            return
        self.trace.append({"seq": len(self.trace) + 1, "step": step, "detail": detail})

    def tool_context(self) -> ToolCallContext:
        return ToolCallContext(
            principal=self.principal,
            tenant_id=self.tenant_id,
            approvals=self.approvals,
        )

    async def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if self.tool_calls >= self.max_tool_calls:
            raise ValidationError(
                "agent exceeded its tool-call budget",
                details={"max_tool_calls": self.max_tool_calls},
            )
        self.tool_calls += 1
        self.record("tool_call", tool=name)
        return await self.tools.run(name, self.tool_context(), args)


@dataclass(slots=True)
class AgentRunResult:
    status: str
    answer: str
    citations: list[dict[str, Any]]
    insufficient_evidence: bool
    confidence: float
    is_mock: bool
    provider: str | None
    usage: dict[str, Any]
    trace: list[dict[str, Any]]


@dataclass(slots=True)
class AgentRuntime:
    settings: Settings
    builders: dict[str, Callable[[AgentExecutionContext], Any]] = field(
        default_factory=lambda: {
            KNOWLEDGE_ASSISTANT_KIND: build_knowledge_assistant_graph,
        }
    )

    def supports(self, kind: str) -> bool:
        return kind in self.builders

    async def run(
        self,
        context: AgentExecutionContext,
        *,
        kind: str,
        query: str,
        limit: int | None = None,
    ) -> AgentRunResult:
        builder = self.builders.get(kind)
        if builder is None:
            raise FeatureUnavailableError(
                "this agent kind is not executable in this release",
                details={"kind": kind, "supported": sorted(self.builders)},
            )

        graph = builder(context)
        state: dict[str, Any] = {"query": query, "model": context.model}
        if limit is not None:
            state["limit"] = limit

        timeout = self.settings.ai_agent_timeout_seconds
        logger.info("agent.run.start", kind=kind, timeout_seconds=timeout)
        try:
            final: dict[str, Any] = await asyncio.wait_for(
                graph.ainvoke(
                    state, {"recursion_limit": self.settings.ai_agent_max_iterations}
                ),
                timeout=timeout,
            )
        except TimeoutError:
            logger.warning("agent.run.timeout", kind=kind, timeout_seconds=timeout)
            raise
        context.record("finalize", insufficient=bool(final.get("insufficient_evidence")))
        return AgentRunResult(
            status="succeeded",
            answer=str(final.get("answer") or ""),
            citations=list(final.get("citations") or []),
            insufficient_evidence=bool(final.get("insufficient_evidence")),
            confidence=float(final.get("confidence") or 0.0),
            is_mock=bool(final.get("is_mock", True)),
            provider=final.get("provider"),
            usage=dict(final.get("usage") or {}),
            trace=list(context.trace),
        )
