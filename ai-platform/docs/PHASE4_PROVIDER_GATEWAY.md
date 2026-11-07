# Phase 4 - AI Provider & Model Gateway

Status: complete. A provider abstraction and a reliability-hardened gateway sit
behind `ai_api.application.services.model_gateway.ModelGateway`. Business code
never references a concrete provider; it calls the gateway with a model code.

## What was built

### Domain contracts

- `domain/models/provider.py` - value objects: `Message`, `ModelCapability`,
  `ModelSpec`, `TokenUsage`, `ChatRequest`/`ChatResponse`,
  `EmbeddingRequest`/`EmbeddingResponse`, `ProviderHealth`.
- `domain/ports.py` - `LLMProvider` and `EmbeddingProvider` protocols
  (`generate` / `embed` / `health`).

### Providers (`infrastructure/providers`)

- `mock.py` - deterministic `MockLLMProvider` and `MockEmbeddingProvider`. Every
  response is labelled (`is_mock=True`, `[MOCK]` prefix). Embeddings are stable,
  L2-normalized pseudo-vectors.
- `litellm_adapter.py` - `LiteLLMProvider` using LiteLLM (`acompletion` /
  `aembedding`). The client is imported lazily and injectable, so it is unit
  tested without network calls. Provider exceptions are normalized to
  `ProviderError` and never include credentials.
- `registry.py` - `ProviderRegistry` resolves a model code to a `ModelSpec` and
  its provider, and `build_default_registry` wires the mock provider plus an
  optional LiteLLM provider from configuration.

### Gateway (`application/services/model_gateway.py`)

The gateway enforces, in order:

1. Model resolution and kind check (chat vs embedding).
2. Capability checks (JSON mode support, `max_output_tokens` bounds).
3. Outbound rate limit (`RateLimiter`).
4. Per-provider circuit breaker (`CircuitBreaker`), opened after N consecutive
   failures and half-opened after a cooldown.
5. Timeout (`asyncio.wait_for`, default `LLM_REQUEST_TIMEOUT_SECONDS`).
6. Bounded retries with exponential backoff and jitter (`RetryPolicy`).
7. Token-usage capture and estimated cost when pricing metadata is configured.
8. Structured-output validation (JSON parse, plus optional JSON-schema check).
9. Embedding dimension validation against the model capability.

`health()` returns per-provider availability; `list_models()` returns capability
metadata for the API layer (Phase 5).

### Reliability primitives (`application/reliability.py`)

`RetryPolicy`, `call_with_retry`, `CircuitBreaker`, `RateLimiter`.

## Configuration

All under the `LLM_*` prefix (see `.env.example`). With no key, `LLM_PROVIDER=mock`
keeps V1 fully functional and clearly labelled.

| Setting | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` or a LiteLLM provider code (e.g. `openai`) |
| `LLM_CHAT_MODEL` / `LLM_EMBEDDING_MODEL` | empty | Model codes when a real provider is used |
| `LLM_REQUEST_TIMEOUT_SECONDS` | `30` | Per-call timeout |
| `LLM_MAX_RETRIES` | `3` | Bounded retry attempts |
| `LLM_CIRCUIT_BREAKER_THRESHOLD` / `_RESET_SECONDS` | `5` / `30` | Breaker tuning |
| `LLM_REQUESTS_PER_MINUTE` | `120` | Outbound provider rate limit |
| `LLM_INPUT_COST_PER_1K` / `_OUTPUT_...` | empty | Optional cost metadata |

Secrets: keys are read from configuration/environment and never logged,
returned, or sent to the browser. The gateway only ever sees normalized
responses.

## Usage

```python
from ai_api.domain.models.provider import ChatRequest, Message, Role
from ai_api.api.deps import get_model_gateway

gateway = get_model_gateway()
response = await gateway.chat(
    ChatRequest(messages=(Message(Role.user, "Summarize the design."),), model="mock-chat")
)
# response.is_mock -> True (mock), response.usage, response.estimated_cost_usd
```

FastAPI dependencies `ProviderRegistryDep` and `ModelGatewayDep` are available
in `api/deps.py` for the Phase 5 routes.

## Verification

```
ruff check src tests   -> All checks passed
python3 -m pytest      -> 32 passed
```

Coverage includes: mock labelling/determinism, LiteLLM request mapping and
error normalization (with an injected fake client), unknown model, wrong model
kind, JSON-mode capability gate, `max_output_tokens` gate, invalid structured
output, cost estimation, embedding dimension mismatch, empty/oversized embed
batches, rate limiting, retry recovery, circuit-breaker opening, and
health/model listing.

## Deferred

- Database-backed provider/model registry (currently configuration-driven).
- Streaming and tool-calling passthrough.
- Real provider credential wiring (no credentials exist in this environment).
