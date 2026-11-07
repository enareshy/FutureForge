"""Reusable enterprise agent templates (Stage 6 completion).

Templates are declarative, configurable definitions that instantiate a normal
draft agent through the existing registry. They never execute themselves and
never embed credentials or arbitrary code. Each template references existing
tool codes (knowledge search, Copilot enterprise tools) so instantiation reuses
the same allowlist, capability checks and approval controls as hand-built agents.

Templates are seeded lazily per tenant (idempotently) so a fresh tenant gets the
catalogue without a migration, and an operator can disable or override one by
upserting the same code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ai_api.application.ports import AiRepository
from ai_api.application.services.agent_registry_service import (
    AgentRegistryService,
    _find_secret,
)
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.context import require_tenant
from ai_api.domain.errors import (
    ConflictError,
    NotFoundError,
    ValidationError,
)
from ai_api.security.policies import Policy, Principal
from ai_api.telemetry.logging import get_logger

logger = get_logger("agent.templates")

# Tool codes exposed by the Stage 6 registry. Enterprise tool codes mirror the
# Copilot allowlist so the same authorization applies to agents.
TOOL_KNOWLEDGE = "knowledge.search"
TOOL_ENTERPRISE_SEARCH = "enterprise.search"
TOOL_PRODUCT = "product.lookup"
TOOL_BOM = "bom.lookup"
TOOL_QUALITY = "quality.lookup"
TOOL_CHANGE = "change.lookup"
TOOL_PREDICTIVE = "predictive.lookup"
TOOL_PLATFORM_DRAFT = "platform.draft.create"


def _workflow(
    *,
    instructions: str,
    tools: list[str],
    steps: list[dict[str, Any]],
    citation_required: bool = True,
    limits: dict[str, int] | None = None,
) -> dict[str, Any]:
    return {
        "system_instructions": instructions,
        "read_only": True,
        "tools": tools,
        "steps": steps,
        "limits": limits or {"max_steps": 6, "max_tool_calls": 6, "max_elapsed_seconds": 180},
        "retry_policy": {"max_attempts": 2, "backoff_seconds": 2},
        "generation": {"temperature": 0.2, "max_output_tokens": 1200},
        "memory": {"mode": "execution", "ttl_seconds": 3600},
        "output": {"format": "markdown", "citations_required": citation_required},
        "approval_policy": {"require_for_risk": ["controlled_mutation", "consequential"]},
    }


TEMPLATE_DEFINITIONS: list[dict[str, Any]] = [
    {
        "code": "enterprise-knowledge",
        "name": "Enterprise Knowledge Agent",
        "category": "knowledge",
        "use_case": "Grounded question answering with citations",
        "system_tools": [TOOL_KNOWLEDGE],
        "definition": _workflow(
            instructions=(
                "Answer using only authorized knowledge. Cite sources as [n]; "
                "state clearly when evidence is insufficient."
            ),
            tools=[TOOL_KNOWLEDGE],
            steps=[
                {
                    "key": "search",
                    "sequence": 1,
                    "tool": TOOL_KNOWLEDGE,
                    "args": {"query": "{{query}}", "limit": 5},
                    "depends_on": [],
                }
            ],
        ),
    },
    {
        "code": "engineering-assistant",
        "name": "Engineering Assistant Agent",
        "category": "engineering",
        "use_case": "Engineering data search and product references",
        "system_tools": [TOOL_ENTERPRISE_SEARCH, TOOL_PRODUCT],
        "definition": _workflow(
            instructions=(
                "Help engineering users locate parts, items and engineering "
                "records. Report identifiers and lifecycle state only."
            ),
            tools=[TOOL_ENTERPRISE_SEARCH, TOOL_PRODUCT],
            steps=[
                {
                    "key": "search",
                    "sequence": 1,
                    "tool": TOOL_ENTERPRISE_SEARCH,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "product",
                    "sequence": 2,
                    "tool": TOOL_PRODUCT,
                    "args": {"query": "{{query}}"},
                    "depends_on": ["search"],
                },
            ],
        ),
    },
    {
        "code": "product-bom-analysis",
        "name": "Product and BOM Analysis Agent",
        "category": "pdm",
        "use_case": "BOM structure and product composition",
        "system_tools": [TOOL_BOM, TOOL_PRODUCT],
        "definition": _workflow(
            instructions=(
                "Analyze product structure and BOM composition using authorized "
                "records. Summarize hierarchy and revisions; never invent parts."
            ),
            tools=[TOOL_BOM, TOOL_PRODUCT],
            steps=[
                {
                    "key": "bom",
                    "sequence": 1,
                    "tool": TOOL_BOM,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "product",
                    "sequence": 2,
                    "tool": TOOL_PRODUCT,
                    "args": {"query": "{{query}}"},
                    "depends_on": ["bom"],
                },
            ],
        ),
    },
    {
        "code": "manufacturing-process",
        "name": "Manufacturing Process Agent",
        "category": "manufacturing",
        "use_case": "Manufacturing process and routing questions",
        "system_tools": [TOOL_ENTERPRISE_SEARCH, TOOL_BOM],
        "definition": _workflow(
            instructions=(
                "Explain manufacturing process context from authorized records. "
                "Distinguish retrieved facts from interpretation."
            ),
            tools=[TOOL_ENTERPRISE_SEARCH, TOOL_BOM],
            steps=[
                {
                    "key": "search",
                    "sequence": 1,
                    "tool": TOOL_ENTERPRISE_SEARCH,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "bom",
                    "sequence": 2,
                    "tool": TOOL_BOM,
                    "args": {"query": "{{query}}"},
                    "depends_on": ["search"],
                },
            ],
        ),
    },
    {
        "code": "quality-analysis",
        "name": "Quality Analysis Agent",
        "category": "quality",
        "use_case": "Quality issue triage and trend context",
        "system_tools": [TOOL_QUALITY, TOOL_ENTERPRISE_SEARCH],
        "definition": _workflow(
            instructions=(
                "Summarize quality issues and their status from authorized "
                "records. Do not fabricate findings or severity."
            ),
            tools=[TOOL_QUALITY, TOOL_ENTERPRISE_SEARCH],
            steps=[
                {
                    "key": "quality",
                    "sequence": 1,
                    "tool": TOOL_QUALITY,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "search",
                    "sequence": 2,
                    "tool": TOOL_ENTERPRISE_SEARCH,
                    "args": {"query": "{{query}}"},
                    "depends_on": ["quality"],
                },
            ],
        ),
    },
    {
        "code": "change-management",
        "name": "Change Management Agent",
        "category": "change",
        "use_case": "Engineering change request context",
        "system_tools": [TOOL_CHANGE, TOOL_ENTERPRISE_SEARCH],
        "definition": _workflow(
            instructions=(
                "Explain change request state and affected items from authorized "
                "records. Never propose a change without human approval."
            ),
            tools=[TOOL_CHANGE, TOOL_ENTERPRISE_SEARCH],
            steps=[
                {
                    "key": "change",
                    "sequence": 1,
                    "tool": TOOL_CHANGE,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "search",
                    "sequence": 2,
                    "tool": TOOL_ENTERPRISE_SEARCH,
                    "args": {"query": "{{query}}"},
                    "depends_on": ["change"],
                },
            ],
        ),
    },
    {
        "code": "predictive-analysis",
        "name": "Predictive Analysis Agent",
        "category": "predictive",
        "use_case": "Predictive maintenance insight context",
        "system_tools": [TOOL_PREDICTIVE, TOOL_KNOWLEDGE],
        "definition": _workflow(
            instructions=(
                "Summarize predictive findings and their confidence. Clearly "
                "separate model output from retrieved knowledge."
            ),
            tools=[TOOL_PREDICTIVE, TOOL_KNOWLEDGE],
            steps=[
                {
                    "key": "predictive",
                    "sequence": 1,
                    "tool": TOOL_PREDICTIVE,
                    "args": {"query": "{{query}}"},
                    "depends_on": [],
                },
                {
                    "key": "knowledge",
                    "sequence": 2,
                    "tool": TOOL_KNOWLEDGE,
                    "args": {"query": "{{query}}", "limit": 5},
                    "depends_on": ["predictive"],
                },
            ],
        ),
    },
    {
        "code": "document-analysis",
        "name": "Document Analysis Agent",
        "category": "documents",
        "use_case": "Document content analysis with citations",
        "system_tools": [TOOL_KNOWLEDGE],
        "definition": _workflow(
            instructions=(
                "Analyze authorized documents and cite excerpts. Never expose "
                "documents the caller cannot access."
            ),
            tools=[TOOL_KNOWLEDGE],
            steps=[
                {
                    "key": "search",
                    "sequence": 1,
                    "tool": TOOL_KNOWLEDGE,
                    "args": {"query": "{{query}}", "limit": 6},
                    "depends_on": [],
                }
            ],
        ),
    },
]


@dataclass(slots=True)
class AgentTemplateService:
    repository: AiRepository
    registry: AgentRegistryService
    audit: AuditService
    policy: Policy

    async def ensure_templates(self, tenant_id: int) -> list[dict[str, Any]]:
        for template in TEMPLATE_DEFINITIONS:
            existing = await self.repository.list_agent_templates(
                tenant_id,
                category=None,
                enabled=None,
                limit=100,
                offset=0,
            )
            if any(item["code"] == template["code"] for item in existing[0]):
                continue
            await self.repository.upsert_agent_template(
                tenant_id,
                {
                    **template,
                    "enabled": True,
                    "created_by": "system",
                },
            )
        return (
            await self.repository.list_agent_templates(
                tenant_id, category=None, enabled=None, limit=100, offset=0
            )
        )[0]

    async def list(
        self,
        principal: Principal,
        *,
        category: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        tenant_id = require_tenant(principal)
        await self.ensure_templates(tenant_id)
        return await self.repository.list_agent_templates(
            tenant_id, category=category, enabled=True, limit=limit, offset=offset
        )

    async def get(self, principal: Principal, template_id: int) -> dict[str, Any]:
        tenant_id = require_tenant(principal)
        template = await self.repository.get_agent_template(tenant_id, template_id)
        if template is None:
            raise NotFoundError(
                "template not found", details={"template_id": template_id}
            )
        return template

    async def instantiate(self, principal: Principal, template_id: int, payload: Any):
        tenant_id = require_tenant(principal)
        template = await self.get(principal, template_id)
        if not template.get("enabled", True):
            raise ConflictError("template is disabled")
        overrides = dict(payload.overrides or {})
        secret = _find_secret(overrides)
        if secret:
            raise ValidationError(
                "template overrides must not contain credentials",
                details={"field": secret},
            )
        definition = {**dict(template.get("definition") or {}), **overrides}
        from ai_api.schemas.agents import AgentCreateRequest

        create = AgentCreateRequest(
            code=payload.code,
            name=payload.name or template["name"],
            description=template.get("description"),
            kind="workflow",
            category=template.get("category"),
            owner=payload.owner,
            definition=definition,
        )
        agent = await self.registry.create_draft(principal, create)
        await self.audit.record(
            tenant_id=tenant_id,
            actor_id=principal.actor_id,
            action="ai.agent.template.instantiate",
            resource_type="agent",
            resource_id=str(agent["id"]),
            outcome="success",
            detail={"template_id": template_id, "template_code": template["code"]},
        )
        if payload.activate:
            return await self.registry.activate(
                principal,
                agent["id"],
                version_id=None,
                note=f"instantiated from {template['code']}",
            )
        return agent
