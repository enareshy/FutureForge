from __future__ import annotations

from fastapi import APIRouter

from ai_api.api.v1.routes import (
    agents,
    audit,
    capabilities,
    chat,
    events,
    health,
    knowledge,
    retrieval,
    usage,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(capabilities.router)
api_router.include_router(chat.router)
api_router.include_router(knowledge.router)
api_router.include_router(retrieval.router)
api_router.include_router(usage.router)
api_router.include_router(audit.router)
api_router.include_router(agents.router)
api_router.include_router(events.router)

__all__ = ["api_router"]
