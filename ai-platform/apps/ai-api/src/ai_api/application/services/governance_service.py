from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from ai_api.application.ports import AiRepository
from ai_api.domain.errors import AuthorizationError, RateLimitError, ValidationError
from ai_api.domain.models.governance import GovernancePolicy
from ai_api.security.policies import Principal


@dataclass(slots=True)
class GovernanceService:
    """Evaluates configurable, per-tenant AI usage/retention/feature policy."""

    repository: AiRepository

    async def policy_for(self, tenant_id: int | None) -> GovernancePolicy:
        if tenant_id is None:
            return GovernancePolicy()
        raw = await self.repository.get_governance_policy(tenant_id)
        return GovernancePolicy.from_mapping(raw)

    async def enforce(
        self,
        principal: Principal,
        *,
        operation: str,
        model: str | None,
        prompt_text: str,
        feature: str | None = None,
    ) -> GovernancePolicy:
        policy = await self.policy_for(principal.tenant_id)

        if feature and not policy.feature_enabled(feature):
            raise AuthorizationError(
                "this capability is disabled by policy",
                details={"feature": feature},
            )

        if model and not policy.model_allowed(model):
            raise AuthorizationError(
                "model is not permitted by policy",
                details={"model": model, "allowed_models": list(policy.allowed_models)},
            )

        if len(prompt_text) > policy.max_prompt_chars:
            raise ValidationError(
                "request exceeds the maximum allowed size",
                details={"max_prompt_chars": policy.max_prompt_chars},
            )

        if policy.daily_token_quota > 0 and principal.tenant_id is not None:
            used = await self._tokens_used_today(principal.tenant_id)
            if used >= policy.daily_token_quota:
                raise RateLimitError(
                    "daily token quota exhausted",
                    details={"quota": policy.daily_token_quota, "used": used},
                )

        return policy

    async def _tokens_used_today(self, tenant_id: int) -> int:
        since = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
        summary = await self.repository.usage_summary(tenant_id, since=since)
        try:
            return int(summary.get("quantity", 0) or 0)
        except (TypeError, ValueError):
            return 0
