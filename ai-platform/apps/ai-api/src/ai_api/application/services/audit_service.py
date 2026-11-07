from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.telemetry.logging import get_logger

logger = get_logger("audit")


@dataclass(slots=True)
class AuditService:
    """Writes security-sensitive audit events.

    Persistence is best-effort: an audit-store failure must never fail the
    request, but the structured log line is always emitted.
    """

    repository: AiRepository

    async def record(
        self,
        *,
        tenant_id: int | None,
        actor_id: int | None,
        action: str,
        resource_type: str | None = None,
        resource_id: str | None = None,
        outcome: str = "success",
        request_id: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "actor_id": actor_id,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "outcome": outcome,
            "request_id": request_id,
            "detail": detail or {},
        }
        logger.info(
            "audit.event",
            tenant_id=tenant_id,
            action=action,
            outcome=outcome,
            resource_type=resource_type,
            resource_id=resource_id,
            request_id=request_id,
        )
        if tenant_id is None:
            return
        try:
            await self.repository.write_audit(tenant_id, payload)
        except Exception as exc:  # noqa: BLE001 - audit must not break the request
            logger.warning("audit.persist_failed", error=str(exc))

    async def list_events(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        return await self.repository.list_audit(tenant_id, limit=limit, offset=offset)
