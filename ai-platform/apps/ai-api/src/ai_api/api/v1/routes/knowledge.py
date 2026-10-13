from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status

from ai_api.api.deps import (
    IndexingServiceDep,
    IngestionServiceDep,
    KnowledgeServiceDep,
    PaginationDep,
    PrincipalDep,
    SettingsDep,
    enforce_rate_limit,
    require_capability,
)
from ai_api.application.services.knowledge_service import require_tenant
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.knowledge import (
    DocumentOut,
    JobOut,
    KnowledgeIndexRequest,
    KnowledgeIngestBody,
    KnowledgeIngestResponse,
    KnowledgeSourceCreate,
    KnowledgeSourceOut,
)
from ai_api.security.permissions import (
    CAP_KNOWLEDGE_INDEX,
    CAP_KNOWLEDGE_READ,
    CAP_KNOWLEDGE_WRITE,
)

router = APIRouter(tags=["knowledge"], dependencies=[Depends(enforce_rate_limit)])


@router.get(
    "/knowledge/sources",
    response_model=Page[KnowledgeSourceOut],
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_READ))],
)
async def list_sources(
    principal: PrincipalDep, service: KnowledgeServiceDep, pagination: PaginationDep
) -> Page[KnowledgeSourceOut]:
    items, total = await service.list_sources(
        principal, limit=pagination.limit, offset=pagination.offset
    )
    return Page[KnowledgeSourceOut](
        items=[KnowledgeSourceOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.post(
    "/knowledge/sources",
    response_model=KnowledgeSourceOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_WRITE))],
)
async def create_source(
    payload: KnowledgeSourceCreate, principal: PrincipalDep, service: KnowledgeServiceDep
) -> KnowledgeSourceOut:
    return KnowledgeSourceOut(**await service.create_source(principal, payload))


@router.post(
    "/knowledge/index",
    response_model=JobOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_INDEX))],
)
async def request_index(
    payload: KnowledgeIndexRequest, principal: PrincipalDep, service: KnowledgeServiceDep
) -> JobOut:
    return JobOut(**await service.request_index(principal, payload))


@router.get(
    "/knowledge/jobs",
    response_model=Page[JobOut],
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_READ))],
)
async def list_jobs(
    principal: PrincipalDep,
    service: KnowledgeServiceDep,
    pagination: PaginationDep,
    status: str | None = Query(default=None, max_length=32),
) -> Page[JobOut]:
    items, total = await service.list_jobs(
        principal, status=status, limit=pagination.limit, offset=pagination.offset
    )
    return Page[JobOut](
        items=[JobOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.get(
    "/knowledge/jobs/{job_id}",
    response_model=JobOut,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_READ))],
)
async def get_job(
    job_id: int, principal: PrincipalDep, service: KnowledgeServiceDep
) -> JobOut:
    return JobOut(**await service.get_job(principal, job_id))


@router.post(
    "/knowledge/sources/{source_id}/ingest",
    response_model=KnowledgeIngestResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_INDEX))],
)
async def ingest_source(
    source_id: int,
    payload: KnowledgeIngestBody,
    principal: PrincipalDep,
    ingestion: IngestionServiceDep,
    indexing: IndexingServiceDep,
    settings: SettingsDep,
) -> KnowledgeIngestResponse:
    job = await ingestion.enqueue(principal, source_id, payload)
    result = None
    if settings.ai_ingest_inline:
        processed = await indexing.process_job(require_tenant(principal), job["id"])
        if processed is not None:
            job = processed
            result = processed.get("result")
    return KnowledgeIngestResponse(job=JobOut(**job), result=result)


@router.get(
    "/knowledge/sources/{source_id}/documents",
    response_model=Page[DocumentOut],
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_READ))],
)
async def list_documents(
    source_id: int,
    principal: PrincipalDep,
    service: KnowledgeServiceDep,
    pagination: PaginationDep,
) -> Page[DocumentOut]:
    items, total = await service.list_documents(
        principal, source_id, limit=pagination.limit, offset=pagination.offset
    )
    return Page[DocumentOut](
        items=[DocumentOut(**item) for item in items],
        meta=PageMeta(total=total, limit=pagination.limit, offset=pagination.offset),
    )


@router.delete(
    "/knowledge/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_WRITE))],
)
async def delete_source(
    source_id: int, principal: PrincipalDep, service: KnowledgeServiceDep
) -> None:
    await service.delete_source(principal, source_id)
