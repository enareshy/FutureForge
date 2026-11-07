from __future__ import annotations

from fastapi import APIRouter

from ai_api.api.deps import HealthServiceDep
from ai_api.schemas.common import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health(service: HealthServiceDep) -> HealthResponse:
    return HealthResponse(**service.check())
