from __future__ import annotations

from fastapi import APIRouter

from ai_api.api.v1.routes import (
    agent_executions,
    agent_operations,
    agents,
    assistant,
    audit,
    capabilities,
    chat,
    events,
    feedback,
    graph,
    health,
    knowledge,
    manufacturing,
    ml,
    predictive,
    product,
    quality,
    retrieval,
    search,
    usage,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(capabilities.router)
api_router.include_router(chat.router)
api_router.include_router(knowledge.router)
api_router.include_router(assistant.router)
api_router.include_router(retrieval.router)
api_router.include_router(search.router)
api_router.include_router(usage.router)
api_router.include_router(audit.router)
api_router.include_router(agents.router)
api_router.include_router(agent_executions.router)
api_router.include_router(agent_operations.router)
api_router.include_router(graph.router)
api_router.include_router(product.router)
api_router.include_router(manufacturing.router)
api_router.include_router(quality.router)
api_router.include_router(predictive.router)
api_router.include_router(feedback.router)
api_router.include_router(events.router)
api_router.include_router(ml.router)

__all__ = ["api_router"]
