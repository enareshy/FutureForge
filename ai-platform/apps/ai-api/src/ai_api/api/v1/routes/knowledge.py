from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile, status

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
from ai_api.domain.errors import NotFoundError
from ai_api.infrastructure.storage import sanitize_filename
from ai_api.schemas.common import Page, PageMeta
from ai_api.schemas.knowledge import (
    DocumentOut,
    JobOut,
    KnowledgeDocumentIn,
    KnowledgeIndexRequest,
    KnowledgeIngestBody,
    KnowledgeIngestResponse,
    KnowledgeReindexResponse,
    KnowledgeSourceCreate,
    KnowledgeSourceOut,
    KnowledgeUploadResponse,
    UploadedDocumentOut,
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


@router.post(
    "/knowledge/sources/{source_id}/reindex",
    response_model=KnowledgeReindexResponse,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_INDEX))],
)
async def reindex_source(
    source_id: int,
    principal: PrincipalDep,
    ingestion: IngestionServiceDep,
) -> KnowledgeReindexResponse:
    result = await ingestion.reindex_source(principal, source_id)
    return KnowledgeReindexResponse(source_id=source_id, result=result)


@router.post(
    "/knowledge/jobs/{job_id}/retry",
    response_model=JobOut,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_INDEX))],
)
async def retry_job(
    job_id: int,
    principal: PrincipalDep,
    indexing: IndexingServiceDep,
    settings: SettingsDep,
) -> JobOut:
    tenant_id = require_tenant(principal)
    job = await indexing.retry_job(tenant_id, job_id)
    if job is None:
        raise NotFoundError("job not found", details={"job_id": job_id})
    if settings.ai_ingest_inline and job.get("status") == "queued":
        processed = await indexing.process_job(tenant_id, job_id)
        if processed is not None:
            job = processed
    return JobOut(**job)


@router.post(
    "/knowledge/sources/{source_id}/upload",
    response_model=KnowledgeUploadResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_INDEX))],
)
async def upload_document(
    source_id: int,
    principal: PrincipalDep,
    service: KnowledgeServiceDep,
    ingestion: IngestionServiceDep,
    indexing: IndexingServiceDep,
    settings: SettingsDep,
    file: UploadFile = File(...),
) -> KnowledgeUploadResponse:
    limit = settings.ai_upload_max_bytes or -1
    read_size = limit + 1 if limit > 0 else -1
    data = await file.read(read_size)
    descriptor = await service.store_upload(
        principal,
        source_id,
        filename=file.filename,
        content_type=file.content_type,
        data=data,
    )
    if descriptor["deduplicated"]:
        return KnowledgeUploadResponse(document=UploadedDocumentOut(**descriptor))

    body = KnowledgeIngestBody(
        documents=[
            KnowledgeDocumentIn(
                external_id=descriptor["external_id"],
                title=descriptor["title"],
                mime_type=descriptor["mime_type"],
                object_key=descriptor["object_key"],
            )
        ]
    )
    job = await ingestion.enqueue(principal, source_id, body)
    result = None
    if settings.ai_ingest_inline:
        processed = await indexing.process_job(require_tenant(principal), job["id"])
        if processed is not None:
            job = processed
            result = processed.get("result")
    return KnowledgeUploadResponse(
        document=UploadedDocumentOut(**descriptor), job=JobOut(**job), result=result
    )


@router.get(
    "/knowledge/documents/{document_id}/download",
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_READ))],
)
async def download_document(
    document_id: int, principal: PrincipalDep, service: KnowledgeServiceDep
) -> Response:
    document, data = await service.get_document_content(principal, document_id)
    filename = sanitize_filename(document.get("title") or document["external_id"])
    return Response(
        content=data,
        media_type=document.get("mime_type") or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete(
    "/knowledge/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_capability(CAP_KNOWLEDGE_WRITE))],
)
async def delete_document(
    document_id: int, principal: PrincipalDep, service: KnowledgeServiceDep
) -> None:
    await service.delete_document(principal, document_id)
