"""Enterprise AI Copilot orchestration (Stage 5).

Design rules enforced here:

* One retrieval path (`RetrievalService`) — no second index or ranking stack.
* Identity, tenant, authorization and classification are resolved server-side.
* Client context references are pointers only; an adapter re-reads the source.
* Conversation history is bounded and summarized; full history is never sent.
* Citations are validated against the evidence set the model was given.
* Tasks are read-only: no enterprise record is ever modified.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services import copilot_prompts as prompts
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.citation_validation import (
    ANSWER_STATUS_CANCELLED,
    ANSWER_STATUS_ERROR,
    ANSWER_STATUS_INSUFFICIENT,
    validate_extraction_citations,
    validate_inline_citations,
)
from ai_api.application.services.context import require_actor_id, require_tenant
from ai_api.application.services.copilot_actions import CopilotActionService
from ai_api.application.services.copilot_context import (
    ContextService,
    estimate_tokens,
)
from ai_api.application.services.enterprise_tools import (
    EnterpriseToolClient,
    ToolOutcome,
)
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.prompt_security import (
    blocking_enabled,
    filter_evidence,
    screen_input,
)
from ai_api.application.services.retrieval_service import (
    INSUFFICIENT_EVIDENCE_TEXT,
    RetrievalService,
)
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    FeatureUnavailableError,
    NotFoundError,
    ValidationError,
)
from ai_api.domain.models.provider import ChatRequest, Message, Role
from ai_api.infrastructure.providers.registry import default_chat_model
from ai_api.security.policies import Policy, Principal
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.logging import get_logger, request_id_var
from ai_api.telemetry.metrics import record_citation_validation

logger = get_logger("copilot")

_CONTEXT_TYPES = ("ask", "summarize", "explain", "compare", "extract")
_RETRIEVAL_TASKS = ("ask", "explain")
_CONTEXT_REQUIRED = ("summarize", "compare", "extract")
_FEATURE_BY_TASK = {
    "ask": "rag_query",
    "summarize": "summarize",
    "explain": "copilot",
    "compare": "copilot",
    "extract": "copilot",
}
_DEFAULT_EXTRACTION_FIELDS: tuple[dict[str, str], ...] = (
    {"name": "summary", "type": "string"},
    {"name": "key_points", "type": "list"},
    {"name": "dates", "type": "list"},
    {"name": "owners", "type": "list"},
    {"name": "decisions", "type": "list"},
    {"name": "risks", "type": "list"},
)


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@dataclass(slots=True)
class GenerationPlan:
    task: str
    conversation: dict[str, Any] | None
    instruction: str
    evidence: list[dict[str, Any]]
    citations: list[dict[str, Any]]
    context_refs: list[dict[str, Any]]
    history_summary: str | None
    history_messages: list[dict[str, Any]]
    request: ChatRequest | None
    message: dict[str, Any] | None
    warnings: list[str] = field(default_factory=list)
    prompt_version: str = prompts.PROMPT_VERSION
    insufficient: bool = False
    is_mock: bool = False
    output_format: str = "markdown"
    fields: list[dict[str, Any]] = field(default_factory=list)
    answer_status: str | None = None
    citations_required: bool = False
    citation_status: str | None = None
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    proposed_action: dict[str, Any] | None = None
    started: float = field(default_factory=time.perf_counter)


@dataclass(slots=True)
class CopilotService:
    repository: AiRepository
    retrieval: RetrievalService
    gateway: ModelGateway
    governance: GovernanceService
    audit: AuditService
    context: ContextService
    settings: Settings
    agents: AgentExecutionService | None = None
    policy: Policy = field(default_factory=Policy)
    tools: EnterpriseToolClient | None = None
    actions: CopilotActionService | None = None

    async def run_agent(self, principal: Principal, payload: Any) -> dict[str, Any]:
        """Copilot-initiated agent run through the shared execution engine.

        This is a thin, documented interface: authorization, publication,
        tool allowlists, budgets, idempotency, approvals and audit all remain in
        the registry/execution services. Copilot never bypasses them.
        """

        if self.agents is None:
            raise FeatureUnavailableError("agent execution is not configured")
        execution = await self.agents.create(principal, payload)
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.agent_run",
            resource_type="agent_execution",
            resource_id=str(execution["id"]),
            outcome="success",
            detail={
                "agent_id": payload.agent_id,
                "source": "copilot",
            },
        )
        return execution

    # --- Controlled actions --------------------------------------------
    async def propose_action(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        """Record an inert enterprise-action proposal raised from a message.

        The Copilot only proposes. Nothing is executed here: an authorized
        reviewer must approve it separately, and execution re-checks the
        caller's permissions against the enterprise service.
        """

        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        conversation_id = getattr(payload, "conversation_id", None)
        if conversation_id is not None:
            conversation = await self._owned_conversation(principal, conversation_id)
            conversation_id = conversation["id"]
        message_id = getattr(payload, "message_id", None)
        evidence: list[dict[str, Any]] = []
        if message_id is not None:
            tenant_id = require_tenant(principal)
            message = await self.repository.get_message(tenant_id, message_id)
            if message is None or (
                conversation_id is not None
                and message.get("conversation_id") != conversation_id
            ):
                raise NotFoundError(
                    "message not found", details={"message_id": message_id}
                )
            evidence = await self.repository.get_message_sources(
                tenant_id, message_id
            )
        return await self.actions.propose(
            principal,
            action_type=payload.action_type,
            target=payload.target,
            summary=payload.summary,
            arguments=payload.arguments,
            expected_effect=payload.expected_effect,
            evidence=evidence,
            conversation_id=conversation_id,
            message_id=message_id,
        )

    async def list_actions(
        self,
        principal: Principal,
        *,
        status: str | None,
        conversation_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        if conversation_id is not None:
            await self._owned_conversation(principal, conversation_id)
        return await self.actions.list(
            principal,
            status=status,
            conversation_id=conversation_id,
            limit=limit,
            offset=offset,
        )

    async def get_action(self, principal: Principal, action_id: int) -> dict[str, Any]:
        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        return await self.actions.get(principal, action_id)

    async def approve_action(
        self, principal: Principal, action_id: int, reason: str | None
    ) -> dict[str, Any]:
        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        return await self.actions.approve(principal, action_id, reason)

    async def reject_action(
        self, principal: Principal, action_id: int, reason: str | None
    ) -> dict[str, Any]:
        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        return await self.actions.reject(principal, action_id, reason)

    async def execute_action(
        self, principal: Principal, action_id: int
    ) -> dict[str, Any]:
        if self.actions is None:
            raise FeatureUnavailableError("controlled actions are not configured")
        return await self.actions.execute(principal, action_id)

    # --- Conversation management ---------------------------------------
    async def create_conversation(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        actor_id = require_actor_id(principal)
        conversation = await self.repository.create_conversation(
            tenant_id,
            {
                "actor_id": actor_id,
                "title": payload.title,
                "metadata": payload.metadata,
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.conversation_create",
            resource_type="assistant_conversation",
            resource_id=str(conversation["id"]),
            request_id=request_id_var.get(),
        )
        return {**conversation, "message_count": 0}

    async def list_conversations(
        self, principal: Principal, *, mine: bool, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        actor_id = require_actor_id(principal)
        if not mine:
            if not self.policy.is_superuser(principal):
                raise AuthorizationError(
                    "listing other actors' conversations requires platform administration"
                )
            actor_id = None
        items, total = await self.repository.list_conversations(
            tenant_id, actor_id, limit=limit, offset=offset
        )
        enriched: list[dict[str, Any]] = []
        for item in items:
            _, count = await self.repository.list_messages(
                tenant_id, item["id"], limit=1, offset=0
            )
            enriched.append({**item, "message_count": count})
        return enriched, total

    async def delete_conversation(
        self, principal: Principal, conversation_id: int
    ) -> None:
        tenant_id = require_tenant(principal)
        await self._owned_conversation(principal, conversation_id)
        deleted = await self.repository.delete_conversation(tenant_id, conversation_id)
        if not deleted:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.conversation_delete",
            resource_type="assistant_conversation",
            resource_id=str(conversation_id),
            request_id=request_id_var.get(),
        )

    async def update_conversation(
        self, principal: Principal, conversation_id: int, payload: Any
    ) -> dict[str, Any]:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        data: dict[str, Any] = {}
        if payload.title is not None:
            title = payload.title.strip()
            if not title:
                raise ValidationError("title must not be empty")
            data["title"] = title
        if payload.status is not None:
            data["status"] = payload.status
        updated = await self.repository.update_conversation(
            tenant_id, conversation_id, data
        )
        if updated is None:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.conversation_update",
            resource_type="assistant_conversation",
            resource_id=str(conversation_id),
            request_id=request_id_var.get(),
            detail={"fields": sorted(data)},
        )
        return {**updated, "message_count": conversation.get("message_count", 0)}

    async def get_conversation(
        self,
        principal: Principal,
        conversation_id: int,
        *,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        messages, total = await self.repository.list_messages(
            tenant_id, conversation_id, limit=limit, offset=offset
        )
        enriched = [await self._message_payload(principal, message) for message in messages]
        summary = await self.repository.get_conversation_summary(tenant_id, conversation_id)
        return {
            "conversation": {**conversation, "message_count": total},
            "messages": enriched,
            "total_messages": total,
            "summary": summary["summary"] if summary else None,
        }

    async def list_messages(
        self,
        principal: Principal,
        conversation_id: int,
        *,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        messages, total = await self.repository.list_messages(
            tenant_id, conversation_id, limit=limit, offset=offset
        )
        return {
            "items": [await self._message_payload(principal, m) for m in messages],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    async def cancel(self, principal: Principal, conversation_id: int) -> dict[str, Any]:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        messages = await self.repository.list_recent_messages(
            tenant_id, conversation["id"], limit=20
        )
        target = next(
            (
                message
                for message in reversed(messages)
                if message.get("generation_status") in ("pending", "streaming")
            ),
            None,
        )
        if target is None:
            return {"conversation_id": conversation_id, "cancelled": False}
        updated = await self.repository.update_message(
            tenant_id,
            target["id"],
            {
                "answer_status": ANSWER_STATUS_CANCELLED,
                "citations_required": False,
                "citation_status": "not_required",
                "warnings": ["generation_cancelled"],
                "generation_status": "cancelled",
            },
        )
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.copilot.cancel",
            resource_type="assistant_message",
            resource_id=str(target["id"]),
            request_id=request_id_var.get(),
        )
        return {
            "conversation_id": conversation_id,
            "cancelled": True,
            "message_id": target["id"],
            "generation_status": (updated or {}).get("generation_status", "cancelled"),
        }

    # --- Conversation ask ----------------------------------------------
    async def ask(
        self, principal: Principal, conversation_id: int, payload: Any
    ) -> dict[str, Any]:
        plan = await self._plan_conversation(principal, conversation_id, payload)
        message = await self._execute(principal, plan)
        await self._refresh_summary(principal, plan.conversation)
        return await self._message_payload(principal, message)

    # --- Streaming ------------------------------------------------------
    async def prepare_stream(
        self, principal: Principal, conversation_id: int, payload: Any
    ) -> GenerationPlan:
        if not self.settings.ai_copilot_stream_enabled:
            raise ValidationError("streaming is disabled")
        if payload.task not in ("ask", "explain"):
            raise ValidationError(
                "streaming is only supported for ask and explain tasks",
                details={"task": payload.task},
            )
        plan = await self._plan_conversation(principal, conversation_id, payload)
        if plan.request is not None and not self.gateway.supports_streaming(
            plan.request.model
        ):
            if plan.message is not None:
                await self.repository.update_message(
                    require_tenant(principal),
                    plan.message["id"],
                    {
                        "answer_status": ANSWER_STATUS_ERROR,
                        "citation_status": "not_required",
                        "warnings": ["streaming_unsupported"],
                        "generation_status": "failed",
                        "error": "streaming unsupported",
                    },
                )
            raise ValidationError(
                "the selected model does not support streaming",
                details={"model": plan.request.model},
            )
        return plan

    async def stream_events(
        self, principal: Principal, plan: GenerationPlan
    ) -> AsyncIterator[str]:
        tenant_id = require_tenant(principal)
        assert plan.message is not None
        message_id = plan.message["id"]
        if plan.insufficient:
            updated = await self.repository.update_message(
                tenant_id,
                message_id,
                {
                    "content": INSUFFICIENT_EVIDENCE_TEXT,
                    "answer_status": ANSWER_STATUS_INSUFFICIENT,
                    "citations_required": False,
                    "citation_status": "not_required",
                    "warnings": list(plan.warnings),
                    "generation_status": "completed",
                    "is_mock": True,
                },
            )
            yield _sse(
                "done",
                {
                    "message_id": message_id,
                    "content": INSUFFICIENT_EVIDENCE_TEXT,
                    "answer_status": ANSWER_STATUS_INSUFFICIENT,
                    "citations": [],
                    "citations_required": False,
                    "citation_status": "not_required",
                    "context": plan.context_refs,
                    "warnings": list(plan.warnings),
                    "generation_status": (updated or {}).get(
                        "generation_status", "completed"
                    ),
                    "prompt_version": plan.prompt_version,
                    "is_mock": True,
                    "request_id": request_id_var.get(),
                },
            )
            return

        assert plan.request is not None
        await self.repository.update_message(
            tenant_id, message_id, {"generation_status": "streaming"}
        )
        yield _sse(
            "start",
            {
                "message_id": message_id,
                "conversation_id": plan.conversation["id"] if plan.conversation else None,
                "task": plan.task,
                "citations": plan.citations,
                "context": plan.context_refs,
                "warnings": plan.warnings,
                "prompt_version": plan.prompt_version,
                "request_id": request_id_var.get(),
            },
        )
        chunks: list[str] = []
        cancelled = False
        try:
            async for chunk in self.gateway.stream_chat(plan.request):
                chunks.append(chunk)
                yield _sse("delta", {"content": chunk})
                if len(chunks) % 8 == 0:
                    current = await self.repository.get_message(tenant_id, message_id)
                    if current and current.get("generation_status") == "cancelled":
                        cancelled = True
                        break
        except Exception as exc:  # noqa: BLE001 - surface as SSE error frame
            logger.warning("copilot.stream_failed", error=str(exc))
            await self.repository.update_message(
                tenant_id,
                message_id,
                {
                    "answer_status": ANSWER_STATUS_ERROR,
                    "citation_status": "not_required",
                    "warnings": ["generation_failed"],
                    "generation_status": "failed",
                    "error": "generation failed",
                },
            )
            yield _sse(
                "error",
                {"code": getattr(exc, "code", "provider_error"), "message": str(exc)},
            )
            return

        content = "".join(chunks)
        if cancelled:
            await self.repository.update_message(
                tenant_id,
                message_id,
                {
                    "answer_status": ANSWER_STATUS_CANCELLED,
                    "citation_status": "not_required",
                    "warnings": ["generation_cancelled"],
                    "generation_status": "cancelled",
                },
            )
            yield _sse(
                "done",
                {
                    "message_id": message_id,
                    "content": content,
                    "generation_status": "cancelled",
                    "answer_status": ANSWER_STATUS_CANCELLED,
                    "citations_required": False,
                    "citation_status": "not_required",
                    "warnings": ["generation_cancelled"],
                    "request_id": request_id_var.get(),
                },
            )
            return

        warnings = list(plan.warnings)
        validation = validate_inline_citations(
            content,
            plan.citations,
            required=bool(plan.citations),
            evidence=plan.evidence,
        )
        record_citation_validation(operation="copilot_stream", status=validation.status)
        warnings.extend(validation.warnings)
        answer_status = validation.answer_status()
        plan.answer_status = answer_status
        plan.citations_required = validation.required
        plan.citation_status = validation.status
        latency_ms = int((time.perf_counter() - plan.started) * 1000)
        usage = {
            "input_tokens": estimate_tokens(
                " ".join(message.content for message in plan.request.messages)
            ),
            "output_tokens": estimate_tokens(content),
            "estimated": True,
        }
        updated = await self.repository.update_message(
            tenant_id,
            message_id,
            {
                "content": content,
                "answer_status": answer_status,
                "warnings": warnings,
                "citations_required": validation.required,
                "citation_status": validation.status,
                "generation_status": "completed",
                "latency_ms": latency_ms,
                "token_usage": usage,
            },
        )
        await self.repository.touch_conversation(tenant_id, plan.conversation["id"])
        await self._audit_task(principal, plan, "stream")
        yield _sse(
            "done",
            {
                "message_id": message_id,
                "content": content,
                "answer_status": answer_status,
                "citations_required": validation.required,
                "citation_status": validation.status,
                "generation_status": "completed",
                "citations": plan.citations,
                "context": plan.context_refs,
                "warnings": warnings,
                "prompt_version": plan.prompt_version,
                "is_mock": plan.is_mock,
                "latency_ms": latency_ms,
                "token_usage": usage,
                "request_id": request_id_var.get(),
                "created_at": str((updated or {}).get("created_at", "")),
            },
        )

    # --- Stateless tasks -------------------------------------------------
    async def task(self, principal: Principal, task: str, payload: Any) -> dict[str, Any]:
        if task not in _CONTEXT_TYPES:
            raise ValidationError("unsupported task", details={"task": task})
        plan = await self._plan_task(principal, task, payload)
        if plan.insufficient:
            await self._audit_task(principal, plan, task)
            plan.answer_status = ANSWER_STATUS_INSUFFICIENT
            plan.citations_required = False
            plan.citation_status = "not_required"
            return self._task_result(
                plan,
                content=INSUFFICIENT_EVIDENCE_TEXT,
                answer_status=ANSWER_STATUS_INSUFFICIENT,
                structured=None,
                latency_ms=0,
                usage={},
            )
        assert plan.request is not None
        started = time.perf_counter()
        try:
            response = await self.gateway.chat(plan.request)
        except Exception:
            logger.warning("copilot.task_failed", task=task)
            raise
        latency_ms = int((time.perf_counter() - started) * 1000)
        warnings = list(plan.warnings)
        structured: dict[str, Any] | None = None
        if task == "extract":
            structured, extract_warnings = self._validate_extraction(
                response.content, plan.fields, len(plan.citations)
            )
            warnings.extend(extract_warnings)
            validation = validate_extraction_citations(structured, fields=plan.fields)
        else:
            validation = validate_inline_citations(
                response.content,
                plan.citations,
                required=bool(plan.citations),
                evidence=plan.evidence,
            )
        record_citation_validation(operation="copilot_task", status=validation.status)
        warnings.extend(validation.warnings)
        answer_status = validation.answer_status()
        plan.answer_status = answer_status
        plan.citations_required = validation.required
        plan.citation_status = validation.status
        if response.is_mock:
            warnings.append("mock_provider_output_is_not_real_analysis")
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.total_tokens,
        }
        await self.audit.record(
            tenant_id=require_tenant(principal),
            actor_id=principal.actor_id,
            action=f"ai.copilot.{task}",
            resource_type="copilot_task",
            resource_id=None,
            request_id=request_id_var.get(),
            detail={
                "citations": len(plan.citations),
                "answer_status": answer_status,
                "citation_status": validation.status,
                "citation_warnings": len(validation.warnings),
                "context_items": len(plan.context_refs),
                "is_mock": response.is_mock,
            },
        )
        return self._task_result(
            plan,
            content=response.content,
            answer_status=answer_status,
            structured=structured,
            latency_ms=latency_ms,
            usage=usage,
            model=response.model,
            provider=response.provider,
            is_mock=response.is_mock,
            warnings=warnings,
        )

    # --- Capabilities ----------------------------------------------------
    async def capabilities(self, principal: Principal) -> dict[str, Any]:
        policy = await self.governance.policy_for(require_tenant(principal))
        default_model = default_chat_model(self.settings)
        stream_capable = bool(
            self.settings.ai_copilot_stream_enabled
            and self.gateway.supports_streaming(default_model)
        )
        tasks = [
            {
                "task": task,
                "available": policy.feature_enabled(
                    _FEATURE_BY_TASK.get(task, "copilot"), default=True
                ),
                "streaming": stream_capable and task in ("ask", "explain"),
                "requires_context": task in _CONTEXT_REQUIRED,
                "reasons": [],
            }
            for task in _CONTEXT_TYPES
        ]
        return {
            "tasks": tasks,
            "context_types": self.context.available_types(),
            "streaming": stream_capable,
            "prompt_version": prompts.PROMPT_VERSION,
            "is_mock": self.settings.llm_provider.strip().lower() in ("", "mock"),
            "tools": (
                self.tools.describe()
                if self.tools is not None and self.settings.ai_copilot_tools_enabled
                else []
            ),
            "actions_enabled": bool(
                self.actions is not None and self.settings.ai_copilot_actions_enabled
            ),
        }

    # --- Planning --------------------------------------------------------
    async def _plan_conversation(
        self, principal: Principal, conversation_id: int, payload: Any
    ) -> GenerationPlan:
        conversation = await self._owned_conversation(principal, conversation_id)
        tenant_id = require_tenant(principal)
        instruction = payload.content.strip()
        if len(instruction) > self.settings.ai_copilot_max_question_chars:
            raise ValidationError(
                "question exceeds the maximum length",
                details={"max_chars": self.settings.ai_copilot_max_question_chars},
            )
        task = payload.task
        history_summary, history_messages = await self._history(
            principal, conversation_id
        )
        policy = await self.governance.policy_for(tenant_id)
        await self._screen_instruction(
            principal,
            policy,
            instruction,
            feature=_FEATURE_BY_TASK.get(task, "copilot"),
        )
        refs_out, context_chunks, warnings = await self.context.resolve(
            principal, payload.context, policy=policy
        )
        evidence, retrieval_warnings = await self._evidence(
            principal,
            task=task,
            instruction=instruction,
            context_chunks=context_chunks,
            history_messages=history_messages,
            mode=payload.mode,
            filters=payload.filters,
            policy=policy,
            has_context=bool(refs_out),
            model=payload.model,
        )
        warnings.extend(retrieval_warnings)
        self._require_context(task, refs_out, context_chunks)
        if not evidence and task in ("compare", "extract"):
            warnings.append("context_required")

        plan = GenerationPlan(
            task=task,
            conversation=conversation,
            instruction=instruction,
            evidence=evidence,
            citations=[],
            context_refs=refs_out,
            history_summary=history_summary,
            history_messages=history_messages,
            request=None,
            message=None,
            warnings=warnings,
            output_format=payload.output_format,
            fields=self._extraction_fields(task, payload),
        )

        user_message = await self.repository.add_message(
            tenant_id,
            conversation_id,
            {
                "role": "user",
                "content": instruction,
                "request_id": request_id_var.get(),
                "task_type": task,
                "parent_message_id": payload.parent_message_id,
            },
        )
        if plan.context_refs:
            rows = [_RefRow(ref).ref_row() for ref in plan.context_refs]
            await self.repository.add_context_refs(tenant_id, user_message["id"], rows)
        placeholder = await self.repository.add_message(
            tenant_id,
            conversation_id,
            {
                "role": "assistant",
                "content": "",
                "citations_required": False,
                "citation_status": None,
                "generation_status": "pending",
                "prompt_version": plan.prompt_version,
                "task_type": task,
                "request_id": request_id_var.get(),
            },
        )
        plan.message = placeholder
        if plan.context_refs:
            rows = [_RefRow(ref).ref_row() for ref in plan.context_refs]
            await self.repository.add_context_refs(tenant_id, placeholder["id"], rows)

        feature = _FEATURE_BY_TASK.get(task, "copilot")
        if task in _RETRIEVAL_TASKS:
            plan.tool_results = await self._invoke_tools(
                principal,
                conversation_id=conversation_id,
                message_id=placeholder["id"],
                instruction=instruction,
                feature=feature,
            )
            if plan.tool_results:
                warnings.append("enterprise_tools_used")

        # A question may be answered from enterprise tool results even when the
        # knowledge corpus has no matching document. Without either source there
        # is no authorized grounding, so the copilot reports insufficiency.
        insufficient = self._insufficient(task, evidence, context_chunks, refs_out)
        if insufficient and plan.tool_results:
            insufficient = False
        if insufficient:
            warnings.append("insufficient_authorized_evidence")
        plan.insufficient = insufficient
        plan.citations = self._citations(evidence)
        if insufficient:
            plan.is_mock = True
        else:
            plan.request, plan.is_mock = await self._build_request(
                principal,
                plan,
                policy,
                payload.model,
                feature=feature,
                with_tools=bool(plan.tool_results),
            )
        await self.repository.update_message(
            tenant_id,
            placeholder["id"],
            {
                "is_mock": plan.is_mock,
                "model_code": plan.request.model if plan.request else None,
                "citations_required": bool(plan.citations),
                "citation_status": "not_required" if insufficient else None,
                "warnings": list(plan.warnings) if insufficient else [],
                "answer_status": ANSWER_STATUS_INSUFFICIENT if insufficient else None,
                "generation_status": "completed" if insufficient else "pending",
            },
        )
        if plan.citations:
            await self.repository.add_message_sources(
                tenant_id, placeholder["id"], self._source_rows(plan.citations)
            )
        requested_action = getattr(payload, "action", None)
        if requested_action is not None and self.actions is not None:
            plan.proposed_action = await self.actions.propose(
                principal,
                action_type=requested_action.action_type,
                target=requested_action.target,
                summary=requested_action.summary,
                arguments=requested_action.arguments,
                expected_effect=requested_action.expected_effect,
                evidence=self._source_rows(plan.citations),
                conversation_id=conversation_id,
                message_id=placeholder["id"],
            )
        await self.repository.touch_conversation(tenant_id, conversation_id)
        return plan

    async def _plan_task(
        self, principal: Principal, task: str, payload: Any
    ) -> GenerationPlan:
        policy = await self.governance.policy_for(require_tenant(principal))
        instruction = (payload.instruction or "").strip()
        if task in ("ask", "explain") and not instruction:
            raise ValidationError("an instruction is required", details={"task": task})
        if len(instruction) > self.settings.ai_copilot_max_question_chars:
            raise ValidationError(
                "instruction exceeds the maximum length",
                details={"max_chars": self.settings.ai_copilot_max_question_chars},
            )
        await self._screen_instruction(
            principal,
            policy,
            instruction,
            feature=_FEATURE_BY_TASK.get(task, "copilot"),
        )
        refs_out, context_chunks, warnings = await self.context.resolve(
            principal, payload.context, policy=policy
        )
        self._require_context(task, refs_out, context_chunks)
        evidence, retrieval_warnings = await self._evidence(
            principal,
            task=task,
            instruction=instruction,
            context_chunks=context_chunks,
            history_messages=[],
            mode=payload.mode,
            filters=payload.filters,
            policy=policy,
            has_context=bool(refs_out),
            model=payload.model,
        )
        warnings.extend(retrieval_warnings)
        insufficient = self._insufficient(task, evidence, context_chunks, refs_out)
        if insufficient:
            warnings.append("insufficient_authorized_evidence")
        plan = GenerationPlan(
            task=task,
            conversation=None,
            instruction=instruction,
            evidence=evidence,
            citations=self._citations(evidence),
            context_refs=refs_out,
            history_summary=None,
            history_messages=[],
            request=None,
            message=None,
            warnings=warnings,
            output_format="json" if task == "extract" else payload.output_format,
            fields=self._extraction_fields(task, payload),
        )
        if insufficient:
            plan.is_mock = True
        else:
            plan.request, plan.is_mock = await self._build_request(
                principal,
                plan,
                policy,
                payload.model,
                feature=_FEATURE_BY_TASK.get(task, "copilot"),
            )
        return plan

    async def _evidence(
        self,
        principal: Principal,
        *,
        task: str,
        instruction: str,
        context_chunks: list[dict[str, Any]],
        history_messages: list[dict[str, Any]],
        mode: str,
        filters: list[Any],
        policy: Any,
        has_context: bool,
        model: str | None = None,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        warnings: list[str] = []
        retrieved: list[dict[str, Any]] = []
        should_retrieve = task in _RETRIEVAL_TASKS or (
            task == "summarize" and not context_chunks
        )
        if should_retrieve:
            query = self._retrieval_query(instruction, history_messages)
            retrieved = await self.retrieval.authorized_search(
                principal,
                query,
                limit=self.settings.ai_rag_default_limit,
                mode=mode,
                filters=filters,
            )
        elif not has_context and task in ("compare", "extract"):
            warnings.append("context_required")

        merged: list[dict[str, Any]] = []
        seen: set[tuple[Any, Any]] = set()
        for chunk in context_chunks:
            key = (chunk.get("document_id"), chunk.get("chunk_id"))
            if key in seen:
                continue
            seen.add(key)
            merged.append({**chunk, "context_type": "knowledge_document", "score": 1.0})
        for chunk in retrieved:
            key = (chunk.get("document_id"), chunk.get("chunk_id"))
            if key in seen:
                continue
            seen.add(key)
            merged.append(dict(chunk))
        budget = max(
            self.settings.ai_rag_max_context_chars,
            self.settings.ai_copilot_context_max_chars,
        )
        used = 0
        bounded: list[dict[str, Any]] = []
        for chunk in merged:
            size = len(chunk.get("content") or "")
            if used + size > budget and bounded:
                warnings.append("evidence_truncated")
                break
            bounded.append(chunk)
            used += size

        guard = PromptGuard(block=blocking_enabled(policy, self.settings))
        screened, scan = await filter_evidence(
            self.audit,
            principal,
            guard=guard,
            items=bounded,
            feature=_FEATURE_BY_TASK.get(task, "copilot"),
            model=model,
            resource_type="copilot_task",
        )
        if scan.suspicious and guard.block:
            warnings.append("evidence_filtered")
        return screened, warnings

    async def _build_request(
        self,
        principal: Principal,
        plan: GenerationPlan,
        policy: Any,
        model_override: str | None,
        *,
        feature: str,
        with_tools: bool = False,
    ) -> tuple[ChatRequest, bool]:
        model = model_override or default_chat_model(self.settings)
        guard = PromptGuard(block=blocking_enabled(policy, self.settings))
        prompt_text = plan.instruction + "\n".join(
            c.get("content") or "" for c in plan.evidence
        )
        if with_tools and plan.tool_results:
            prompt_text += "\n" + prompts.tool_block(plan.tool_results)
        await self.governance.enforce(
            principal,
            operation="rag" if plan.task == "ask" else "summarize",
            model=model,
            prompt_text=prompt_text,
            feature=feature,
        )
        evidence_block = prompts.context_block(plan.evidence)
        history = prompts.history_block(plan.history_summary, plan.history_messages)
        schema = self._extraction_schema(plan.fields) if plan.task == "extract" else None
        tool_text = prompts.tool_block(plan.tool_results) if with_tools else ""
        user_text = prompts.user_prompt(
            plan.task,
            plan.instruction,
            evidence_block=evidence_block,
            history=history,
            output_format=plan.output_format,
            extraction_schema=schema,
            tool_block=tool_text,
        )
        messages = (
            Message(
                role=Role.system,
                content=guard.harden_system_prompt(
                    prompts.system_prompt(
                        plan.task, plan.output_format, with_tools=with_tools
                    )
                ),
            ),
            Message(role=Role.user, content=user_text),
        )
        is_mock = self.settings.llm_provider.strip().lower() in ("", "mock")
        return (
            ChatRequest(
                messages=messages,
                model=model,
                temperature=0.0,
                response_format="json" if plan.task == "extract" else "text",
                json_schema=(None if is_mock else schema),
                timeout_seconds=self.settings.ai_copilot_task_timeout_seconds,
                metadata={"prompt_version": plan.prompt_version, "task": plan.task},
            ),
            is_mock,
        )

    # --- Execution ------------------------------------------------------
    async def _execute(
        self, principal: Principal, plan: GenerationPlan
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        assert plan.message is not None
        assert plan.conversation is not None
        message_id = plan.message["id"]
        if plan.insufficient:
            plan.answer_status = ANSWER_STATUS_INSUFFICIENT
            plan.citations_required = False
            plan.citation_status = "not_required"
            updated = await self.repository.update_message(
                tenant_id,
                message_id,
                {
                    "content": INSUFFICIENT_EVIDENCE_TEXT,
                    "answer_status": ANSWER_STATUS_INSUFFICIENT,
                    "citations_required": False,
                    "citation_status": "not_required",
                    "warnings": list(plan.warnings),
                    "generation_status": "completed",
                },
            )
            await self._audit_task(principal, plan, "ask")
            assert updated is not None
            return updated
        assert plan.request is not None
        await self.repository.update_message(
            tenant_id, message_id, {"generation_status": "streaming"}
        )
        started = time.perf_counter()
        try:
            response = await self.gateway.chat(plan.request)
        except Exception:
            logger.warning("copilot.generate_failed", task=plan.task)
            await self.repository.update_message(
                tenant_id,
                message_id,
                {
                    "answer_status": ANSWER_STATUS_ERROR,
                    "citations_required": bool(plan.citations),
                    "citation_status": "not_required",
                    "warnings": ["generation_failed"],
                    "generation_status": "failed",
                    "error": "generation failed",
                },
            )
            raise
        current = await self.repository.get_message(tenant_id, message_id)
        if current and current.get("generation_status") == "cancelled":
            return current
        warnings = list(plan.warnings)
        structured: dict[str, Any] | None = None
        if plan.task == "extract":
            structured, extract_warnings = self._validate_extraction(
                response.content, plan.fields, len(plan.citations)
            )
            warnings.extend(extract_warnings)
            validation = validate_extraction_citations(structured, fields=plan.fields)
        else:
            validation = validate_inline_citations(
                response.content,
                plan.citations,
                required=bool(plan.citations),
                evidence=plan.evidence,
            )
        record_citation_validation(operation="copilot_message", status=validation.status)
        warnings.extend(validation.warnings)
        answer_status = validation.answer_status()
        plan.answer_status = answer_status
        plan.citations_required = validation.required
        plan.citation_status = validation.status
        latency_ms = int((time.perf_counter() - started) * 1000)
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.total_tokens,
        }
        updated = await self.repository.update_message(
            tenant_id,
            message_id,
            {
                "content": response.content,
                "answer_status": answer_status,
                "warnings": warnings,
                "citations_required": validation.required,
                "citation_status": validation.status,
                "generation_status": "completed",
                "confidence": None,
                "is_mock": response.is_mock,
                "model_code": response.model,
                "provider_code": response.provider,
                "token_usage": usage,
                "latency_ms": latency_ms,
                "error": None,
            },
        )
        await self._audit_task(principal, plan, "ask")
        assert updated is not None
        return updated

    async def _audit_task(
        self, principal: Principal, plan: GenerationPlan, operation: str
    ) -> None:
        await self.audit.record(
            tenant_id=require_tenant(principal),
            actor_id=principal.actor_id,
            action=f"ai.copilot.{operation}",
            resource_type="assistant_message",
            resource_id=str(plan.message["id"]) if plan.message else None,
            request_id=request_id_var.get(),
            detail={
                "task": plan.task,
                "citations": len(plan.citations),
                "answer_status": plan.answer_status,
                "citation_status": plan.citation_status,
                "warnings": len(plan.warnings),
                "context_items": len(plan.context_refs),
                "prompt_version": plan.prompt_version,
                "is_mock": plan.is_mock,
            },
        )

    async def _screen_instruction(
        self,
        principal: Principal,
        policy: Any,
        instruction: str,
        *,
        feature: str = "copilot",
    ) -> None:
        guard = PromptGuard(block=blocking_enabled(policy, self.settings))
        await screen_input(
            self.audit,
            principal,
            guard=guard,
            texts=[instruction],
            feature=feature,
            model=None,
            resource_type="copilot_task",
        )

    async def _history(
        self, principal: Principal, conversation_id: int
    ) -> tuple[str | None, list[dict[str, Any]]]:
        tenant_id = require_tenant(principal)
        summary_row = await self.repository.get_conversation_summary(
            tenant_id, conversation_id
        )
        messages = await self.repository.list_recent_messages(
            tenant_id,
            conversation_id,
            limit=self.settings.ai_copilot_history_max_messages,
        )
        budget = self.settings.ai_copilot_history_max_chars
        selected: list[dict[str, Any]] = []
        used = 0
        for message in reversed(messages):
            size = len(message.get("content") or "")
            if selected and used + size > budget:
                break
            selected.append(
                {
                    "role": message.get("role"),
                    "content": (message.get("content") or "")[:budget],
                }
            )
            used += size
            if used >= budget:
                break
        selected.reverse()
        summary = None
        if summary_row:
            first_id = messages[0]["id"] if messages else None
            through = summary_row.get("through_message_id")
            if first_id is None or through is None or through < first_id:
                summary = summary_row["summary"]
        return summary, selected

    async def _refresh_summary(
        self, principal: Principal, conversation: dict[str, Any]
    ) -> None:
        if not self.settings.ai_copilot_summary_enabled:
            return
        tenant_id = require_tenant(principal)
        messages, total = await self.repository.list_messages(
            tenant_id,
            conversation["id"],
            limit=200,
            offset=0,
        )
        if total <= self.settings.ai_copilot_summary_threshold_messages:
            return
        stale = messages[: max(0, total - self.settings.ai_copilot_history_max_messages)]
        if not stale:
            return
        existing = await self.repository.get_conversation_summary(
            tenant_id, conversation["id"]
        )
        last = stale[-1]
        if existing and existing.get("through_message_id") is not None:
            if existing["through_message_id"] >= last["id"]:
                return
        pieces: list[str] = []
        used = 0
        limit = self.settings.ai_copilot_summary_max_chars
        for message in stale:
            text = (message.get("content") or "").strip().replace("\n", " ")
            if not text:
                continue
            line = f"- {'User' if message['role'] == 'user' else 'Assistant'}: {text[:220]}"
            if used + len(line) > limit:
                break
            pieces.append(line)
            used += len(line)
        if not pieces:
            return
        summary = "Earlier conversation (derived):\n" + "\n".join(pieces)
        try:
            await self.repository.upsert_conversation_summary(
                tenant_id,
                conversation["id"],
                {
                    "summary": summary,
                    "through_message_id": last["id"],
                    "token_estimate": estimate_tokens(summary),
                },
            )
        except Exception as exc:  # noqa: BLE001 - summary is best effort
            logger.warning("copilot.summary_failed", error=str(exc))

    # --- Tool orchestration ---------------------------------------------
    async def _invoke_tools(
        self,
        principal: Principal,
        *,
        conversation_id: int | None,
        message_id: int | None,
        instruction: str,
        feature: str,
    ) -> list[dict[str, Any]]:
        """Select and run bounded, authorized enterprise read tools.

        Failures never fail the answer: a denied or failed tool only narrows the
        evidence available to the model. Every attempt is persisted as a tool
        trace row so operators can see what was called and why it failed.
        """

        if self.tools is None or not self.settings.ai_copilot_tools_enabled:
            return []
        limit = self.settings.ai_copilot_max_tool_calls
        if limit <= 0:
            return []
        selected = self.tools.select(instruction, limit=limit)
        if not selected:
            return []
        tenant_id = require_tenant(principal)
        results: list[dict[str, Any]] = []
        for name in selected:
            args: dict[str, Any] = {"query": instruction[:300]}
            outcome: ToolOutcome = await self.tools.run(principal, name, args)
            await self._record_tool_trace(
                tenant_id,
                conversation_id=conversation_id,
                message_id=message_id,
                outcome=outcome,
                feature=feature,
            )
            if outcome.status == "succeeded":
                results.append(outcome.summary)
        return results

    async def _record_tool_trace(
        self,
        tenant_id: int,
        *,
        conversation_id: int | None,
        message_id: int | None,
        outcome: ToolOutcome,
        feature: str,
    ) -> None:
        try:
            await self.repository.record_copilot_tool_invocation(
                tenant_id,
                {
                    "conversation_id": conversation_id,
                    "message_id": message_id,
                    "tool_code": outcome.name,
                    "status": outcome.status,
                    "read_only": outcome.read_only,
                    "arguments": {"feature": feature},
                    "result_summary": _tool_trace_summary(outcome.summary),
                    "error_class": outcome.error_class,
                    "duration_ms": outcome.duration_ms,
                    "request_id": request_id_var.get(),
                },
            )
        except Exception as exc:  # noqa: BLE001 - trace must not break answering
            logger.warning("copilot.tool_trace_failed", error=str(exc))


    def _require_context(
        self,
        task: str,
        refs_out: list[dict[str, Any]],
        context_chunks: list[dict[str, Any]],
    ) -> None:
        if task not in _CONTEXT_REQUIRED:
            return
        if not refs_out:
            raise ValidationError(
                "this task requires at least one context reference",
                details={"task": task},
            )
        if task == "compare":
            distinct = {chunk.get("document_id") for chunk in context_chunks}
            if len(distinct) < 2:
                raise ValidationError(
                    "comparison requires at least two authorized sources",
                    details={"sources": len(distinct)},
                )
        if task == "extract" and not context_chunks:
            raise ValidationError(
                "extraction requires authorized context content",
                details={"task": task},
            )

    def _insufficient(
        self,
        task: str,
        evidence: list[dict[str, Any]],
        context_chunks: list[dict[str, Any]],
        refs_out: list[dict[str, Any]],
    ) -> bool:
        if not evidence:
            return True
        if task == "compare":
            distinct = {chunk.get("document_id") for chunk in evidence}
            return len(distinct) < 2
        if task in ("summarize", "extract") and not context_chunks:
            return True
        if context_chunks:
            return False
        vector_scores = [
            float(item["vector_score"])
            for item in evidence
            if item.get("vector_score") is not None
        ]
        if vector_scores:
            return max(vector_scores) < self.settings.ai_rag_min_score
        return False

    def _extraction_fields(
        self, task: str, payload: Any
    ) -> list[dict[str, Any]]:
        if task != "extract":
            return []
        fields = [
            {
                "name": getattr(field, "name", None) or field["name"],
                "description": getattr(field, "description", None)
                if not isinstance(field, dict)
                else field.get("description"),
                "type": getattr(field, "type", None)
                if not isinstance(field, dict)
                else field.get("type", "string"),
            }
            for field in (payload.fields or [])
        ]
        if not fields:
            fields = [dict(field) for field in _DEFAULT_EXTRACTION_FIELDS]
        if len(fields) > self.settings.ai_copilot_max_fields:
            raise ValidationError(
                "too many extraction fields",
                details={"max_fields": self.settings.ai_copilot_max_fields},
            )
        return fields

    @staticmethod
    def _extraction_schema(fields: list[dict[str, Any]]) -> dict[str, Any]:
        value_type = {
            "string": "string",
            "number": "number",
            "date": "string",
            "boolean": "boolean",
            "list": "array",
        }
        properties: dict[str, Any] = {}
        for field_spec in fields:
            properties[field_spec["name"]] = {
                "type": [value_type.get(field_spec["type"], "string"), "null"],
            }
        return {
            "type": "object",
            "properties": {
                "fields": {
                    "type": "object",
                    "properties": properties,
                    "required": [field["name"] for field in fields],
                    "additionalProperties": False,
                },
                "evidence": {
                    "type": "object",
                    "additionalProperties": {"type": "array", "items": {"type": "integer"}},
                },
                "missing": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["fields"],
            "additionalProperties": False,
        }

    def _validate_extraction(
        self, content: str, fields: list[dict[str, Any]], evidence_count: int
    ) -> tuple[dict[str, Any] | None, list[str]]:
        warnings: list[str] = []
        text = content.strip()
        if text.startswith("```"):
            text = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            parsed = json.loads(text)
        except (TypeError, ValueError):
            return None, ["invalid_json_output"]
        if not isinstance(parsed, dict):
            return None, ["invalid_json_shape"]
        raw_fields = parsed.get("fields")
        if not isinstance(raw_fields, dict):
            raw_fields = parsed
            warnings.append("extraction_missing_fields_wrapper")
        raw_evidence = parsed.get("evidence") if isinstance(parsed, dict) else {}
        raw_evidence = raw_evidence if isinstance(raw_evidence, dict) else {}
        values: dict[str, Any] = {}
        evidence: dict[str, list[int]] = {}
        missing: list[str] = []
        invalid: list[str] = []
        citation_missing: list[str] = []
        citation_invalid: list[str] = []
        for field_spec in fields:
            name = field_spec["name"]
            refs = raw_evidence.get(name)
            if isinstance(refs, list):
                evidence[name] = [
                    int(ref)
                    for ref in refs
                    if isinstance(ref, int)
                    and not isinstance(ref, bool)
                    and 1 <= int(ref) <= evidence_count
                ]
            value = raw_fields.get(name)
            if value is None:
                values[name] = None
                missing.append(name)
                continue
            coerced, ok = self._coerce(value, field_spec.get("type", "string"))
            if not ok:
                values[name] = None
                invalid.append(name)
                warnings.append(f"invalid_value:{name}")
                continue
            values[name] = coerced
            if not isinstance(refs, list) or not refs:
                citation_missing.append(name)
            elif any(
                not isinstance(ref, int)
                or isinstance(ref, bool)
                or int(ref) < 1
                or int(ref) > evidence_count
                for ref in refs
            ):
                citation_invalid.append(name)
        if invalid:
            warnings.append("extraction_invalid_fields")
        return (
            {
                "fields": values,
                "evidence": evidence,
                "missing": missing,
                "invalid": invalid,
                "citation_missing": citation_missing,
                "citation_invalid": citation_invalid,
            },
            warnings,
        )

    @staticmethod
    def _coerce(value: Any, value_type: str) -> tuple[Any, bool]:
        if value_type == "number":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None, False
            return value, True
        if value_type == "boolean":
            return (value, True) if isinstance(value, bool) else (None, False)
        if value_type == "list":
            return (value, True) if isinstance(value, list) else (None, False)
        if value_type == "string":
            return (value, True) if isinstance(value, str) else (None, False)
        if value_type == "date":
            if isinstance(value, str) and value.strip():
                return value, True
            return None, False
        return None, False

    # --- Citation helpers -----------------------------------------------
    def _citations(self, evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            self.retrieval.citation(index, item)
            for index, item in enumerate(evidence, start=1)
        ]

    @staticmethod
    def _citation_warnings(
        content: str, citations: list[dict[str, Any]]
    ) -> list[str]:
        return list(
            validate_inline_citations(
                content,
                citations,
                required=bool(citations),
            ).warnings
        )

    @staticmethod
    def _source_rows(citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "rank": citation["rank"],
                "source_id": citation.get("source_id"),
                "document_id": citation.get("document_id"),
                "chunk_id": citation.get("chunk_id"),
                "source_code": citation.get("source_code"),
                "chunk_index": citation.get("chunk_index"),
                "page": citation.get("page"),
                "section": citation.get("section"),
                "score": citation.get("score"),
                "snippet": citation.get("snippet"),
            }
            for citation in citations
        ]

    @staticmethod
    def _retrieval_query(instruction: str, history_messages: list[dict[str, Any]]) -> str:
        previous = [
            message["content"]
            for message in history_messages
            if message.get("role") == "user" and message.get("content")
        ][-2:]
        if not previous:
            return instruction
        query = " ".join([*previous, instruction]).strip()
        return query[:1000]

    async def _message_payload(
        self, principal: Principal, message: dict[str, Any]
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        sources = await self.repository.get_message_sources(tenant_id, message["id"])
        context = await self.repository.list_context_refs(tenant_id, message["id"])
        tool_trace = await self.repository.list_copilot_tool_invocations(
            tenant_id, message["id"]
        )
        actions, _ = await self.repository.list_copilot_actions(
            tenant_id,
            status=None,
            conversation_id=message["conversation_id"],
            limit=50,
            offset=0,
        )
        return {
            "id": message["id"],
            "conversation_id": message["conversation_id"],
            "role": message["role"],
            "content": message["content"],
            "answer_status": message.get("answer_status"),
            "warnings": list(message.get("warnings") or []),
            "citations_required": bool(message.get("citations_required", False)),
            "citation_status": message.get("citation_status"),
            "confidence": (
                float(message["confidence"])
                if message.get("confidence") is not None
                else None
            ),
            "is_mock": message.get("is_mock"),
            "model_code": message.get("model_code"),
            "provider_code": message.get("provider_code"),
            "token_usage": message.get("token_usage") or {},
            "latency_ms": message.get("latency_ms"),
            "task_type": message.get("task_type"),
            "generation_status": message.get("generation_status") or "completed",
            "prompt_version": message.get("prompt_version"),
            "parent_message_id": message.get("parent_message_id"),
            "created_at": message["created_at"],
            "sources": [
                {
                    "rank": source["rank"],
                    "source_id": source.get("source_id"),
                    "document_id": source.get("document_id"),
                    "chunk_id": source.get("chunk_id"),
                    "source_code": source.get("source_code"),
                    "chunk_index": source.get("chunk_index"),
                    "page": source.get("page"),
                    "section": source.get("section"),
                    "score": (
                        float(source["score"])
                        if source.get("score") is not None
                        else None
                    ),
                    "snippet": source.get("snippet"),
                }
                for source in sources
            ],
            "tools": [
                {
                    "tool_code": row["tool_code"],
                    "status": row["status"],
                    "read_only": bool(row.get("read_only", True)),
                    "error_class": row.get("error_class"),
                    "duration_ms": row.get("duration_ms"),
                }
                for row in tool_trace
            ],
            "actions": [
                {
                    "id": row["id"],
                    "action_type": row["action_type"],
                    "target": row.get("target"),
                    "summary": row["summary"],
                    "status": row["status"],
                    "risk_class": row["risk_class"],
                    "expected_effect": row.get("expected_effect"),
                    "requested_by_name": row.get("requested_by_name"),
                    "approved_by_name": row.get("approved_by_name"),
                    "executed_by_name": row.get("executed_by_name"),
                    "decision_reason": row.get("decision_reason"),
                    "expires_at": row.get("expires_at"),
                    "created_at": row.get("created_at"),
                }
                for row in actions
                if row.get("message_id") == message["id"]
            ],
            "context": [
                {
                    "type": ref["context_type"],
                    "object_id": ref["object_id"],
                    "display_name": ref.get("display_name"),
                    "source_system": ref.get("source_system"),
                    "revision": ref.get("revision"),
                    "lifecycle_state": ref.get("lifecycle_state"),
                    "metadata": ref.get("metadata") or {},
                    "provenance": ref.get("provenance") or {},
                }
                for ref in context
            ],
        }

    async def _owned_conversation(
        self, principal: Principal, conversation_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        actor_id = require_actor_id(principal)
        conversation = await self.repository.get_conversation(tenant_id, conversation_id)
        if conversation is None:
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        owner = conversation.get("actor_id")
        if (
            isinstance(owner, bool)
            or not isinstance(owner, int)
            or owner <= 0
            or owner != actor_id
        ):
            raise NotFoundError(
                "conversation not found", details={"conversation_id": conversation_id}
            )
        return conversation

    @staticmethod
    def _task_result(
        plan: GenerationPlan,
        *,
        content: str,
        answer_status: str,
        structured: dict[str, Any] | None,
        latency_ms: int,
        usage: dict[str, Any],
        model: str | None = None,
        provider: str | None = None,
        is_mock: bool | None = None,
        warnings: list[str] | None = None,
    ) -> dict[str, Any]:
        result_warnings = list(plan.warnings)
        if warnings:
            result_warnings.extend(warnings)
        return {
            "task_type": plan.task,
            "content": content,
            "structured": structured,
            "citations": plan.citations,
            "context": plan.context_refs,
            "answer_status": answer_status,
            "confidence": None,
            "warnings": result_warnings,
            "citations_required": plan.citations_required,
            "citation_status": plan.citation_status,
            "is_mock": plan.is_mock if is_mock is None else is_mock,
            "prompt_version": plan.prompt_version,
            "request_id": request_id_var.get(),
            "model_code": model,
            "provider_code": provider,
            "token_usage": usage,
            "latency_ms": latency_ms,
        }


def _tool_trace_summary(summary: dict[str, Any]) -> dict[str, Any]:
    """Bounded, non-sensitive summary persisted with a tool-invocation trace."""

    if not isinstance(summary, dict):
        return {}
    rows = summary.get("rows")
    bounded = []
    if isinstance(rows, list):
        for row in rows[:5]:
            if isinstance(row, dict):
                bounded.append(
                    {
                        key: value
                        for key, value in row.items()
                        if key
                        in (
                            "type",
                            "id",
                            "code",
                            "title",
                            "status",
                            "lifecycle_state",
                            "revision",
                            "severity",
                            "result",
                            "score",
                        )
                    }
                )
    return {
        "tool": summary.get("tool"),
        "total": summary.get("total"),
        "returned": summary.get("returned"),
        "rows": bounded,
    }


@dataclass(slots=True)
class _RefRow:
    ref: dict[str, Any]

    def ref_row(self) -> dict[str, Any]:
        return {
            "context_type": self.ref["type"],
            "object_id": self.ref["object_id"],
            "display_name": self.ref.get("display_name"),
            "source_system": self.ref.get("source_system"),
            "revision": self.ref.get("revision"),
            "lifecycle_state": self.ref.get("lifecycle_state"),
            "metadata": self.ref.get("metadata") or {},
            "provenance": self.ref.get("provenance") or {},
        }
