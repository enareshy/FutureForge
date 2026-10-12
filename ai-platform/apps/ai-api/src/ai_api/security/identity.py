"""Identity resolution.

The AI API never trusts the browser. A bearer session token is exchanged for a
`Principal` by an `IdentityProvider`. In production this is the enterprise
session-verification bridge (wired in Phase 6); until it is configured the API
fails closed. In non-production a clearly-labelled development provider is used.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from ai_api.config.settings import Settings
from ai_api.domain.errors import AuthenticationError, ConfigurationError
from ai_api.security.policies import Principal


@runtime_checkable
class IdentityProvider(Protocol):
    async def resolve(self, token: str) -> Principal: ...


class DevelopmentIdentityProvider:
    """Development-only provider.

    Accepts any non-empty bearer token and returns a privileged principal bound
    to the configured development tenant. Never used in production.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def resolve(self, token: str) -> Principal:
        if not token:
            raise AuthenticationError("missing bearer token")
        permissions = frozenset(
            part.strip()
            for part in self._settings.ai_dev_permissions.split(",")
            if part.strip()
        )
        return Principal(
            user_id="dev-user",
            username="dev-user",
            tenant_id=self._settings.ai_dev_tenant_id,
            permissions=permissions,
            auth_source="development",
        )


class UnavailableIdentityProvider:
    """Fail-closed placeholder used until the enterprise bridge is configured."""

    async def resolve(self, token: str) -> Principal:
        raise ConfigurationError(
            "no identity provider is configured; enterprise session verification is required",
            details={"hint": "configure the enterprise identity bridge (Phase 6)"},
        )


def build_identity_provider(settings: Settings) -> IdentityProvider:
    """Select the identity provider.

    - `enterprise`: verify the session against the enterprise IAM (fail closed).
    - `development`: development-only privileged principal (never in production).
    - `auto`: enterprise in production, development otherwise.
    """
    mode = settings.identity_provider.strip().lower()
    if mode == "development":
        if settings.is_production:
            raise ConfigurationError(
                "the development identity provider is not allowed in production"
            )
        return DevelopmentIdentityProvider(settings)
    if mode == "enterprise":
        from ai_api.security.enterprise_identity import build_enterprise_identity_provider

        return build_enterprise_identity_provider(settings)
    if mode not in ("auto", ""):
        raise ConfigurationError(f"unknown identity provider: {mode}")
    if settings.is_production:
        from ai_api.security.enterprise_identity import build_enterprise_identity_provider

        return build_enterprise_identity_provider(settings)
    return DevelopmentIdentityProvider(settings)
