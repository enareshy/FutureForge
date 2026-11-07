"""Agent registry, lifecycle, immutable versions and validation (Stage 6).

The registry is the authoritative catalog of published agents. Draft
definitions may change; a published version is immutable. Publication requires a
successful validation run, resolvable tool versions and no embedded secrets.
Authorization and ownership are enforced in this service; the API only exposes
the resulting operations.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from ai_api.application.agents.knowledge_assistant import (
    KNOWLEDGE_ASSISTANT_DEFINITION,
    KNOWLEDGE_ASSISTANT_KIND,
)
from ai_api.application.ports import AiRepository
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.application.services.enterprise_tools import builtin_local_tool_seeds
from ai_api.config.settings import Settings
from ai_api.domain.errors import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)
from ai_api.security.policies import Policy, Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("agent.registry")

_CODE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,63}$")
_SECRET_KEY_RE = re.compile(
    r"(api[_-]?key|secret|password|passwd|credential|access[_-]?token|private[_-]?key)",
    re.IGNORECASE,
)
_RISK_CLASSES = (
    "read_only",
    "low_risk_preparation",
    "controlled_mutation",
    "consequential",
    "prohibited",
)
_LIFECYCLE = ("draft", "published", "deprecated", "disabled", "archived")
_VERSION_LIFECYCLE = ("draft", "published", "deprecated", "disabled", "archived")
_MAX_LIMITS = {
    "max_steps": 25,
    "max_model_calls": 20,
    "max_tool_calls": 30,
    "max_elapsed_seconds": 600,
    "max_tokens": 200000,
    "max_retries": 5,
}


_ENTERPRISE_TOOL_SEEDS: list[dict[str, Any]] = [
    {
        "code": "enterprise.search",
        "name": "Enterprise search",
        "description": "Search authorized enterprise objects by free text.",
        "category": "enterprise",
        "capability": "iam.search.global:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "minLength": 1}},
            "required": ["query"],
        },
        "output_schema": {"type": "object"},
    },
    {
        "code": "product.lookup",
        "name": "Product lookup",
        "description": "Look up authorized PDM parts or products.",
        "category": "enterprise",
        "capability": "iam.pdm.items:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        "output_schema": {"type": "object"},
    },
    {
        "code": "bom.lookup",
        "name": "BOM lookup",
        "description": "Look up authorized BOM definitions.",
        "category": "enterprise",
        "capability": "iam.bom.boms:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        "output_schema": {"type": "object"},
    },
    {
        "code": "quality.lookup",
        "name": "Quality lookup",
        "description": "Look up authorized quality issues.",
        "category": "enterprise",
        "capability": "iam.manufacturing-quality.issues:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        "output_schema": {"type": "object"},
    },
    {
        "code": "change.lookup",
        "name": "Change lookup",
        "description": "Look up authorized engineering change requests.",
        "category": "enterprise",
        "capability": "iam.change.requests:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        "output_schema": {"type": "object"},
    },
    {
        "code": "predictive.lookup",
        "name": "Predictive lookup",
        "description": "Look up authorized predictive predictions.",
        "category": "enterprise",
        "capability": "iam.predictive-intelligence.predictions:read",
        "read_only": True,
        "risk_class": "read_only",
        "requires_approval": False,
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
        },
        "output_schema": {"type": "object"},
    },
]


def _hash_config(definition: dict[str, Any]) -> str:
    encoded = json.dumps(definition, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _find_secret(value: Any, path: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            if _SECRET_KEY_RE.search(str(key)) and child not in (None, "", False):
                return f"{path}.{key}".lstrip(".")
            found = _find_secret(child, f"{path}.{key}".lstrip("."))
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = _find_secret(child, f"{path}[{index}]")
            if found:
                return found
    return None


@dataclass(slots=True)
class AgentRegistryService:
    repository: AiRepository
    audit: AuditService
    settings: Settings
    policy: Policy

    # --- Built-ins ------------------------------------------------------

    async def ensure_builtins(self, tenant_id: int) -> dict[str, Any]:
        await self._ensure_tool(
            tenant_id,
            {
                "code": "knowledge.search",
                "name": "Knowledge search",
                "description": "Search the tenant's authorized knowledge base.",
                "category": "knowledge",
                "owner": "platform",
                "capability": "knowledge.read",
                "read_only": True,
                "risk_class": "read_only",
                "requires_approval": False,
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "minLength": 1},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                    },
                    "required": ["query"],
                },
                "output_schema": {"type": "object"},
            },
        )
        for spec in _ENTERPRISE_TOOL_SEEDS:
            await self._ensure_tool(tenant_id, spec)
        for spec in builtin_local_tool_seeds():
            await self._ensure_tool(tenant_id, spec)
        agent = await self.repository.create_agent_if_absent(
            tenant_id,
            {
                "code": self.settings.ai_agent_default_code,
                "name": "Enterprise Knowledge Assistant",
                "description": (
                    "Answers questions from the tenant's authorized knowledge "
                    "base, cites sources, and states when evidence is insufficient."
                ),
                "kind": KNOWLEDGE_ASSISTANT_KIND,
                "config": {"builtin": True},
            },
        )
        await self.repository.create_agent_version_if_absent(
            tenant_id,
            agent["id"],
            {
                "version": self.settings.ai_agent_default_version,
                "definition": KNOWLEDGE_ASSISTANT_DEFINITION,
                "status": "active",
            },
        )
        return agent

    async def _ensure_tool(self, tenant_id: int, data: dict[str, Any]) -> None:
        existing, _ = await self.repository.list_agent_tools(
            tenant_id, query=data["code"], enabled=None, limit=1, offset=0
        )
        if existing and existing[0]["code"] == data["code"]:
            return
        tool = await self.repository.create_agent_tool(
            tenant_id,
            {
                "code": data["code"],
                "name": data["name"],
                "description": data.get("description"),
                "category": data.get("category"),
                "owner": data.get("owner", "platform"),
                "created_by": "system",
            },
        )
        version = await self.repository.create_agent_tool_version(
            tenant_id,
            tool["id"],
            {
                "definition": data,
                "status": "draft",
                "created_by": "system",
            },
        )
        await self.repository.publish_agent_tool_version(
            tenant_id,
            tool["id"],
            version["id"],
            fields={
                "validation": {"valid": True, "errors": [], "warnings": []},
                "config_hash": _hash_config(data),
            },
            updated_by="system",
        )

    # --- Catalog --------------------------------------------------------

    async def list_agents(
        self,
        principal: Principal,
        *,
        query: str | None = None,
        lifecycle_status: str | None = None,
        category: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        await self.ensure_builtins(tenant_id)
        return await self.repository.list_agent_catalog(
            tenant_id,
            query=query,
            lifecycle_status=lifecycle_status,
            category=category,
            limit=limit,
            offset=offset,
        )

    async def get_agent(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.ensure_builtins(tenant_id)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        version = None
        if agent.get("current_version_id"):
            version = await self.repository.get_agent_version(
                tenant_id, agent_id, int(agent["current_version_id"])
            )
        return self._detail(agent, version=version)

    async def list_versions(
        self, principal: Principal, agent_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        versions = await self.repository.list_agent_versions(tenant_id, agent_id)
        return [self._version_out(version) for version in versions]

    async def create_draft(
        self, principal: Principal, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        code = str(payload.code).strip().lower()
        if not _CODE_RE.match(code):
            raise ValidationError(
                "agent code must be 2-64 lowercase characters",
                details={"code": code},
            )
        secret = _find_secret(payload.definition or {})
        if secret:
            raise ValidationError(
                "agent definitions must not contain credentials",
                details={"field": secret},
            )
        owner = payload.owner or principal.username
        agent = await self.repository.create_agent(
            tenant_id,
            {
                "code": code,
                "name": payload.name,
                "description": payload.description,
                "kind": payload.kind,
                "category": payload.category,
                "owner": owner,
                "team": payload.team,
                "lifecycle_status": "draft",
                "created_by": principal.username,
            },
        )
        version = await self.repository.create_agent_version(
            tenant_id,
            agent["id"],
            {
                "definition": payload.definition or {},
                "status": "draft",
                "created_by": principal.username,
            },
        )
        await self._audit(principal, "ai.agent.create", agent["id"], "success", {
            "code": code,
            "version_id": version["id"],
        })
        return self._detail(agent, version=version)

    async def update_draft(
        self, principal: Principal, agent_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self._owned_agent(principal, agent_id)
        if agent.get("lifecycle_status") in ("disabled", "archived"):
            raise ConflictError("agent is not editable", details={"agent_id": agent_id})
        fields = payload.model_dump(exclude_unset=True) if hasattr(payload, "model_dump") else {}
        fields["updated_by"] = principal.username
        updated = await self.repository.update_agent_draft(
            tenant_id,
            agent_id,
            fields,
            expected_lock=int(payload.lock_version),
        )
        if updated is None:
            raise ConflictError("agent was modified by another request")
        version_id = payload.version_id
        if payload.definition is not None:
            secret = _find_secret(payload.definition)
            if secret:
                raise ValidationError(
                    "agent definitions must not contain credentials",
                    details={"field": secret},
                )
            if version_id is None:
                versions = await self.repository.list_agent_versions(
                    tenant_id, agent_id
                )
                draft = next(
                    (
                        item
                        for item in versions
                        if item["status"] in ("draft", "validating")
                    ),
                    None,
                )
                if draft is None:
                    created = await self.repository.create_agent_version(
                        tenant_id,
                        agent_id,
                        {
                            "definition": payload.definition,
                            "status": "draft",
                            "created_by": principal.username,
                        },
                    )
                    version_id = created["id"]
                    version = created
                else:
                    version_id = draft["id"]
                    version = draft
            else:
                version = await self.repository.get_agent_version(
                    tenant_id, agent_id, int(version_id)
                )
                if version is None:
                    raise NotFoundError("agent version not found")
            if payload.version_id is not None:
                updated_version = await self.repository.update_agent_version(
                    tenant_id,
                    agent_id,
                    int(version_id),
                    {"definition": payload.definition, "validation": {}},
                    expected_lock=int(
                        payload.version_lock_version or version["lock_version"]
                    ),
                )
                if updated_version is None:
                    raise ConflictError("agent version was modified by another request")
        await self._audit(principal, "ai.agent.update", agent_id, "success", {
            "version_id": version_id,
        })
        return await self.get_agent(principal, agent_id)

    async def validate_agent(
        self, principal: Principal, agent_id: int, version_id: int | None = None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        version = await self._resolve_version(tenant_id, agent_id, version_id)
        result = await self._validate(tenant_id, agent_id, version)
        await self.repository.update_agent_version(
            tenant_id,
            agent_id,
            version["id"],
            {"validation": result, "status": "validating"},
            expected_lock=int(version["lock_version"]),
        )
        await self._audit(principal, "ai.agent.validate", agent_id, "success", {
            "version_id": version["id"],
            "valid": result["valid"],
            "errors": len(result["errors"]),
        })
        return result

    async def publish(
        self, principal: Principal, agent_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        version = await self._resolve_version(tenant_id, agent_id, payload.version_id)
        result = await self._validate(tenant_id, agent_id, version)
        if not result["valid"]:
            await self._audit(principal, "ai.agent.publish", agent_id, "denied", {
                "version_id": version["id"],
                "errors": result["errors"][:10],
            })
            raise ValidationError(
                "agent validation failed",
                details={"errors": result["errors"]},
            )
        links = await self._tool_links(tenant_id, result["tools"])
        published = await self.repository.publish_agent_version(
            tenant_id,
            agent_id,
            version["id"],
            fields={
                "validation": result,
                "config_hash": result["config_hash"],
            },
            tool_links=links,
            updated_by=principal.username,
        )
        if published is None:
            raise ConflictError("agent version cannot be published")
        await self._audit(principal, "ai.agent.publish", agent_id, "success", {
            "version_id": version["id"],
            "tools": [link["code"] for link in result["tools"]],
        })
        return await self.get_agent(principal, agent_id)

    async def disable(
        self, principal: Principal, agent_id: int, reason: str | None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        updated = await self.repository.set_agent_lifecycle(
            tenant_id,
            agent_id,
            lifecycle_status="disabled",
            enabled=False,
            updated_by=principal.username,
        )
        if updated is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.disable", agent_id, "success", {
            "reason": (reason or "")[:500],
        })
        return self._detail(updated)

    async def rollback(
        self, principal: Principal, agent_id: int, version_id: int
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        updated = await self.repository.set_agent_current_version(
            tenant_id, agent_id, version_id, updated_by=principal.username
        )
        if updated is None:
            raise ValidationError(
                "only a published version can be activated",
                details={"version_id": version_id},
            )
        await self._audit(principal, "ai.agent.rollback", agent_id, "success", {
            "version_id": version_id,
        })
        return self._detail(updated)

    async def activate(
        self,
        principal: Principal,
        agent_id: int,
        *,
        version_id: int | None,
        note: str | None,
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        agent = await self._owned_agent(principal, agent_id)
        version = await self._resolve_activation_version(
            tenant_id, agent_id, version_id, agent
        )
        result = await self._validate(tenant_id, agent_id, version)
        if not result["valid"]:
            await self._audit(principal, "ai.agent.activate", agent_id, "denied", {
                "version_id": version["id"],
                "errors": result["errors"][:10],
            })
            raise ValidationError(
                "agent validation failed", details={"errors": result["errors"]}
            )
        if version.get("status") not in ("published", "active"):
            links = await self._tool_links(tenant_id, result["tools"])
            published = await self.repository.publish_agent_version(
                tenant_id,
                agent_id,
                version["id"],
                fields={"validation": result, "config_hash": result["config_hash"]},
                tool_links=links,
                updated_by=principal.username,
            )
            if published is None:
                raise ConflictError("agent version cannot be activated")
        activated = await self.repository.set_agent_lifecycle(
            tenant_id,
            agent_id,
            lifecycle_status="active",
            enabled=True,
            updated_by=principal.username,
        )
        if activated is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.activate", agent_id, "success", {
            "version_id": version["id"],
            "note": (note or "")[:500],
        })
        return await self.get_agent(principal, agent_id)

    async def deactivate(
        self, principal: Principal, agent_id: int, reason: str | None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        updated = await self.repository.set_agent_lifecycle(
            tenant_id,
            agent_id,
            lifecycle_status="inactive",
            enabled=False,
            updated_by=principal.username,
        )
        if updated is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.deactivate", agent_id, "success", {
            "reason": (reason or "")[:500],
        })
        return self._detail(updated)

    async def suspend(
        self, principal: Principal, agent_id: int, reason: str | None
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        updated = await self.repository.set_agent_lifecycle(
            tenant_id,
            agent_id,
            lifecycle_status="suspended",
            enabled=False,
            updated_by=principal.username,
        )
        if updated is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.suspend", agent_id, "success", {
            "reason": (reason or "")[:500],
        })
        return self._detail(updated)

    async def duplicate(self, principal: Principal, agent_id: int, payload: Any):
        tenant_id = require_tenant(principal)
        self._require_manage(principal)
        source = await self.repository.get_agent(tenant_id, agent_id)
        if source is None or source.get("deleted_at") is not None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        code = str(payload.code).strip().lower()
        if not _CODE_RE.match(code):
            raise ValidationError("agent code must be 2-64 lowercase characters")
        agent = await self.repository.create_agent(
            tenant_id,
            {
                "code": code,
                "name": payload.name or f"{source['name']} (copy)",
                "description": source.get("description"),
                "kind": source.get("kind", "workflow"),
                "category": source.get("category"),
                "owner": principal.username,
                "team": source.get("team"),
                "lifecycle_status": "draft",
                "enabled": False,
                "duplicated_from_agent_id": source["id"],
                "working_config": source.get("working_config") or {},
                "created_by": principal.username,
            },
        )
        versions = await self.repository.list_agent_versions(tenant_id, agent_id)
        current = next(
            (v for v in versions if v["id"] == source.get("current_version_id")),
            None,
        )
        candidates = (
            [current]
            if current
            else [v for v in versions if v["status"] in ("published", "active")]
        )
        if not candidates:
            candidates = versions[:1]
        for version in candidates:
            if version is None:
                continue
            await self.repository.create_agent_version(
                tenant_id,
                agent["id"],
                {
                    "definition": dict(version.get("definition") or {}),
                    "status": "draft",
                    "created_by": principal.username,
                },
            )
        if payload.copy_versions:
            for version in versions:
                if version is candidates[0]:
                    continue
                await self.repository.create_agent_version(
                    tenant_id,
                    agent["id"],
                    {
                        "definition": dict(version.get("definition") or {}),
                        "status": "draft",
                        "created_by": principal.username,
                    },
                )
        await self._audit(principal, "ai.agent.duplicate", agent["id"], "success", {
            "source_agent_id": source["id"],
        })
        return await self.get_agent(principal, agent["id"])

    async def delete(
        self, principal: Principal, agent_id: int, payload: Any
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        if not payload.confirm:
            raise ValidationError("deletion requires confirm=true")
        active = await self.repository.list_agent_executions(
            tenant_id, state=None, agent_id=agent_id, limit=1, offset=0
        )
        if any(
            item.get("status") in ("queued", "running", "waiting_approval")
            for item in active[0]
        ):
            raise ConflictError(
                "agent has active executions; cancel them before deletion"
            )
        deleted = await self.repository.delete_agent(
            tenant_id, agent_id, updated_by=principal.username
        )
        if deleted is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.delete", agent_id, "success", {
            "reason": (getattr(payload, "reason", None) or "")[:500],
        })
        return self._detail(deleted)

    async def update_working_config(
        self, principal: Principal, agent_id: int, working_config: dict[str, Any]
    ) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self._owned_agent(principal, agent_id)
        secret = _find_secret(working_config)
        if secret:
            raise ValidationError(
                "working configuration must not contain credentials",
                details={"field": secret},
            )
        updated = await self.repository.update_agent_working_config(
            tenant_id, agent_id, working_config, updated_by=principal.username
        )
        if updated is None:
            raise NotFoundError("agent not found")
        await self._audit(principal, "ai.agent.working_config", agent_id, "success", {})
        return self._detail(updated)

    async def get_version_tools(
        self, principal: Principal, agent_id: int, version_id: int
    ) -> list[dict[str, Any]]:
        tenant_id = require_tenant(principal)
        await self._owned_or_read(principal, agent_id)
        links = await self.repository.list_agent_version_tools(tenant_id, version_id)
        result = []
        for link in links:
            tool = await self.repository.get_agent_tool(tenant_id, link["tool_id"])
            version = await self.repository.get_agent_tool_version(
                tenant_id, link["tool_id"], link["tool_version_id"]
            )
            result.append(
                {
                    "code": tool["code"] if tool else None,
                    "tool_id": link["tool_id"],
                    "tool_version_id": link["tool_version_id"],
                    "version": version["version"] if version else None,
                    "risk_class": (version or {}).get("definition", {}).get("risk_class"),
                }
            )
        return result

    # --- Validation -----------------------------------------------------

    async def _validate(
        self, tenant_id: int, agent_id: int, version: dict[str, Any]
    ) -> dict[str, Any]:
        definition = dict(version.get("definition") or {})
        errors: list[str] = []
        warnings: list[str] = []
        tools: list[dict[str, Any]] = []
        mode = "legacy"

        if not definition:
            errors.append("definition is empty")
        secret = _find_secret(definition)
        if secret:
            errors.append(f"definition contains a credential-like field: {secret}")

        if definition.get("kind") == KNOWLEDGE_ASSISTANT_KIND:
            tools = await self._validate_legacy_tools(tenant_id, definition, errors, warnings)
        else:
            mode = "workflow"
            tools = await self._validate_workflow(
                tenant_id, agent_id, definition, errors, warnings
            )

        delegated = any(
            isinstance(step, dict) and step.get("delegate_to") is not None
            for step in definition.get("steps") or []
        )
        if not tools and mode == "workflow" and not delegated:
            errors.append("at least one approved tool is required")
        if definition.get("read_only") is False and not any(
            tool.get("risk_class") in ("controlled_mutation", "consequential")
            for tool in tools
        ):
            warnings.append("mutation agent has no controlled mutation tool")

        config_hash = _hash_config(definition)
        return {
            "valid": not errors,
            "errors": errors,
            "warnings": warnings,
            "checks": {
                "definition": bool(definition),
                "secrets": not bool(secret),
                "tools": [tool.get("code") for tool in tools],
                "mode": mode,
            },
            "tools": tools,
            "config_hash": config_hash,
            "agent_version_id": version["id"],
        }

    async def _validate_legacy_tools(
        self,
        tenant_id: int,
        definition: dict[str, Any],
        errors: list[str],
        warnings: list[str],
    ) -> list[dict[str, Any]]:
        if definition.get("read_only") is not True:
            errors.append("legacy agent must be read-only")
        raw_tools = definition.get("tools") or []
        if not isinstance(raw_tools, list) or not raw_tools:
            errors.append("legacy agent must declare at least one tool")
            return []
        tools = []
        for raw in raw_tools:
            code = raw if isinstance(raw, str) else str((raw or {}).get("code") or "")
            resolved = await self._resolve_tool(tenant_id, code, None)
            if resolved is None:
                errors.append(f"tool is not registered or enabled: {code}")
                continue
            tools.append(resolved)
        if len(raw_tools) != len(tools):
            warnings.append("some legacy tools could not be resolved")
        return tools

    async def _validate_workflow(
        self,
        tenant_id: int,
        agent_id: int,
        definition: dict[str, Any],
        errors: list[str],
        warnings: list[str],
    ) -> list[dict[str, Any]]:
        instructions = str(definition.get("system_instructions") or "").strip()
        if not instructions:
            errors.append("system_instructions is required")
        if len(instructions) > 32000:
            errors.append("system_instructions exceeds 32000 characters")
        model = definition.get("model")
        if model is not None and not isinstance(model, str):
            errors.append("model must be a string or null")

        tools = []
        raw_tools = definition.get("tools") or []
        if not isinstance(raw_tools, list):
            errors.append("tools must be a list")
            raw_tools = []
        seen_tools: set[str] = set()
        for raw in raw_tools:
            if isinstance(raw, str):
                code, pinned = raw, None
            elif isinstance(raw, dict):
                code = str(raw.get("code") or "")
                pinned = raw.get("version")
            else:
                errors.append("tool entries must be strings or objects")
                continue
            if code in seen_tools:
                errors.append(f"duplicate tool: {code}")
                continue
            seen_tools.add(code)
            resolved = await self._resolve_tool(tenant_id, code, pinned)
            if resolved is None:
                errors.append(f"tool is not registered, enabled or published: {code}")
                continue
            if resolved["risk_class"] == "prohibited":
                errors.append(f"prohibited tool cannot be allowed: {code}")
                continue
            if resolved["risk_class"] == "consequential" and not definition.get(
                "allow_consequential"
            ):
                errors.append(f"consequential tool requires explicit opt-in: {code}")
                continue
            tools.append(resolved)

        steps = definition.get("steps")
        if steps is None:
            steps = []
        if not isinstance(steps, list):
            errors.append("steps must be a list")
            steps = []
        keys: set[str] = set()
        seen_sequences: set[int] = set()
        for index, step in enumerate(steps):
            if not isinstance(step, dict):
                errors.append(f"step {index} must be an object")
                continue
            key = str(step.get("key") or "").strip()
            if not key or key in keys:
                errors.append(f"step {index} has a missing or duplicate key")
            keys.add(key)
            sequence = step.get("sequence", index + 1)
            if not isinstance(sequence, int) or sequence in seen_sequences:
                errors.append(f"step {key or index} has an invalid sequence")
            seen_sequences.add(sequence if isinstance(sequence, int) else -1)
            delegate_to = step.get("delegate_to")
            if delegate_to is not None:
                if isinstance(delegate_to, bool) or not isinstance(delegate_to, int):
                    errors.append(f"step {key or index} has an invalid delegate_to")
            else:
                tool_code = str(step.get("tool") or "")
                if tool_code not in seen_tools:
                    errors.append(
                        f"step {key or index} uses a tool outside the allowlist"
                    )
            depends_on = step.get("depends_on") or []
            if not isinstance(depends_on, list) or not all(
                isinstance(dep, str) for dep in depends_on
            ):
                errors.append(f"step {key or index} has invalid dependencies")
            elif any(dep not in keys for dep in depends_on):
                errors.append(f"step {key or index} depends on an unknown or later step")

        if len(tools) and not steps:
            warnings.append("no workflow steps; a single tool invocation is assumed")

        limits = definition.get("limits") or {}
        if not isinstance(limits, dict):
            errors.append("limits must be an object")
            limits = {}
        for key, maximum in _MAX_LIMITS.items():
            value = limits.get(key)
            if value is None:
                continue
            if not isinstance(value, int) or value < 0 or value > maximum:
                errors.append(f"limit {key} must be between 0 and {maximum}")

        input_schema = definition.get("input_schema")
        output_schema = definition.get("output_schema")
        for name, schema in (("input_schema", input_schema), ("output_schema", output_schema)):
            if schema is not None and not isinstance(schema, dict):
                errors.append(f"{name} must be an object")

        approval_policy = definition.get("approval_policy") or {}
        if not isinstance(approval_policy, dict):
            errors.append("approval_policy must be an object")
        else:
            for risk in approval_policy.get("require_for_risk") or []:
                if risk not in _RISK_CLASSES:
                    errors.append(f"unknown approval risk class: {risk}")

        self._validate_generation(definition, errors)
        self._validate_knowledge(definition, errors)
        self._validate_memory(definition, errors)
        self._validate_retry(definition, errors)
        self._validate_output(definition, errors)
        self._validate_delegation(
            definition, tools, steps, agent_id=agent_id, errors=errors, warnings=warnings
        )

        if not any(tool["risk_class"] == "read_only" for tool in tools) and not steps:
            warnings.append("agent has no read-only step")
        return tools

    @staticmethod
    def _validate_generation(definition: dict[str, Any], errors: list[str]) -> None:
        generation = definition.get("generation")
        if generation is None:
            return
        if not isinstance(generation, dict):
            errors.append("generation must be an object")
            return
        temperature = generation.get("temperature")
        if temperature is not None and (
            isinstance(temperature, bool)
            or not isinstance(temperature, (int, float))
            or not 0 <= float(temperature) <= 2
        ):
            errors.append("generation.temperature must be between 0 and 2")
        max_tokens = generation.get("max_output_tokens")
        if max_tokens is not None and (
            isinstance(max_tokens, bool)
            or not isinstance(max_tokens, int)
            or not 1 <= max_tokens <= 32000
        ):
            errors.append("generation.max_output_tokens must be between 1 and 32000")

    @staticmethod
    def _validate_knowledge(definition: dict[str, Any], errors: list[str]) -> None:
        knowledge = definition.get("knowledge")
        if knowledge is None:
            return
        if not isinstance(knowledge, dict):
            errors.append("knowledge must be an object")
            return
        sources = knowledge.get("source_ids")
        if sources is not None and (
            not isinstance(sources, list)
            or not all(isinstance(s, int) and s > 0 for s in sources)
        ):
            errors.append("knowledge.source_ids must be a list of positive integers")

    @staticmethod
    def _validate_memory(definition: dict[str, Any], errors: list[str]) -> None:
        memory = definition.get("memory")
        if memory is None:
            return
        if not isinstance(memory, dict):
            errors.append("memory must be an object")
            return
        mode = memory.get("mode")
        if mode is not None and mode not in ("none", "execution", "conversation", "persistent"):
            errors.append("memory.mode must be none, execution, conversation or persistent")
        ttl = memory.get("ttl_seconds")
        if ttl is not None and (
            isinstance(ttl, bool) or not isinstance(ttl, int) or not 0 < ttl <= 31_536_000
        ):
            errors.append("memory.ttl_seconds must be between 1 and 31536000")

    @staticmethod
    def _validate_retry(definition: dict[str, Any], errors: list[str]) -> None:
        retry = definition.get("retry_policy")
        if retry is None:
            return
        if not isinstance(retry, dict):
            errors.append("retry_policy must be an object")
            return
        attempts = retry.get("max_attempts")
        if attempts is not None and (
            isinstance(attempts, bool) or not isinstance(attempts, int) or not 0 <= attempts <= 5
        ):
            errors.append("retry_policy.max_attempts must be between 0 and 5")
        backoff = retry.get("backoff_seconds")
        if backoff is not None and (
            isinstance(backoff, bool)
            or not isinstance(backoff, (int, float))
            or not 0 <= float(backoff) <= 300
        ):
            errors.append("retry_policy.backoff_seconds must be between 0 and 300")

    @staticmethod
    def _validate_output(definition: dict[str, Any], errors: list[str]) -> None:
        output = definition.get("output")
        if output is None:
            return
        if not isinstance(output, dict):
            errors.append("output must be an object")
            return
        fmt = output.get("format")
        if fmt is not None and fmt not in ("text", "markdown", "json"):
            errors.append("output.format must be text, markdown or json")

    def _validate_delegation(
        self,
        definition: dict[str, Any],
        tools: list[dict[str, Any]],
        steps: list[dict[str, Any]],
        *,
        agent_id: int,
        errors: list[str],
        warnings: list[str],
    ) -> None:
        delegation = definition.get("delegation")
        if delegation is None:
            return
        if not isinstance(delegation, dict):
            errors.append("delegation must be an object")
            return
        max_depth = delegation.get("max_depth")
        if max_depth is not None and (
            isinstance(max_depth, bool) or not isinstance(max_depth, int) or not 1 <= max_depth <= 3
        ):
            errors.append("delegation.max_depth must be between 1 and 3")
        children = delegation.get("agents")
        if children is not None:
            if not isinstance(children, list) or not all(
                isinstance(c, int) and c > 0 for c in children
            ):
                errors.append("delegation.agents must be a list of agent ids")
            elif agent_id and any(c == agent_id for c in children):
                errors.append("an agent cannot delegate to itself")
        if delegation.get("enabled") and not delegation.get("agents"):
            warnings.append("delegation enabled without child agents")

    async def _resolve_tool(
        self, tenant_id: int, code: str, pinned: Any
    ) -> dict[str, Any] | None:
        tools, _ = await self.repository.list_agent_tools(
            tenant_id, query=None, enabled=None, limit=200, offset=0
        )
        tool = next((item for item in tools if item["code"] == code), None)
        if tool is None or not tool.get("enabled", True):
            return None
        if tool.get("lifecycle_status") not in ("published", None):
            return None
        versions = await self.repository.list_agent_tool_versions(tenant_id, tool["id"])
        if pinned is not None:
            version = next(
                (item for item in versions if item["version"] == int(pinned)), None
            )
        else:
            version = next(
                (item for item in versions if item["id"] == tool.get("current_version_id")),
                None,
            )
            if version is None:
                version = next(
                    (item for item in versions if item["status"] == "published"), None
                )
        if version is None or version.get("status") != "published":
            return None
        definition = dict(version.get("definition") or {})
        risk = definition.get("risk_class", "read_only")
        return {
            "code": code,
            "tool_id": tool["id"],
            "tool_version_id": version["id"],
            "version": version["version"],
            "capability": definition.get("capability"),
            "read_only": bool(definition.get("read_only", True)),
            "risk_class": risk,
            "requires_approval": bool(definition.get("requires_approval", False)),
        }

    async def _tool_links(
        self, tenant_id: int, tools: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        return [
            {
                "code": tool["code"],
                "tool_id": tool["tool_id"],
                "tool_version_id": tool["tool_version_id"],
            }
            for tool in tools
        ]

    # --- Helpers --------------------------------------------------------

    async def _resolve_activation_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int | None,
        agent: dict[str, Any],
    ) -> dict[str, Any]:
        """Resolve the version to activate.

        An explicit version always wins. Otherwise prefer a pending draft so an
        operator can promote edits, and fall back to the agent's current
        published version when re-activating a previously suspended agent.
        """

        try:
            return await self._resolve_version(tenant_id, agent_id, version_id)
        except ValidationError:
            current = agent.get("current_version_id")
            if current is None:
                raise
            version = await self.repository.get_agent_version(
                tenant_id, agent_id, int(current)
            )
            if version is None:
                raise
            return version

    async def _resolve_version(
        self, tenant_id: int, agent_id: int, version_id: int | None
    ) -> dict[str, Any]:
        if version_id is not None:
            version = await self.repository.get_agent_version(
                tenant_id, agent_id, version_id
            )
            if version is None:
                raise NotFoundError("agent version not found")
            return version
        versions = await self.repository.list_agent_versions(tenant_id, agent_id)
        draft = next(
            (item for item in versions if item["status"] in ("draft", "validating")),
            None,
        )
        if draft is None:
            raise ValidationError("no draft version to validate or publish")
        return draft

    async def _owned_agent(self, principal: Principal, agent_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        await self.ensure_builtins(tenant_id)
        agent = await self.repository.get_agent(tenant_id, agent_id)
        if agent is None:
            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        self._require_manage(principal)
        if not self.policy.is_superuser(principal):
            owner = agent.get("owner")
            if owner and owner != principal.username:
                raise AuthorizationError("only the agent owner may modify it")
        return agent

    async def _owned_or_read(self, principal: Principal, agent_id: int) -> None:
        await self.get_agent(principal, agent_id)

    def _require_manage(self, principal: Principal) -> None:
        self.policy.require(
            principal,
            "ai.agents:update",
            message="not authorized to manage agents",
        )

    def _detail(
        self, agent: dict[str, Any], *, version: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        out = dict(agent)
        out.setdefault("lifecycle_status", "published")
        out.setdefault("enabled", True)
        out["current_version"] = (
            self._version_out(version) if version is not None else None
        )
        return out

    @staticmethod
    def _version_out(version: dict[str, Any]) -> dict[str, Any]:
        out = dict(version)
        out.setdefault("validation", {})
        out.setdefault("lock_version", 1)
        return out

    async def _audit(
        self,
        principal: Principal,
        action: str,
        agent_id: int,
        outcome: str,
        detail: dict[str, Any],
    ) -> None:
        await self.audit.record(
            tenant_id=principal.tenant_id,
            actor_id=principal.actor_id,
            action=action,
            resource_type="agent",
            resource_id=str(agent_id),
            outcome=outcome,
            detail=detail,
        )
