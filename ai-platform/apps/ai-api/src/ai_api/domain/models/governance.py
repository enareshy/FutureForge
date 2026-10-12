from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class GovernancePolicy:
    """Configurable, per-tenant AI usage/retention/feature policy.

    Empty/zero values mean "unrestricted" for that dimension, except
    `max_prompt_chars` which always has a bounded default.
    """

    allowed_models: tuple[str, ...] = ()
    daily_token_quota: int = 0
    requests_per_minute: int = 0
    max_prompt_chars: int = 20000
    retention_days: int = 90
    data_classification_ceiling: str = "internal"
    block_prompt_injection: bool = False
    features: dict[str, bool] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, raw: dict[str, Any] | None) -> GovernancePolicy:
        data = raw or {}
        return cls(
            allowed_models=tuple(str(m) for m in data.get("allowed_models", [])),
            daily_token_quota=int(data.get("daily_token_quota", 0) or 0),
            requests_per_minute=int(data.get("requests_per_minute", 0) or 0),
            max_prompt_chars=int(data.get("max_prompt_chars", 20000) or 20000),
            retention_days=int(data.get("retention_days", 90) or 0),
            data_classification_ceiling=str(data.get("data_classification_ceiling", "internal")),
            block_prompt_injection=bool(data.get("block_prompt_injection", False)),
            features=dict(data.get("features", {}) or {}),
        )

    def model_allowed(self, model: str) -> bool:
        return not self.allowed_models or model in self.allowed_models

    def feature_enabled(self, code: str, *, default: bool = True) -> bool:
        return bool(self.features.get(code, default))
