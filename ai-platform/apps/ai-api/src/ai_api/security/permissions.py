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
CAP_USAGE_READ = "usage.read"
CAP_AUDIT_READ = "audit.read"
CAP_AGENTS_READ = "agents.read"
CAP_AGENTS_EXECUTE = "agents.execute"
CAP_RETRIEVAL_SEARCH = "retrieval.search"
CAP_RETRIEVAL_RAG = "retrieval.rag"
CAP_FEEDBACK_WRITE = "feedback.write"
CAP_FEEDBACK_READ = "feedback.read"
CAP_EXPERIMENTS_READ = "experiments.read"
CAP_EXPERIMENTS_WRITE = "experiments.write"
CAP_REGISTRY_READ = "registry.read"
CAP_REGISTRY_WRITE = "registry.write"
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
    CAP_USAGE_READ: "ai.usage:read",
    CAP_AUDIT_READ: "ai.audit:read",
    CAP_AGENTS_READ: "ai.agents:read",
    CAP_AGENTS_EXECUTE: "ai.agents:execute",
    CAP_RETRIEVAL_SEARCH: "ai.retrieval:execute",
    CAP_RETRIEVAL_RAG: "ai.retrieval:execute",
    CAP_FEEDBACK_WRITE: "ai.feedback:create",
    CAP_FEEDBACK_READ: "ai.feedback:read",
    CAP_EXPERIMENTS_READ: "ai.ml:read",
    CAP_EXPERIMENTS_WRITE: "ai.ml:create",
    CAP_REGISTRY_READ: "ai.ml:read",
    CAP_REGISTRY_WRITE: "ai.ml:create",
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
