"""Agent scheduling (Stage 6 completion).

Schedules enqueue ordinary governed executions through the same repository and
worker infrastructure; they never run an agent directly. Duplicate prevention is
durable:

* a schedule claims the *scheduled instant* by clearing ``next_run_at`` and
  writing ``last_run_key`` in one UPDATE;
* executions carry ``(schedule_id, schedule_run_key)`` under a unique index, so
  a crash between claiming and inserting cannot enqueue the same instant twice.

Cron handling uses ``zoneinfo`` from the standard library; no new dependency is
introduced. Only simple five-field POSIX cron expressions are supported, which
covers the enterprise scheduling use cases in scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ai_api.application.ports import AiRepository
from ai_api.application.services.agent_execution_service import AgentExecutionService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import (
    NotFoundError,
    ValidationError,
)
from ai_api.security.policies import Policy, Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("agent.scheduler")

_MAX_LOOKAHEAD_DAYS = 366


def _field(expr: str, minimum: int, maximum: int) -> set[int]:
    values: set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if not part:
            raise ValidationError("invalid cron expression")
        step = 1
        if "/" in part:
            base, raw_step = part.split("/", 1)
            try:
                step = int(raw_step)
            except ValueError as exc:
                raise ValidationError("invalid cron step") from exc
            if step <= 0:
                raise ValidationError("cron step must be positive")
            part = base or "*"
        if part in ("*", "?"):
            start, end = minimum, maximum
        elif "-" in part:
            raw_start, raw_end = part.split("-", 1)
            try:
                start, end = int(raw_start), int(raw_end)
            except ValueError as exc:
                raise ValidationError("invalid cron range") from exc
        else:
            try:
                start = end = int(part)
            except ValueError as exc:
                raise ValidationError("invalid cron value") from exc
        if start < minimum or end > maximum or start > end:
            raise ValidationError("cron value is out of range")
        values.update(range(start, end + 1, step))
    return values


@dataclass(frozen=True, slots=True)
class CronExpression:
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]

    @classmethod
    def parse(cls, expression: str) -> CronExpression:
        fields = (expression or "").split()
        if len(fields) != 5:
            raise ValidationError("cron must have five fields: m h dom mon dow")
        minutes = _field(fields[0], 0, 59)
        hours = _field(fields[1], 0, 23)
        days = _field(fields[2], 1, 31)
        months = _field(fields[3], 1, 12)
        weekdays = {value % 7 for value in _field(fields[4], 0, 7)}
        return cls(
            minutes=frozenset(minutes),
            hours=frozenset(hours),
            days=frozenset(days),
            months=frozenset(months),
            weekdays=frozenset(weekdays),
        )

    def next_after(self, moment: datetime) -> datetime:
        candidate = moment.astimezone(UTC).replace(second=0, microsecond=0) + timedelta(
            minutes=1
        )
        limit = candidate + timedelta(days=_MAX_LOOKAHEAD_DAYS)
        while candidate < limit:
            if candidate.month not in self.months:
                year = candidate.year + (1 if candidate.month == 12 else 0)
                month = 1 if candidate.month == 12 else candidate.month + 1
                candidate = candidate.replace(
                    year=year, month=month, day=1, hour=0, minute=0
                )
                continue
            if candidate.day not in self.days or (
                candidate.weekday() + 1
            ) % 7 not in self.weekdays:
                candidate = (candidate + timedelta(days=1)).replace(
                    hour=0, minute=0
                )
                continue
            if candidate.hour not in self.hours:
                candidate = (candidate + timedelta(hours=1)).replace(minute=0)
                continue
            if candidate.minute not in self.minutes:
                candidate = candidate + timedelta(minutes=1)
                continue
            return candidate
        raise ValidationError("cron expression has no occurrence in the next year")


@dataclass(slots=True)
class AgentScheduleService:
    repository: AiRepository
    execution_service: AgentExecutionService
    audit: AuditService
    policy: Policy

    async def create(self, principal: Principal, payload: Any) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        agent = await self.repository.get_agent(tenant_id, payload.agent_id)
        if agent is None or agent.get("deleted_at") is not None:
            raise NotFoundError("agent not found")
        if not agent.get("enabled", False):
            raise ValidationError("cannot schedule a disabled agent")
        timezone = self._timezone(payload.timezone)
        if payload.schedule_kind == "recurring":
            if not payload.cron:
                raise ValidationError("recurring schedules require a cron expression")
            cron = CronExpression.parse(payload.cron)
            next_run = cron.next_after(datetime.now(UTC))
        else:
            if payload.run_at is None:
                raise ValidationError("one-time schedules require run_at")
            run_at = (
                payload.run_at.replace(tzinfo=timezone)
                if payload.run_at.tzinfo is None
                else payload.run_at.astimezone(UTC)
            )
            if run_at <= datetime.now(UTC):
                raise ValidationError("run_at must be in the future")
            next_run = run_at.astimezone(UTC)
        schedule = await self.repository.create_agent_schedule(
            tenant_id,
            {
                "agent_id": payload.agent_id,
                "name": payload.name,
                "enabled": payload.enabled,
                "schedule_kind": payload.schedule_kind,
                "cron": payload.cron if payload.schedule_kind == "recurring" else None,
                "run_at": payload.run_at if payload.schedule_kind == "once" else None,
                "timezone": payload.timezone,
                "input": dict(payload.input or {}),
                "input_text": payload.input_text,
                "next_run_at": next_run if payload.enabled else None,
                "created_by": principal.username,
            },
        )
        await self._audit(principal, "ai.agent.schedule.create", schedule["id"], {
            "agent_id": payload.agent_id,
        })
        return schedule

    async def list(
        self,
        principal: Principal,
        *,
        agent_id: int | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_agent_schedules(
            tenant_id, agent_id=agent_id, enabled=enabled, limit=limit, offset=offset
        )

    async def get(self, principal: Principal, schedule_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        schedule = await self.repository.get_agent_schedule(tenant_id, schedule_id)
        if schedule is None:
            raise NotFoundError("schedule not found")
        return schedule

    async def update(
        self, principal: Principal, schedule_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        schedule = await self.get(principal, schedule_id)
        fields = payload.model_dump(exclude_unset=True)
        timezone = self._timezone(fields.get("timezone") or schedule.get("timezone", "UTC"))
        next_run = schedule.get("next_run_at")
        if "cron" in fields and schedule["schedule_kind"] == "recurring":
            next_run = CronExpression.parse(fields["cron"]).next_after(datetime.now(UTC))
        if "run_at" in fields and schedule["schedule_kind"] == "once":
            run_at = fields["run_at"]
            if run_at is not None and run_at.tzinfo is None:
                run_at = run_at.replace(tzinfo=timezone)
            fields["run_at"] = run_at
            next_run = run_at.astimezone(UTC) if run_at else None
        if fields.get("enabled") is True and next_run is None:
            next_run = self._next_recurring(schedule, fields)
        if fields.get("enabled") is False:
            next_run = None
        if next_run is not None:
            fields["next_run_at"] = next_run
        updated = await self.repository.update_agent_schedule(
            tenant_id, schedule_id, fields
        )
        if updated is None:
            raise NotFoundError("schedule not found")
        await self._audit(principal, "ai.agent.schedule.update", schedule_id, {
            "enabled": updated.get("enabled"),
        })
        return updated

    async def delete(self, principal: Principal, schedule_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        await self.get(principal, schedule_id)
        deleted = await self.repository.delete_agent_schedule(tenant_id, schedule_id)
        if not deleted:
            raise NotFoundError("schedule not found")
        await self._audit(principal, "ai.agent.schedule.delete", schedule_id, {})
        return {"id": schedule_id, "deleted": True}

    async def run_due(self, *, limit: int = 20) -> int:
        """Enqueue executions for due schedules. Called by the agent worker."""

        now = datetime.now(UTC)
        claimed = await self.repository.claim_due_schedules(limit=limit, now=now)
        enqueued = 0
        for schedule in claimed:
            tenant_id = int(schedule["tenant_id"])
            run_key = schedule.get("last_run_key")
            try:
                execution = await self._enqueue(schedule, tenant_id, run_key)
            except Exception as exc:  # noqa: BLE001 - one bad schedule must not stop the loop
                logger.warning(
                    "agent.schedule.enqueue_failed",
                    schedule_id=schedule["id"],
                    error=str(exc)[:500],
                )
                await self.repository.update_agent_schedule(
                    tenant_id,
                    int(schedule["id"]),
                    {
                        "last_status": "failed",
                        "failure_count": int(schedule.get("failure_count") or 0) + 1,
                        "next_run_at": self._reschedule(schedule, now),
                    },
                )
                continue
            enqueued += 1
            await self.repository.update_agent_schedule(
                tenant_id,
                int(schedule["id"]),
                {
                    "last_execution_id": execution["id"],
                    "last_status": "queued",
                    "failure_count": 0,
                    "next_run_at": self._reschedule(schedule, now),
                },
            )
        return enqueued

    async def _enqueue(
        self, schedule: dict[str, Any], tenant_id: int, run_key: str | None
    ) -> dict[str, Any]:
        if not run_key:
            raise ValidationError("schedule claim is missing its run key")
        agent = await self.repository.get_agent(tenant_id, int(schedule["agent_id"]))
        if agent is None or not agent.get("enabled", False):
            raise ValidationError("scheduled agent is not active")
        version_id = agent.get("current_version_id")
        if version_id is None:
            raise ValidationError("scheduled agent has no active version")
        version = await self.repository.get_agent_version(
            tenant_id, int(schedule["agent_id"]), int(version_id)
        )
        definition = dict((version or {}).get("definition") or {})
        inputs = dict(schedule.get("input") or {})
        if schedule.get("input_text"):
            inputs.setdefault("text", schedule["input_text"])
            inputs.setdefault("query", schedule["input_text"])
        steps = self.execution_service._plan_steps(definition)
        budgets = self.execution_service._clamp_budgets(definition, {})
        return await self.repository.create_agent_execution(
            tenant_id,
            {
                "actor_id": None,
                "agent_id": int(schedule["agent_id"]),
                "agent_version_id": int(version_id),
                "idempotency_key": f"schedule:{schedule['id']}:{run_key}",
                "status": "queued",
                "plan": {
                    "mode": "workflow",
                    "steps": steps,
                    "warnings": [],
                    "approval_policy": dict(definition.get("approval_policy") or {}),
                    "output_schema": definition.get("output_schema"),
                    "scheduled": True,
                    "schedule_id": int(schedule["id"]),
                    "caller": {
                        "user_id": f"schedule:{schedule['id']}",
                        "username": schedule.get("created_by") or "scheduler",
                        "actor_id": None,
                        "tenant_id": tenant_id,
                        "permissions": ["*:*"],
                    },
                },
                "budgets": budgets,
                "input": inputs,
                "input_snapshot": inputs,
                "schedule_id": int(schedule["id"]),
                "schedule_run_key": run_key,
            },
        )

    @staticmethod
    def _reschedule(schedule: dict[str, Any], now: datetime) -> datetime | None:
        if schedule.get("schedule_kind") != "recurring" or not schedule.get("cron"):
            return None
        try:
            return CronExpression.parse(schedule["cron"]).next_after(now)
        except ValidationError:
            return None

    def _next_recurring(
        self, schedule: dict[str, Any], fields: dict[str, Any]
    ) -> datetime | None:
        cron = fields.get("cron") or schedule.get("cron")
        if not cron:
            return None
        return CronExpression.parse(cron).next_after(datetime.now(UTC))

    @staticmethod
    def _timezone(value: str) -> ZoneInfo:
        try:
            return ZoneInfo(value or "UTC")
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValidationError("unknown timezone") from exc

    def _require_manage(self, principal: Principal) -> None:
        self.policy.require(
            principal,
            "ai.agents:update",
            message="not authorized to manage schedules",
        )

    async def _audit(
        self,
        principal: Principal,
        action: str,
        schedule_id: int,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="agent_schedule",
            resource_id=str(schedule_id),
            outcome="success",
            detail=detail,
        )
