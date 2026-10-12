from __future__ import annotations

from pydantic import BaseModel


class ModelCapabilityOut(BaseModel):
    kind: str
    context_window: int | None = None
    max_output_tokens: int | None = None
    supports_streaming: bool = False
    supports_tools: bool = False
    supports_json_mode: bool = False
    embedding_dimensions: int | None = None


class ModelOut(BaseModel):
    code: str
    provider: str
    is_mock: bool
    capability: ModelCapabilityOut
    input_cost_per_1k: float | None = None
    output_cost_per_1k: float | None = None


class ProviderHealthOut(BaseModel):
    provider: str
    available: bool


class CapabilitiesResponse(BaseModel):
    version: str
    environment: str
    default_chat_model: str
    default_embedding_model: str
    models: list[ModelOut]
    providers: list[ProviderHealthOut]
    features: dict[str, str]


class ModelListResponse(BaseModel):
    items: list[ModelOut]
