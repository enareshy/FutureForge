"""Enterprise identity bridge (Phase 6).

The AI API does not implement its own authentication. It reuses the enterprise
IAM: an opaque session token is verified against the enterprise backend, which
remains the authoritative source of identity, roles and permissions.

Flow:
1. `GET {ENTERPRISE_API_BASE_URL}/api/auth/me`            -> user + access(roles)
2. `GET {ENTERPRISE_API_BASE_URL}/api/authorization/effective/{userId}` -> permissions

Both calls fail closed: any error, non-active user, or missing token yields an
`AuthenticationError`. Results are cached in-memory for a short TTL, keyed by a
hash of the token (the raw token is never stored).
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

import httpx

from ai_api.config.settings import Settings
from ai_api.domain.errors import AuthenticationError, ConfigurationError
from ai_api.security.policies import Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("identity.enterprise")


@dataclass(frozen=True, slots=True)
class EnterpriseIdentity:
    user_id: int
    username: str
    tenant_id: int | None
    organization_id: int | None
    roles: tuple[str, ...]
    permissions: tuple[str, ...]


class EnterpriseIdentityClient:
    """Thin client over the enterprise IAM session/permission endpoints."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not base_url:
            raise ConfigurationError("ENTERPRISE_API_BASE_URL is required for enterprise identity")
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    async def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
            transport=self._transport,
        )

    async def resolve(self, token: str) -> EnterpriseIdentity:
        if not token:
            raise AuthenticationError("missing bearer token")
        headers = {"Authorization": f"Bearer {token}"}
        try:
            async with await self._client() as client:
                me = await self._get(client, "/api/auth/me", headers)
                user = me.get("user") or {}
                if not user.get("id"):
                    raise AuthenticationError("enterprise identity response missing user")
                if (user.get("status") or "active").lower() != "active":
                    raise AuthenticationError("enterprise user is not active")

                roles = self._roles(me)
                permissions = await self._permissions(client, user["id"], headers)
        except AuthenticationError:
            raise
        except httpx.HTTPError as exc:
            logger.warning("identity.enterprise_unreachable", error=str(exc))
            raise AuthenticationError("enterprise identity service unavailable") from exc
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning("identity.enterprise_bad_payload", error=str(exc))
            raise AuthenticationError("invalid enterprise identity response") from exc

        session = me.get("session") or {}
        tenant = me.get("tenant") or {}
        tenant_id = user.get("tenant_id") or session.get("tenant_id") or tenant.get("id")
        return EnterpriseIdentity(
            user_id=int(user["id"]),
            username=str(user.get("username") or user.get("email") or user["id"]),
            tenant_id=int(tenant_id) if tenant_id is not None else None,
            organization_id=(
                int(user["organization_id"]) if user.get("organization_id") is not None else None
            ),
            roles=roles,
            permissions=permissions,
        )

    async def _get(
        self, client: httpx.AsyncClient, path: str, headers: dict[str, str]
    ) -> dict:
        response = await client.get(path, headers=headers)
        if response.status_code in (401, 403):
            raise AuthenticationError("invalid or expired enterprise session")
        if response.status_code >= 400:
            raise AuthenticationError("enterprise identity request failed")
        return response.json()

    async def _permissions(
        self, client: httpx.AsyncClient, user_id: object, headers: dict[str, str]
    ) -> tuple[str, ...]:
        payload = await self._get(client, f"/api/authorization/effective/{user_id}", headers)
        raw = payload.get("permissions") or []
        codes: list[str] = []
        for entry in raw:
            code = entry.get("code") if isinstance(entry, dict) else entry
            if isinstance(code, str) and code:
                codes.append(code)
        return tuple(sorted(set(codes)))

    @staticmethod
    def _roles(payload: dict) -> tuple[str, ...]:
        access = payload.get("access") or {}
        raw = access.get("roles") or []
        codes: list[str] = []
        for entry in raw:
            if isinstance(entry, dict) and entry.get("code"):
                codes.append(str(entry["code"]))
        return tuple(sorted(set(codes)))


class EnterpriseIdentityProvider:
    """Caches verified enterprise identities for a short TTL."""

    def __init__(self, client: EnterpriseIdentityClient, *, cache_ttl_seconds: int = 30) -> None:
        self._client = client
        self._ttl = max(0, cache_ttl_seconds)
        self._cache: dict[str, tuple[float, Principal]] = {}

    async def resolve(self, token: str) -> Principal:
        if not token:
            raise AuthenticationError("missing bearer token")
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.monotonic()
        cached = self._cache.get(key)
        if cached is not None and cached[0] > now:
            return cached[1]

        identity = await self._client.resolve(token)
        principal = Principal(
            user_id=str(identity.user_id),
            username=identity.username,
            tenant_id=identity.tenant_id,
            organization_id=identity.organization_id,
            actor_id=identity.user_id,
            permissions=frozenset(identity.permissions),
            roles=frozenset(identity.roles),
            auth_source="enterprise",
        )
        if self._ttl:
            self._cache[key] = (now + self._ttl, principal)
        return principal


def build_enterprise_identity_provider(settings: Settings) -> EnterpriseIdentityProvider:
    client = EnterpriseIdentityClient(
        settings.enterprise_api_base_url,
        timeout=settings.enterprise_api_timeout_seconds,
    )
    return EnterpriseIdentityProvider(client, cache_ttl_seconds=settings.identity_cache_ttl_seconds)
