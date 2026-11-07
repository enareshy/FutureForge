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
from ai_api.application.services.citation_validation import (
    ANSWER_STATUS_INSUFFICIENT,
    validate_inline_citations,
)
from ai_api.application.services.prompt_security import filter_evidence
from ai_api.application.services.retrieval_service import (
    INSUFFICIENT_EVIDENCE_TEXT,
    RAG_SYSTEM_PROMPT,
)
from ai_api.domain.models.provider import ChatRequest, Message, Role
from ai_api.security.prompt_safety import PromptGuard
from ai_api.telemetry.metrics import record_citation_validation

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
    answer_status: str
    warnings: list[str]
    citations_required: bool
    citation_status: str


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
        guard = PromptGuard(block=ctx.block_prompt_injection)
        safe_ranked, scan = await filter_evidence(
            ctx.audit,
            ctx.principal,
            guard=guard,
            items=ranked,
            feature="agents_execute",
            model=state["model"],
            resource_type="agent",
        )
        if not safe_ranked:
            state["answer"] = INSUFFICIENT_EVIDENCE_TEXT
            state["citations"] = []
            state["insufficient_evidence"] = True
            state["is_mock"] = True
            state["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
            state["answer_status"] = ANSWER_STATUS_INSUFFICIENT
            state["warnings"] = ["insufficient_authorized_evidence"]
            state["citations_required"] = False
            state["citation_status"] = "not_required"
            ctx.record(
                "injection_abstained",
                findings=len(scan.findings),
                filtered=len(ranked),
            )
            return state
        if len(safe_ranked) != len(ranked):
            vector_scores = [
                float(item["vector_score"])
                for item in safe_ranked
                if item.get("vector_score") is not None
            ]
            if not vector_scores:
                vector_scores = [float(item.get("score") or 0.0) for item in safe_ranked]
            state["confidence"] = max(vector_scores, default=0.0)
        context = ctx.retrieval.build_context(safe_ranked)
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
            for index, item in enumerate(safe_ranked, start=1)
        ]
        validation = validate_inline_citations(
            response.content,
            state["citations"],
            required=True,
            evidence=safe_ranked,
        )
        record_citation_validation(operation="agent", status=validation.status)
        warnings = list(validation.warnings)
        if len(safe_ranked) != len(ranked):
            warnings.append("evidence_filtered")
        state["warnings"] = warnings
        state["citations_required"] = validation.required
        state["citation_status"] = validation.status
        state["answer_status"] = validation.answer_status()
        state["usage"] = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "total_tokens": response.usage.total_tokens,
        }
        ctx.record(
            "synthesize",
            model=response.model,
            citations=len(state["citations"]),
            citation_status=validation.status,
            is_mock=response.is_mock,
        )
        return state

    async def insufficient(state: KnowledgeAssistantState) -> KnowledgeAssistantState:
        state["answer"] = INSUFFICIENT_EVIDENCE_TEXT
        state["citations"] = []
        state["insufficient_evidence"] = True
        state["is_mock"] = True
        state["usage"] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        state["answer_status"] = ANSWER_STATUS_INSUFFICIENT
        state["warnings"] = ["insufficient_authorized_evidence"]
        state["citations_required"] = False
        state["citation_status"] = "not_required"
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
