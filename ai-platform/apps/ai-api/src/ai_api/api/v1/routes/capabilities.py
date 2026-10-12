from __future__ import annotations

from fastapi import APIRouter, Depends

from ai_api.api.deps import (
    CapabilitiesServiceDep,
    PrincipalDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.schemas.capabilities import CapabilitiesResponse, ModelListResponse, ModelOut
from ai_api.security.permissions import CAP_CAPABILITIES_READ

router = APIRouter(
    tags=["capabilities"],
    dependencies=[Depends(enforce_rate_limit), Depends(require_capability(CAP_CAPABILITIES_READ))],
)


@router.get("/capabilities", response_model=CapabilitiesResponse)
async def capabilities(
    principal: PrincipalDep, service: CapabilitiesServiceDep
) -> CapabilitiesResponse:
    return CapabilitiesResponse(**await service.describe())


@router.get("/models", response_model=ModelListResponse)
async def list_models(
    principal: PrincipalDep, service: CapabilitiesServiceDep
) -> ModelListResponse:
    described = await service.describe()
    return ModelListResponse(items=[ModelOut(**item) for item in described["models"]])
