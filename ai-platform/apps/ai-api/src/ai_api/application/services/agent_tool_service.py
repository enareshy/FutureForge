"""Persisted tool registry with validation and risk classification (Stage 6).

Tools are typed, versioned service interfaces — never arbitrary code. Only a
published tool version can be attached to an agent, and prohibited or
unapproved consequential tools cannot be published.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from ai_api.schemas.agent_tools import RISK_CLASSES
from ai_api.security.policies import Policy, Principal


def _hash(definition: dict[str, Any]) -> str:
    encoded = json.dumps(definition, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class AgentToolService:
    repository: AiRepository
    audit: AuditService
    policy: Policy

    async def list_tools(
        self,
        principal: Principal,
        *,
        query: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        return await self.repository.list_agent_tools(
            tenant_id,
            query=query,
            enabled=enabled,
            limit=limit,
            offset=offset,
        )

    async def get_tool(
        self, principal: Principal, tool_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        tool = await self.repository.get_agent_tool(tenant_id, tool_id)
        if tool is None:
            raise NotFoundError("tool not found", details={"tool_id": tool_id})
        current = None
        if tool.get("current_version_id"):
            current = await self.repository.get_agent_tool_version(
                tenant_id, tool_id, int(tool["current_version_id"])
            )
        return {**tool, "current_version": current}

    async def list_versions(
        self, principal: Principal, tool_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        if await self.repository.get_agent_tool(tenant_id, tool_id) is None:
            raise NotFoundError("tool not found", details={"tool_id": tool_id})
        return await self.repository.list_agent_tool_versions(tenant_id, tool_id)

    async def create_tool(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        definition = payload.definition.model_dump()
        self._reject_secrets(definition)
        tool = await self.repository.create_agent_tool(
            tenant_id,
            {
                "code": payload.code,
                "name": payload.name,
                "description": payload.description,
                "category": payload.category,
                "owner": payload.owner or principal.username,
                "created_by": principal.username,
            },
        )
        version = await self.repository.create_agent_tool_version(
            tenant_id,
            tool["id"],
            {
                "definition": definition,
                "status": "draft",
                "created_by": principal.username,
            },
        )
        await self._audit(principal, "ai.agent_tool.create", tool["id"], {
            "code": tool["code"],
            "version_id": version["id"],
        })
        return {**tool, "current_version": version}

    async def update_tool(
        self, principal: Principal, tool_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_tool(principal, tool_id)
        updated = await self.repository.update_agent_tool(
            tenant_id,
            tool_id,
            {
                "name": payload.name,
                "description": payload.description,
                "category": payload.category,
                "owner": payload.owner,
                "enabled": payload.enabled,
                "updated_by": principal.username,
            },
            expected_lock=payload.lock_version,
        )
        if updated is None:
            raise ConflictError("tool was modified by another request")
        await self._audit(principal, "ai.agent_tool.update", tool_id, {})
        return await self.get_tool(principal, tool_id)

    async def create_version(
        self, principal: Principal, tool_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_tool(principal, tool_id)
        definition = payload.definition.model_dump()
        self._reject_secrets(definition)
        version = await self.repository.create_agent_tool_version(
            tenant_id,
            tool_id,
            {
                "version": payload.version,
                "definition": definition,
                "status": "draft",
                "created_by": principal.username,
            },
        )
        await self._audit(principal, "ai.agent_tool.version_create", tool_id, {
            "version_id": version["id"],
            "version": version["version"],
        })
        return version

    async def validate(
        self, principal: Principal, tool_id: int, version_id: int | None = None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_tool(principal, tool_id)
        version = await self._resolve_version(tenant_id, tool_id, version_id)
        result = self._validate(version)
        await self.repository.update_agent_tool_version(
            tenant_id,
            tool_id,
            version["id"],
            {
                "status": "validating",
                "validation": result,
                "config_hash": result["config_hash"],
            },
            expected_lock=1,
        )
        return result

    async def publish(
        self, principal: Principal, tool_id: int, version_id: int | None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_tool(principal, tool_id)
        version = await self._resolve_version(tenant_id, tool_id, version_id)
        result = self._validate(version)
        if not result["valid"]:
            raise ValidationError(
                "tool validation failed", details={"errors": result["errors"]}
            )
        published = await self.repository.publish_agent_tool_version(
            tenant_id,
            tool_id,
            version["id"],
            fields={"validation": result, "config_hash": result["config_hash"]},
            updated_by=principal.username,
        )
        if published is None:
            raise ConflictError("tool version cannot be published")
        await self._audit(principal, "ai.agent_tool.publish", tool_id, {
            "version_id": version["id"],
            "risk_class": version["definition"].get("risk_class"),
        })
        return await self.get_tool(principal, tool_id)

    def _validate(self, version: dict[str, Any]) -> dict[str, Any]:
        definition = dict(version.get("definition") or {})
        errors: list[str] = []
        warnings: list[str] = []
        risk = definition.get("risk_class")
        if risk not in RISK_CLASSES:
            errors.append("risk_class is invalid")
        if risk == "prohibited":
            errors.append("prohibited tools cannot be published")
        if not str(definition.get("capability") or "").strip():
            errors.append("capability is required")
        for name in ("input_schema", "output_schema"):
            schema = definition.get(name)
            if not isinstance(schema, dict):
                errors.append(f"{name} must be an object")
        if definition.get("read_only") is False and risk == "read_only":
            errors.append("mutation tool cannot use the read_only risk class")
        if risk in ("controlled_mutation", "consequential"):
            if not definition.get("requires_approval"):
                warnings.append("mutation tool should require approval")
            if definition.get("idempotency") == "none" and risk == "consequential":
                errors.append("consequential tools require idempotency or reconciliation")
        timeout = definition.get("timeout_seconds")
        if not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 600:
            errors.append("timeout_seconds must be between 0 and 600")
        if not str(definition.get("implementation") or "").strip():
            warnings.append("implementation reference is missing")
        return {
            "valid": not errors,
            "errors": errors,
            "warnings": warnings,
            "checks": {
                "risk_class": risk,
                "read_only": definition.get("read_only"),
                "requires_approval": definition.get("requires_approval"),
            },
            "config_hash": _hash(definition),
            "tool_version_id": version["id"],
        }

    async def _resolve_version(
        self, tenant_id: int, tool_id: int, version_id: int | None
    ) -> dict[str, Any]:
        if version_id is not None:
            version = await self.repository.get_agent_tool_version(
                tenant_id, tool_id, version_id
            )
            if version is None:
                raise NotFoundError("tool version not found")
            return version
        versions = await self.repository.list_agent_tool_versions(tenant_id, tool_id)
        draft = next(
            (v for v in versions if v["status"] in ("draft", "validating")), None
        )
        if draft is None:
            raise ValidationError("no draft tool version to validate or publish")
        return draft

    async def _owned_tool(self, principal: Principal, tool_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        tool = await self.repository.get_agent_tool(tenant_id, tool_id)
        if tool is None:
            raise NotFoundError("tool not found", details={"tool_id": tool_id})
        self._require_manage(principal)
        if not self.policy.is_superuser(principal):
            owner = tool.get("owner")
            if owner and owner != principal.username:
                raise AuthorizationError("only the tool owner may modify it")
        return tool

    def _require_manage(self, principal: Principal) -> None:
        self.policy.require(
            principal,
            "ai.agent_tools:update",
            message="not authorized to manage agent tools",
        )

    @staticmethod
    def _reject_secrets(definition: dict[str, Any]) -> None:
        encoded = json.dumps(definition).lower()
        for needle in ("api_key", "apikey", "password", "private_key", "secret"):
            if needle in encoded:
                raise ValidationError(
                    "tool definitions must not contain credentials",
                    details={"field": needle},
                )

    async def _audit(
        self,
        principal: Principal,
        action: str,
        tool_id: int,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="agent_tool",
            resource_id=str(tool_id),
            outcome="success",
            detail=detail,
        )
