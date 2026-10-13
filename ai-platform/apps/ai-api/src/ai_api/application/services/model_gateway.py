"""Model gateway.

The single entry point for chat and embedding calls. It resolves the
provider/model, enforces capability checks, applies a rate limit, timeout,
bounded retries and a per-provider circuit breaker, captures token usage and
(where pricing is configured) estimated cost, and validates structured output.

It never knows which concrete provider is behind a model, and it never sees or
emits provider credentials.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from ai_api.application.reliability import (
    CircuitBreaker,
    CircuitOpenError,
    RateLimiter,
    RetryPolicy,
    call_with_retry,
)
from ai_api.config.settings import Settings
from ai_api.domain.errors import ProviderError, RateLimitError, ValidationError
from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    EmbeddingRequest,
    EmbeddingResponse,
    ModelSpec,
    ProviderHealth,
)
from ai_api.infrastructure.providers.registry import ProviderRegistry
from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import get_logger, request_id_var, tenant_id_var, user_id_var
from ai_api.telemetry.metrics import observe_model_call
from ai_api.telemetry.tracing import set_attributes, span

logger = get_logger(__name__)


def _estimate_cost(spec: ModelSpec, input_tokens: int, output_tokens: int) -> float | None:
    if spec.input_cost_per_1k is None and spec.output_cost_per_1k is None:
        return None
    input_cost = (spec.input_cost_per_1k or 0.0) * (input_tokens / 1000.0)
    output_cost = (spec.output_cost_per_1k or 0.0) * (output_tokens / 1000.0)
    return round(input_cost + output_cost, 8)


class ModelGateway:
    def __init__(
        self,
        *,
        registry: ProviderRegistry,
        settings: Settings,
        rate_limiter: RateLimiter | None = None,
        langfuse: LangfusePublisher | None = None,
    ) -> None:
        self._registry = registry
        self._settings = settings
        self._langfuse = langfuse
        self._retry = RetryPolicy(
            attempts=settings.llm_max_retries,
            base_delay_seconds=settings.llm_retry_base_delay_seconds,
            max_delay_seconds=settings.llm_retry_max_delay_seconds,
        )
        self._rate_limiter = rate_limiter or RateLimiter(
            rate_per_minute=settings.llm_requests_per_minute
        )
        self._breakers: dict[str, CircuitBreaker] = {}

    def _breaker(self, provider_code: str) -> CircuitBreaker:
        breaker = self._breakers.get(provider_code)
        if breaker is None:
            breaker = CircuitBreaker(
                provider=provider_code,
                threshold=self._settings.llm_circuit_breaker_threshold,
                reset_seconds=self._settings.llm_circuit_breaker_reset_seconds,
            )
            self._breakers[provider_code] = breaker
        return breaker

    def list_models(self) -> list[ModelSpec]:
        return self._registry.list_models()

    async def health(self) -> list[ProviderHealth]:
        results: list[ProviderHealth] = []
        for code, provider in self._registry.provider_instances().items():
            try:
                available = await provider.health()  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001 - health must never raise
                available = False
            results.append(ProviderHealth(provider=code, available=available))
        return sorted(results, key=lambda item: item.provider)

    def supports_streaming(self, model: str) -> bool:
        """True when the model's provider can stream token chunks (SSE path)."""
        try:
            provider, spec = self._registry.llm(model)
        except Exception:  # noqa: BLE001 - unknown/non-chat models are not streamable
            return False
        return bool(spec.capability.supports_streaming and hasattr(provider, "stream"))

    async def stream_chat(self, request: ChatRequest):
        """Yield content chunks from a streaming-capable chat provider."""
        provider, spec = self._registry.llm(request.model)
        self._validate_chat_request(spec, request)
        if not self.supports_streaming(request.model):
            raise ValidationError(
                "the selected model does not support streaming",
                details={"model": spec.code},
            )
        await self._rate_limiter.acquire()
        started = time.perf_counter()
        outcome = "success"
        try:
            with span(
                "model.chat.stream",
                {
                    "ai.operation": "chat.stream",
                    "ai.provider": spec.provider_code,
                    "ai.model": spec.code,
                },
            ):
                async for chunk in provider.stream(spec, request):  # type: ignore[attr-defined]
                    yield chunk
        except Exception:  # noqa: BLE001 - record then re-raise
            outcome = "error"
            raise
        finally:
            duration = time.perf_counter() - started
            observe_model_call(
                operation="chat.stream",
                provider=spec.provider_code,
                model=spec.code,
                duration_seconds=duration,
                outcome=outcome,
            )
            self._emit_langfuse(spec, operation="chat.stream", duration=duration, outcome=outcome)

    async def chat(self, request: ChatRequest) -> ChatResponse:
        provider, spec = self._registry.llm(request.model)
        self._validate_chat_request(spec, request)
        await self._rate_limiter.acquire()
        started = time.perf_counter()
        outcome = "success"
        input_tokens = output_tokens = 0
        cost: float | None = None
        try:
            with span(
                "model.chat",
                {"ai.operation": "chat", "ai.provider": spec.provider_code, "ai.model": spec.code},
            ) as current:
                response: ChatResponse = await self._invoke(
                    lambda: provider.generate(spec, request),  # type: ignore[attr-defined]
                    provider_code=spec.provider_code,
                    timeout=self._timeout(request.timeout_seconds),
                )
                set_attributes(
                    current,
                    {
                        "ai.finish_reason": response.finish_reason,
                        "ai.usage.input_tokens": response.usage.input_tokens,
                        "ai.usage.output_tokens": response.usage.output_tokens,
                        "ai.mock": response.is_mock,
                    },
                )
            cost = _estimate_cost(spec, response.usage.input_tokens, response.usage.output_tokens)
            response = ChatResponse(
                content=response.content,
                model=response.model,
                provider=response.provider,
                usage=response.usage,
                finish_reason=response.finish_reason,
                estimated_cost_usd=cost,
                is_mock=response.is_mock,
                raw=response.raw,
            )
            input_tokens = response.usage.input_tokens
            output_tokens = response.usage.output_tokens
            self._validate_structured_output(request, response)
            return response
        except Exception:
            outcome = "error"
            raise
        finally:
            duration = time.perf_counter() - started
            observe_model_call(
                operation="chat",
                provider=spec.provider_code,
                model=spec.code,
                duration_seconds=duration,
                outcome=outcome,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
            )
            self._emit_langfuse(
                spec,
                operation="chat",
                duration=duration,
                outcome=outcome,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cost_usd=cost,
            )

    async def embed(self, request: EmbeddingRequest) -> EmbeddingResponse:
        provider, spec = self._registry.embedding(request.model)
        if not request.texts:
            raise ValidationError("embedding request must contain at least one text")
        if len(request.texts) > self._settings.llm_max_embedding_batch:
            raise ValidationError(
                "embedding batch exceeds the configured maximum",
                details={"max": self._settings.llm_max_embedding_batch},
            )
        await self._rate_limiter.acquire()
        started = time.perf_counter()
        outcome = "success"
        input_tokens = 0
        cost: float | None = None
        try:
            with span(
                "model.embed",
                {
                    "ai.operation": "embed",
                    "ai.provider": spec.provider_code,
                    "ai.model": spec.code,
                    "ai.embedding.batch": len(request.texts),
                },
            ):
                response: EmbeddingResponse = await self._invoke(
                    lambda: provider.embed(spec, request),  # type: ignore[attr-defined]
                    provider_code=spec.provider_code,
                    timeout=self._timeout(request.timeout_seconds),
                )
            expected = spec.capability.embedding_dimensions
            if expected is not None and response.dimensions != expected:
                raise ProviderError(
                    "embedding dimensions do not match the model capability",
                    details={"expected": expected, "actual": response.dimensions},
                )
            input_tokens = response.usage.input_tokens
            cost = _estimate_cost(spec, input_tokens, 0)
            return EmbeddingResponse(
                vectors=response.vectors,
                model=response.model,
                provider=response.provider,
                dimensions=response.dimensions,
                usage=response.usage,
                estimated_cost_usd=cost,
                is_mock=response.is_mock,
            )
        except Exception:
            outcome = "error"
            raise
        finally:
            duration = time.perf_counter() - started
            observe_model_call(
                operation="embed",
                provider=spec.provider_code,
                model=spec.code,
                duration_seconds=duration,
                outcome=outcome,
                input_tokens=input_tokens,
                cost_usd=cost,
            )
            self._emit_langfuse(
                spec,
                operation="embed",
                duration=duration,
                outcome=outcome,
                input_tokens=input_tokens,
                cost_usd=cost,
            )

    def _emit_langfuse(
        self,
        spec: ModelSpec,
        *,
        operation: str,
        duration: float,
        outcome: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cost_usd: float | None = None,
    ) -> None:
        if self._langfuse is None or not self._langfuse.enabled:
            return
        self._langfuse.emit_generation(
            model=spec.code,
            provider=spec.provider_code,
            operation=operation,
            latency_ms=int(duration * 1000),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost_usd=cost_usd,
            outcome=outcome,
            request_id=request_id_var.get(),
            tenant_id=tenant_id_var.get(),
            user_id=user_id_var.get(),
        )

    async def _invoke(self, call, *, provider_code: str, timeout: float):  # noqa: ASYNC109
        breaker = self._breaker(provider_code)

        async def _attempt():
            await breaker.before_call()
            try:
                result = await asyncio.wait_for(call(), timeout=timeout)
            except TimeoutError as exc:
                await breaker.record_failure()
                raise ProviderError(
                    "provider call timed out",
                    details={"provider": provider_code},
                ) from exc
            except CircuitOpenError:
                raise
            except RateLimitError:
                raise
            except Exception:
                await breaker.record_failure()
                raise
            await breaker.record_success()
            return result

        return await call_with_retry(
            _attempt,
            policy=self._retry,
            retry_on=(ProviderError, RateLimitError),
        )

    def _timeout(self, requested: float | None) -> float:
        return requested if requested is not None else self._settings.llm_request_timeout_seconds

    @staticmethod
    def _validate_chat_request(spec: ModelSpec, request: ChatRequest) -> None:
        if not request.messages:
            raise ValidationError("chat request must contain at least one message")
        if request.response_format == "json" and not spec.capability.supports_json_mode:
            raise ValidationError(
                "model does not support JSON output mode",
                details={"model": spec.code},
            )
        if (
            request.max_output_tokens is not None
            and spec.capability.max_output_tokens is not None
            and request.max_output_tokens > spec.capability.max_output_tokens
        ):
            raise ValidationError(
                "requested max_output_tokens exceeds the model capability",
                details={"max_output_tokens": spec.capability.max_output_tokens},
            )

    @staticmethod
    def _validate_structured_output(request: ChatRequest, response: ChatResponse) -> None:
        if request.response_format != "json":
            return
        try:
            payload: Any = json.loads(response.content)
        except json.JSONDecodeError as exc:
            raise ProviderError(
                "model returned invalid JSON for a structured response",
                details={"provider": response.provider},
            ) from exc
        if request.json_schema is not None:
            try:
                import jsonschema
            except ImportError:  # pragma: no cover - optional dependency
                return
            try:
                jsonschema.validate(instance=payload, schema=request.json_schema)
            except jsonschema.ValidationError as exc:
                raise ProviderError(
                    "model output does not satisfy the requested JSON schema",
                    details={"provider": response.provider, "reason": exc.message},
                ) from exc
