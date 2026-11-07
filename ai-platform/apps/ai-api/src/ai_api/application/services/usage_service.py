from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ai_api.application.ports import AiRepository


@dataclass(slots=True)
class UsageService:
    repository: AiRepository

    async def summary(
        self, tenant_id: int, *, since: datetime | None = None
    ) -> dict[str, Any]:
        return await self.repository.usage_summary(tenant_id, since=since)

    async def list_records(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        return await self.repository.list_usage(tenant_id, limit=limit, offset=offset)
