from __future__ import annotations

import pytest

from ai_api.application.services.governance_service import GovernanceService
from ai_api.domain.errors import AuthorizationError, RateLimitError, ValidationError
from ai_api.infrastructure.repositories.memory_ai_repository import InMemoryAiRepository
from ai_api.security.policies import Principal

TENANT = 5


def _principal() -> Principal:
    return Principal(user_id="1", username="u", tenant_id=TENANT)


async def test_defaults_allow_when_no_policy_row() -> None:
    service = GovernanceService(repository=InMemoryAiRepository())
    policy = await service.enforce(
        _principal(), operation="chat", model="mock-chat", prompt_text="hello", feature="chat"
    )
    assert policy.max_prompt_chars == 20000


async def test_model_allow_list_is_enforced() -> None:
    repository = InMemoryAiRepository()
    await repository.upsert_governance_policy(TENANT, {"allowed_models": ["mock-chat"]})
    service = GovernanceService(repository=repository)

    with pytest.raises(AuthorizationError):
        await service.enforce(
            _principal(), operation="chat", model="gpt-4o", prompt_text="hi", feature="chat"
        )

    policy = await service.enforce(
        _principal(), operation="chat", model="mock-chat", prompt_text="hi", feature="chat"
    )
    assert policy.model_allowed("mock-chat")


async def test_prompt_length_is_bounded() -> None:
    repository = InMemoryAiRepository()
    await repository.upsert_governance_policy(TENANT, {"max_prompt_chars": 5})
    service = GovernanceService(repository=repository)
    with pytest.raises(ValidationError):
        await service.enforce(
            _principal(),
            operation="chat",
            model="mock-chat",
            prompt_text="too long",
            feature="chat",
        )


async def test_feature_toggle_denies() -> None:
    repository = InMemoryAiRepository()
    await repository.upsert_governance_policy(TENANT, {"features": {"chat": False}})
    service = GovernanceService(repository=repository)
    with pytest.raises(AuthorizationError):
        await service.enforce(
            _principal(), operation="chat", model="mock-chat", prompt_text="hi", feature="chat"
        )


async def test_daily_token_quota_is_enforced() -> None:
    repository = InMemoryAiRepository()
    await repository.upsert_governance_policy(TENANT, {"daily_token_quota": 10})
    await repository.record_usage(TENANT, {"kind": "input", "quantity": 10, "unit": "tokens"})
    service = GovernanceService(repository=repository)
    with pytest.raises(RateLimitError):
        await service.enforce(
            _principal(), operation="chat", model="mock-chat", prompt_text="hi", feature="chat"
        )
