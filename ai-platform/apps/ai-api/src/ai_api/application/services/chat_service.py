from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.event_service import EventPublisher
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import AuthorizationError, ValidationError
from ai_api.domain.models.provider import ChatRequest, ChatResponse, Message, Role
from ai_api.infrastructure.providers.registry import default_chat_model
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.logging import get_logger, request_id_var

logger = get_logger("chat")

SUMMARIZE_SYSTEM_PROMPT = (
    "You are a precise enterprise summarization assistant. Summarize only the "
    "provided content, preserve key facts and figures, and never invent details. "
    "If the content is insufficient, say so."
)


@dataclass(slots=True)
class ChatService:
    gateway: ModelGateway
    repository: AiRepository
    audit: AuditService
    governance: GovernanceService
    settings: Settings
    events: EventPublisher | None = None

    async def chat(self, principal, payload) -> dict[str, Any]:
        model = payload.model or default_chat_model(self.settings)
        prompt_text = "\n".join(msg.content for msg in payload.messages)

        policy = await self.governance.enforce(
            principal, operation="chat", model=model, prompt_text=prompt_text, feature="chat"
        )
        guard = PromptGuard(block=policy.block_prompt_injection)
        scan = guard.scan(prompt_text)
        if guard.block and scan.suspicious:
            await self._audit_denied(principal, "ai.chat", model, scan.findings)
            raise AuthorizationError(
                "request rejected by content security policy",
                details={"findings": len(scan.findings)},
            )

        messages = [
            Message(role=Role.system, content=guard.harden_system_prompt(None)),
            *(Message(role=Role(msg.role), content=msg.content) for msg in payload.messages),
        ]
        request = ChatRequest(
            messages=tuple(messages),
            model=model,
            temperature=payload.temperature,
            max_output_tokens=payload.max_output_tokens,
            response_format=payload.response_format,
            json_schema=payload.json_schema,
        )

        started = time.perf_counter()
        response = await self.gateway.chat(request)
        latency_ms = int((time.perf_counter() - started) * 1000)

        await self._persist(principal, "chat", response, latency_ms)
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action="ai.chat",
            resource_type="model",
            resource_id=response.model,
            request_id=request_id_var.get(),
            detail={
                "is_mock": response.is_mock,
                "provider": response.provider,
                "injection_findings": len(scan.findings),
            },
        )
        return self._serialize(response)

    async def summarize(self, principal, payload) -> dict[str, Any]:
        if not payload.text.strip():
            raise ValidationError("text must not be empty")
        model = payload.model or default_chat_model(self.settings)

        policy = await self.governance.enforce(
            principal,
            operation="summarize",
            model=model,
            prompt_text=payload.text,
            feature="summarize",
        )
        guard = PromptGuard(block=policy.block_prompt_injection)
        scan = guard.scan(payload.text)
        if guard.block and scan.suspicious:
            await self._audit_denied(principal, "ai.summarize", model, scan.findings)
            raise AuthorizationError(
                "request rejected by content security policy",
                details={"findings": len(scan.findings)},
            )

        request = ChatRequest(
            messages=(
                Message(
                    role=Role.system,
                    content=guard.harden_system_prompt(SUMMARIZE_SYSTEM_PROMPT),
                ),
                Message(role=Role.user, content=payload.text),
            ),
            model=model,
            temperature=0.0,
        )

        started = time.perf_counter()
        response = await self.gateway.chat(request)
        latency_ms = int((time.perf_counter() - started) * 1000)

        await self._persist(principal, "chat", response, latency_ms)
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action="ai.summarize",
            resource_type="model",
            resource_id=response.model,
            request_id=request_id_var.get(),
            detail={
                "is_mock": response.is_mock,
                "provider": response.provider,
                "injection_findings": len(scan.findings),
            },
        )
        result = self._serialize(response)
        result["summary"] = result.pop("content")
        return result

    async def _audit_denied(
        self, principal, action: str, model: str, findings: tuple[str, ...]
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="model",
            resource_id=model,
            outcome="denied",
            request_id=request_id_var.get(),
            detail={"reason": "prompt_injection", "findings": len(findings)},
        )

    async def _persist(
        self, principal, operation: str, response: ChatResponse, latency_ms: int
    ) -> None:
        if principal.tenant_id is None:
            return
        try:
            execution = await self.repository.record_execution(
                principal.tenant_id,
                {
                    "actor_id": principal.actor_id,
                    "operation": operation,
                    "status": "succeeded",
                    "input": {},
                    "token_usage": {
                        "input_tokens": response.usage.input_tokens,
                        "output_tokens": response.usage.output_tokens,
                        "total_tokens": response.usage.total_tokens,
                    },
                    "latency_ms": latency_ms,
                    "request_id": request_id_var.get(),
                },
            )
            await self.repository.record_usage(
                principal.tenant_id,
                {
                    "execution_id": execution["id"],
                    "provider_code": response.provider,
                    "model_code": response.model,
                    "kind": "input",
                    "quantity": response.usage.input_tokens,
                    "unit": "tokens",
                },
            )
            await self.repository.record_usage(
                principal.tenant_id,
                {
                    "execution_id": execution["id"],
                    "provider_code": response.provider,
                    "model_code": response.model,
                    "kind": "output",
                    "quantity": response.usage.output_tokens,
                    "unit": "tokens",
                    "total_cost": response.estimated_cost_usd,
                },
            )
            if self.events is not None:
                await self.events.ai_request_completed(
                    tenant_id=principal.tenant_id,
                    actor_id=principal.actor_id,
                    operation=operation,
                    model=response.model,
                    provider=response.provider,
                    status="succeeded",
                    is_mock=response.is_mock,
                    latency_ms=latency_ms,
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                    total_tokens=response.usage.total_tokens,
                )
        except Exception as exc:  # noqa: BLE001 - persistence must not fail the request
            logger.warning("chat.persist_failed", error=str(exc))

    @staticmethod
    def _serialize(response: ChatResponse) -> dict[str, Any]:
        return {
            "content": response.content,
            "model": response.model,
            "provider": response.provider,
            "is_mock": response.is_mock,
            "finish_reason": response.finish_reason,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "estimated_cost_usd": response.estimated_cost_usd,
            "request_id": request_id_var.get(),
        }
