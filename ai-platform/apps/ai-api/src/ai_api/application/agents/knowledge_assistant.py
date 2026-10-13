"""Enterprise Knowledge Assistant — a read-only LangGraph agent (Phase 9).

The graph is deliberately linear and read-only:

    retrieve -> assess -> synthesize (evidence sufficient)
                     \\-> insufficient (no/weak evidence) -> END

It retrieves *authorized* knowledge through the tool registry, synthesizes an
answer with citations, and states explicitly when evidence is insufficient. It
never mutates business objects. Bounded iteration, timeouts, tracing and
cancellation are provided by the runtime and tool registry it is invoked with.
"""

from __future__ import annotations

from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from ai_api.application.agents.tools import TOOL_KNOWLEDGE_SEARCH
from ai_api.application.services.retrieval_service import (
    INSUFFICIENT_EVIDENCE_TEXT,
    RAG_SYSTEM_PROMPT,
)
from ai_api.domain.models.provider import ChatRequest, Message, Role
from ai_api.security.prompt_safety import PromptGuard

KNOWLEDGE_ASSISTANT_KIND = "knowledge_assistant"
KNOWLEDGE_ASSISTANT_CODE = "knowledge-assistant"

# Versioned, typed definition persisted in ai.agent_versions.definition so agent
# behaviour is reproducible and auditable.
KNOWLEDGE_ASSISTANT_DEFINITION: dict[str, Any] = {
    "kind": KNOWLEDGE_ASSISTANT_KIND,
    "framework": "langgraph",
    "graph": "knowledge_assistant",
    "read_only": True,
    "tools": [TOOL_KNOWLEDGE_SEARCH],
    "inputs": {"query": "string"},
    "outputs": {
        "answer": "string",
        "citations": "array",
        "insufficient_evidence": "boolean",
        "confidence": "number",
    },
    "nodes": ["retrieve", "assess", "synthesize", "insufficient"],
    "description": (
        "Answers questions from the tenant's authorized knowledge base and "
        "cites sources; states when evidence is insufficient."
    ),
}


class KnowledgeAssistantState(TypedDict, total=False):
    query: str
    model: str
    limit: int
    route: str
    retrieved: list[dict[str, Any]]
    citations: list[dict[str, Any]]
    answer: str
    insufficient_evidence: bool
    confidence: float
    is_mock: bool
    provider: str
    usage: dict[str, Any]


def build_knowledge_assistant_graph(ctx: Any):
    """Compile the read-only knowledge assistant graph bound to `ctx`.

    `ctx` is an AgentExecutionContext exposing `record`, `call_tool`,
    `retrieval`, `gateway` and `settings` (see runtime.AgentExecutionContext).
    """

    async def retrieve(state: KnowledgeAssistantState) -> KnowledgeAssistantState:
        ctx.record("retrieve", query_length=len(state["query"]))
        outcome = await ctx.call_tool(
            TOOL_KNOWLEDGE_SEARCH,
            {
                "query": state["query"],
                "limit": state.get("limit") or ctx.settings.ai_rag_default_limit,
            },
        )
        state["retrieved"] = outcome["results"]
        state["confidence"] = float(outcome["confidence"])
        return state

    async def assess(state: KnowledgeAssistantState) -> KnowledgeAssistantState:
        retrieved = state.get("retrieved") or []
        best = float(state.get("confidence") or 0.0)
        sufficient = bool(retrieved) and best >= ctx.settings.ai_rag_min_score
        state["insufficient_evidence"] = not sufficient
        state["route"] = "synthesize" if sufficient else "insufficient"
        ctx.record("assess", sufficient=sufficient, confidence=round(best, 6))
        return state

    async def synthesize(state: KnowledgeAssistantState) -> KnowledgeAssistantState:
        ranked = state["retrieved"]
        context = ctx.retrieval.build_context(ranked)
        guard = PromptGuard()
        messages = (
            Message(role=Role.system, content=guard.harden_system_prompt(RAG_SYSTEM_PROMPT)),
            Message(
                role=Role.user,
                content=f"Context:\n{context}\n\nQuestion: {state['query']}",
            ),
        )
        response = await ctx.gateway.chat(
            ChatRequest(messages=messages, model=state["model"], temperature=0.0)
        )
        state["answer"] = response.content
        state["insufficient_evidence"] = False
        state["is_mock"] = response.is_mock
        state["provider"] = response.provider
        state["citations"] = [
            ctx.retrieval.citation(index, item)
            for index, item in enumerate(ranked, start=1)
        ]
        state["usage"] = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.total_tokens,
        }
        ctx.record(
            "synthesize",
            model=response.model,
            citations=len(state["citations"]),
            is_mock=response.is_mock,
        )
        return state

    async def insufficient(state: KnowledgeAssistantState) -> KnowledgeAssistantState:
        state["answer"] = INSUFFICIENT_EVIDENCE_TEXT
        state["citations"] = []
        state["insufficient_evidence"] = True
        state["is_mock"] = True
        state["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        ctx.record("insufficient_evidence")
        return state

    graph = StateGraph(KnowledgeAssistantState)
    graph.add_node("retrieve", retrieve)
    graph.add_node("assess", assess)
    graph.add_node("synthesize", synthesize)
    graph.add_node("insufficient", insufficient)
    graph.set_entry_point("retrieve")
    graph.add_edge("retrieve", "assess")
    graph.add_conditional_edges(
        "assess",
        lambda state: state["route"],
        {"synthesize": "synthesize", "insufficient": "insufficient"},
    )
    graph.add_edge("synthesize", END)
    graph.add_edge("insufficient", END)
    return graph.compile()
