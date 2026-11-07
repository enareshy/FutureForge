"""Agent framework (Phase 9).

A small, typed, read-only-first agent runtime built on LangGraph. The knowledge
assistant is the first concrete agent; the framework provides an allowed-tool
registry, tool-level authorization, execution timeouts, bounded iteration,
human-approval checkpoints, execution traces and error recovery.
"""

from ai_api.application.agents.knowledge_assistant import (
    KNOWLEDGE_ASSISTANT_DEFINITION,
    KNOWLEDGE_ASSISTANT_KIND,
    build_knowledge_assistant_graph,
)
from ai_api.application.agents.runtime import (
    AgentExecutionContext,
    AgentRunResult,
    AgentRuntime,
)
from ai_api.application.agents.tools import (
    KnowledgeSearchTool,
    Tool,
    ToolCallContext,
    ToolRegistry,
    ToolSpec,
    build_default_tools,
)

__all__ = [
    "AgentExecutionContext",
    "AgentRunResult",
    "AgentRuntime",
    "KNOWLEDGE_ASSISTANT_DEFINITION",
    "KNOWLEDGE_ASSISTANT_KIND",
    "KnowledgeSearchTool",
    "Tool",
    "ToolCallContext",
    "ToolRegistry",
    "ToolSpec",
    "build_default_tools",
    "build_knowledge_assistant_graph",
]
