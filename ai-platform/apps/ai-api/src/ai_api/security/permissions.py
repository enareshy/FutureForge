"""AI capability -> enterprise permission mapping.

The AI API reuses the enterprise IAM: every capability requires an enterprise
permission code (`<resource>:<action>`). The mapping is configurable so a
deployment can align AI resources with whatever the enterprise IAM seeds. The
defaults below are the recommended resource catalog to seed in the enterprise
IAM (see docs/PHASE6_SECURITY_GOVERNANCE.md).

Overriding: set `AI_PERMISSION_MAP` to a JSON object, e.g.
`{"chat.execute": "ai.chat:execute"}`; only the provided keys are overridden.
"""

from __future__ import annotations

import json

from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError

# Capability codes used across the API.
CAP_CAPABILITIES_READ = "capabilities.read"
CAP_MODELS_READ = "models.read"
CAP_CHAT_EXECUTE = "chat.execute"
CAP_SUMMARIZE_EXECUTE = "summarize.execute"
CAP_KNOWLEDGE_READ = "knowledge.read"
CAP_KNOWLEDGE_WRITE = "knowledge.write"
CAP_KNOWLEDGE_INDEX = "knowledge.index"
CAP_KNOWLEDGE_SECURITY = "knowledge.security"
CAP_USAGE_READ = "usage.read"
CAP_AUDIT_READ = "audit.read"
CAP_AGENTS_READ = "agents.read"
CAP_AGENTS_EXECUTE = "agents.execute"
CAP_AGENTS_MANAGE = "agents.manage"
CAP_AGENT_TOOLS_READ = "agent_tools.read"
CAP_AGENT_TOOLS_MANAGE = "agent_tools.manage"
CAP_AGENT_APPROVALS_READ = "agent_approvals.read"
CAP_AGENT_APPROVALS_DECIDE = "agent_approvals.decide"
CAP_AGENT_EXECUTIONS_MANAGE = "agent_executions.manage"
CAP_RETRIEVAL_SEARCH = "retrieval.search"
CAP_RETRIEVAL_RAG = "retrieval.rag"
CAP_COPILOT_TOOLS_READ = "copilot_tools.read"
CAP_COPILOT_ACTIONS_READ = "copilot_actions.read"
CAP_COPILOT_ACTIONS_DECIDE = "copilot_actions.decide"
CAP_COPILOT_ACTIONS_EXECUTE = "copilot_actions.execute"
CAP_FEEDBACK_WRITE = "feedback.write"
CAP_FEEDBACK_READ = "feedback.read"
CAP_EXPERIMENTS_READ = "experiments.read"
CAP_EXPERIMENTS_WRITE = "experiments.write"
CAP_REGISTRY_READ = "registry.read"
CAP_REGISTRY_WRITE = "registry.write"
CAP_GRAPH_READ = "graph.read"
CAP_GRAPH_WRITE = "graph.write"
CAP_GRAPH_QUERY = "graph.query"
CAP_PRODUCT_READ = "product.read"
CAP_PRODUCT_WRITE = "product.write"
CAP_BOM_READ = "bom.read"
CAP_BOM_WRITE = "bom.write"
CAP_BOM_ANALYZE = "bom.analyze"
CAP_MANUFACTURING_READ = "manufacturing.read"
CAP_MANUFACTURING_WRITE = "manufacturing.write"
CAP_MANUFACTURING_ANALYZE = "manufacturing.analyze"
CAP_QUALITY_READ = "quality.read"
CAP_QUALITY_WRITE = "quality.write"
CAP_QUALITY_ANALYZE = "quality.analyze"
CAP_PREDICTIVE_READ = "predictive.read"
CAP_PREDICTIVE_WRITE = "predictive.write"
CAP_PREDICTIVE_ANALYZE = "predictive.analyze"
CAP_EVALUATIONS_READ = "evaluations.read"
CAP_EVALUATIONS_WRITE = "evaluations.write"

DEFAULT_PERMISSION_MAP: dict[str, str] = {
    CAP_CAPABILITIES_READ: "ai.platform:read",
    CAP_MODELS_READ: "ai.platform:read",
    CAP_CHAT_EXECUTE: "ai.chat:execute",
    CAP_SUMMARIZE_EXECUTE: "ai.chat:execute",
    CAP_KNOWLEDGE_READ: "ai.knowledge:read",
    CAP_KNOWLEDGE_WRITE: "ai.knowledge:create",
    CAP_KNOWLEDGE_INDEX: "ai.knowledge:execute",
    CAP_KNOWLEDGE_SECURITY: "ai.knowledge:update",
    CAP_USAGE_READ: "ai.usage:read",
    CAP_AUDIT_READ: "ai.audit:read",
    CAP_AGENTS_READ: "ai.agents:read",
    CAP_AGENTS_EXECUTE: "ai.agents:execute",
    CAP_AGENTS_MANAGE: "ai.agents:update",
    CAP_AGENT_TOOLS_READ: "ai.agent_tools:read",
    CAP_AGENT_TOOLS_MANAGE: "ai.agent_tools:update",
    CAP_AGENT_APPROVALS_READ: "ai.agent_approvals:read",
    CAP_AGENT_APPROVALS_DECIDE: "ai.agent_approvals:execute",
    CAP_AGENT_EXECUTIONS_MANAGE: "ai.agent_executions:update",
    "platform.draft": "ai.agents:execute",
    CAP_RETRIEVAL_SEARCH: "ai.retrieval:execute",
    CAP_RETRIEVAL_RAG: "ai.retrieval:execute",
    CAP_COPILOT_TOOLS_READ: "ai.copilot_tools:read",
    CAP_COPILOT_ACTIONS_READ: "ai.copilot_actions:read",
    CAP_COPILOT_ACTIONS_DECIDE: "ai.copilot_actions:update",
    CAP_COPILOT_ACTIONS_EXECUTE: "ai.copilot_actions:execute",
    CAP_FEEDBACK_WRITE: "ai.feedback:create",
    CAP_FEEDBACK_READ: "ai.feedback:read",
    CAP_EXPERIMENTS_READ: "ai.ml:read",
    CAP_EXPERIMENTS_WRITE: "ai.ml:create",
    CAP_REGISTRY_READ: "ai.ml:read",
    CAP_REGISTRY_WRITE: "ai.ml:create",
    CAP_GRAPH_READ: "iam.graph.entities:read",
    CAP_GRAPH_WRITE: "iam.graph.entities:update",
    CAP_GRAPH_QUERY: "iam.graph.entities:read",
    CAP_PRODUCT_READ: "iam.pdm.items:read",
    CAP_PRODUCT_WRITE: "iam.pdm.items:update",
    CAP_BOM_READ: "iam.bom.boms:read",
    CAP_BOM_WRITE: "iam.bom.boms:update",
    CAP_BOM_ANALYZE: "iam.bom.compare:read",
    CAP_MANUFACTURING_READ: "iam.manufacturing-quality.manufacturing:read",
    CAP_MANUFACTURING_WRITE: "iam.manufacturing-quality.manufacturing:update",
    CAP_MANUFACTURING_ANALYZE: "iam.manufacturing-quality.manufacturing:read",
    CAP_QUALITY_READ: "iam.manufacturing-quality.quality:read",
    CAP_QUALITY_WRITE: "iam.manufacturing-quality.quality:update",
    CAP_QUALITY_ANALYZE: "iam.manufacturing-quality.quality:read",
    CAP_PREDICTIVE_READ: "iam.predictive-intelligence.predictions:read",
    CAP_PREDICTIVE_WRITE: "iam.predictive-intelligence.predictions:create",
    CAP_PREDICTIVE_ANALYZE: "iam.predictive-intelligence.predictions:read",
    CAP_EVALUATIONS_READ: "ai.ml:read",
    CAP_EVALUATIONS_WRITE: "ai.ml:create",
}


def parse_permission_list(raw: str) -> frozenset[str]:
    return frozenset(part.strip() for part in (raw or "").split(",") if part.strip())


def build_permission_map(settings: Settings) -> dict[str, str]:
    mapping = dict(DEFAULT_PERMISSION_MAP)
    raw = (settings.ai_permission_map or "").strip()
    if not raw:
        return mapping
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigurationError("AI_PERMISSION_MAP is not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ConfigurationError("AI_PERMISSION_MAP must be a JSON object")
    for key, value in parsed.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ConfigurationError("AI_PERMISSION_MAP keys and values must be strings")
        mapping[key] = value
    return mapping
