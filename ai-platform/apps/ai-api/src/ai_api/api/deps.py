from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Query, Request

from ai_api.application.agents.runtime import AgentRuntime
from ai_api.application.ports import (
    AiRepository,
    EventStore,
    ObjectStorage,
    SearchBackend,
    TrackingBackend,
)
from ai_api.application.reliability import RateLimiter
from ai_api.application.services.agent_service import AgentService
from ai_api.application.services.assistant_service import AssistantService
from ai_api.application.services.audit_service import AuditService
from ai_api.application.services.capabilities_service import CapabilitiesService
from ai_api.application.services.chat_service import ChatService
from ai_api.application.services.event_service import EventConsumer, EventPublisher
from ai_api.application.services.feedback_service import FeedbackService
from ai_api.application.services.governance_service import GovernanceService
from ai_api.application.services.health_service import HealthService
from ai_api.application.services.indexing_service import IndexingService
from ai_api.application.services.ingestion_service import IngestionService
from ai_api.application.services.knowledge_service import KnowledgeService
from ai_api.application.services.ml_service import MlService
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.application.services.usage_service import UsageService
from ai_api.config.settings import Settings, get_settings
from ai_api.infrastructure.db import PostgresDatabase
from ai_api.infrastructure.events import KafkaEventSink, build_event_store
from ai_api.infrastructure.ml import build_tracking_backend
from ai_api.infrastructure.providers.registry import ProviderRegistry, build_default_registry
from ai_api.infrastructure.repositories import InMemoryAiRepository, PostgresAiRepository
from ai_api.infrastructure.search import build_search_backend
from ai_api.infrastructure.storage import build_object_storage
from ai_api.security.access_control import AccessControl
from ai_api.security.identity import IdentityProvider, build_identity_provider
from ai_api.security.permissions import build_permission_map, parse_permission_list
from ai_api.security.policies import PermissionMap, Policy, Principal
from ai_api.telemetry.langfuse import LangfusePublisher
from ai_api.telemetry.logging import bind_log_context


@dataclass(slots=True)
class Pagination:
    limit: int
    offset: int


@lru_cache(maxsize=1)
def get_database() -> PostgresDatabase:
    return PostgresDatabase(get_settings())


@lru_cache(maxsize=1)
def get_ai_repository() -> AiRepository:
    settings = get_settings()
    if settings.ai_repository == "memory":
        return InMemoryAiRepository()
    return PostgresAiRepository(get_database())


@lru_cache(maxsize=1)
def get_provider_registry() -> ProviderRegistry:
    return build_default_registry(get_settings())


@lru_cache(maxsize=1)
def get_object_storage() -> ObjectStorage:
    return build_object_storage(get_settings())


def get_search_backend(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
) -> SearchBackend:
    return build_search_backend(get_settings(), repository)


@lru_cache(maxsize=1)
def get_langfuse_publisher() -> LangfusePublisher:
    settings = get_settings()
    return LangfusePublisher(
        host=settings.langfuse_host,
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key,
    )


@lru_cache(maxsize=1)
def get_model_gateway() -> ModelGateway:
    return ModelGateway(
        registry=get_provider_registry(),
        settings=get_settings(),
        langfuse=get_langfuse_publisher(),
    )


@lru_cache(maxsize=1)
def get_identity_provider() -> IdentityProvider:
    return build_identity_provider(get_settings())


def get_policy(settings: SettingsDep) -> Policy:
    return Policy(superuser_permissions=parse_permission_list(settings.ai_admin_permissions))


@lru_cache(maxsize=1)
def get_permission_map() -> PermissionMap:
    return PermissionMap(build_permission_map(get_settings()))


def get_health_service(settings: Annotated[Settings, Depends(get_settings)]) -> HealthService:
    return HealthService(settings=settings)


def get_audit_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
) -> AuditService:
    return AuditService(repository=repository)


def get_capabilities_service(
    gateway: Annotated[ModelGateway, Depends(get_model_gateway)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CapabilitiesService:
    return CapabilitiesService(gateway=gateway, settings=settings)


def get_governance_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
) -> GovernanceService:
    return GovernanceService(repository=repository)


def get_chat_service(
    gateway: Annotated[ModelGateway, Depends(get_model_gateway)],
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    governance: Annotated[GovernanceService, Depends(get_governance_service)],
    settings: Annotated[Settings, Depends(get_settings)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> ChatService:
    return ChatService(
        gateway=gateway,
        repository=repository,
        audit=audit,
        governance=governance,
        settings=settings,
        events=events,
    )


def get_knowledge_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
    settings: Annotated[Settings, Depends(get_settings)],
    storage: Annotated[ObjectStorage, Depends(get_object_storage)],
) -> KnowledgeService:
    return KnowledgeService(
        repository=repository,
        audit=audit,
        settings=settings,
        events=events,
        storage=storage,
    )


def get_usage_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
) -> UsageService:
    return UsageService(repository=repository)


def get_feedback_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
) -> FeedbackService:
    return FeedbackService(repository=repository, audit=audit)


@lru_cache(maxsize=1)
def get_agent_runtime() -> AgentRuntime:
    return AgentRuntime(settings=get_settings())


@lru_cache(maxsize=1)
def get_tracking_backend() -> TrackingBackend:
    return build_tracking_backend(get_settings())


def get_ml_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    tracking: Annotated[TrackingBackend, Depends(get_tracking_backend)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> MlService:
    return MlService(
        repository=repository,
        tracking=tracking,
        audit=audit,
        registration_enabled=settings.ml_enable_registration,
    )


def get_agent_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    gateway: Annotated[ModelGateway, Depends(get_model_gateway)],
    governance: Annotated[GovernanceService, Depends(get_governance_service)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    retrieval: Annotated[RetrievalService, Depends(get_retrieval_service)],
    settings: Annotated[Settings, Depends(get_settings)],
    policy: Annotated[Policy, Depends(get_policy)],
    permissions: Annotated[PermissionMap, Depends(get_permission_map)],
    runtime: Annotated[AgentRuntime, Depends(get_agent_runtime)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> AgentService:
    return AgentService(
        repository=repository,
        gateway=gateway,
        governance=governance,
        audit=audit,
        retrieval=retrieval,
        settings=settings,
        policy=policy,
        permissions=permissions,
        runtime=runtime,
        events=events,
    )


def get_access_control(
    policy: Annotated[Policy, Depends(get_policy)],
) -> AccessControl:
    return AccessControl(policy=policy)


@lru_cache(maxsize=1)
def get_event_store() -> EventStore:
    return build_event_store(get_settings())


@lru_cache(maxsize=1)
def get_event_publisher() -> EventPublisher:
    settings = get_settings()
    sinks: list = [get_event_store()]
    if settings.event_bus_provider == "kafka":
        sinks.append(
            KafkaEventSink(
                settings.ai_event_topic,
                bootstrap_servers=settings.kafka_bootstrap_servers,
            )
        )
    return EventPublisher(sinks=tuple(sinks))


def get_event_consumer() -> EventConsumer:
    settings = get_settings()
    return EventConsumer(
        store=get_event_store(),
        consumer_group=settings.ai_event_consumer_group,
        handlers={},
        max_attempts=settings.ai_event_max_attempts,
        batch_size=settings.ai_event_batch_size,
    )


def get_ingestion_service(
    gateway: Annotated[ModelGateway, Depends(get_model_gateway)],
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    settings: Annotated[Settings, Depends(get_settings)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
    storage: Annotated[ObjectStorage, Depends(get_object_storage)],
    search: Annotated[SearchBackend, Depends(get_search_backend)],
) -> IngestionService:
    return IngestionService(
        repository=repository,
        gateway=gateway,
        audit=audit,
        settings=settings,
        events=events,
        storage=storage,
        search=search,
    )


def get_indexing_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    ingestion: Annotated[IngestionService, Depends(get_ingestion_service)],
    settings: Annotated[Settings, Depends(get_settings)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
) -> IndexingService:
    return IndexingService(
        repository=repository, ingestion=ingestion, settings=settings, events=events
    )


def get_retrieval_service(
    gateway: Annotated[ModelGateway, Depends(get_model_gateway)],
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    access_control: Annotated[AccessControl, Depends(get_access_control)],
    governance: Annotated[GovernanceService, Depends(get_governance_service)],
    settings: Annotated[Settings, Depends(get_settings)],
    events: Annotated[EventPublisher, Depends(get_event_publisher)],
    search: Annotated[SearchBackend, Depends(get_search_backend)],
) -> RetrievalService:
    return RetrievalService(
        gateway=gateway,
        repository=repository,
        audit=audit,
        access=access_control,
        governance=governance,
        settings=settings,
        events=events,
        search_backend=search,
    )


def get_assistant_service(
    repository: Annotated[AiRepository, Depends(get_ai_repository)],
    retrieval: Annotated[RetrievalService, Depends(get_retrieval_service)],
    audit: Annotated[AuditService, Depends(get_audit_service)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> AssistantService:
    return AssistantService(
        repository=repository, retrieval=retrieval, audit=audit, settings=settings
    )


def get_pagination(
    settings: Annotated[Settings, Depends(get_settings)],
    limit: int | None = Query(default=None, ge=1),
    offset: int = Query(default=0, ge=0),
) -> Pagination:
    effective = min(limit or settings.ai_default_page_limit, settings.ai_max_page_limit)
    return Pagination(limit=effective, offset=offset)


def _extract_token(request: Request) -> str:
    header = request.headers.get("authorization")
    if header and header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.headers.get("x-session-token", "").strip()


async def get_principal(
    request: Request,
    provider: Annotated[IdentityProvider, Depends(get_identity_provider)],
) -> Principal:
    principal = await provider.resolve(_extract_token(request))
    bind_log_context(
        tenant_id=principal.tenant_id,
        user_id=principal.user_id,
        auth_source=principal.auth_source,
    )
    return principal


_rate_limiters: dict[str, RateLimiter] = {}
_rate_limit_lock = asyncio.Lock()


async def enforce_rate_limit(
    principal: Annotated[Principal, Depends(get_principal)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    async with _rate_limit_lock:
        limiter = _rate_limiters.get(principal.user_id)
        if limiter is None:
            limiter = RateLimiter(rate_per_minute=settings.ai_rate_limit_per_minute)
            _rate_limiters[principal.user_id] = limiter
    await limiter.acquire()


SettingsDep = Annotated[Settings, Depends(get_settings)]
HealthServiceDep = Annotated[HealthService, Depends(get_health_service)]
ProviderRegistryDep = Annotated[ProviderRegistry, Depends(get_provider_registry)]
ModelGatewayDep = Annotated[ModelGateway, Depends(get_model_gateway)]
AiRepositoryDep = Annotated[AiRepository, Depends(get_ai_repository)]
AuditServiceDep = Annotated[AuditService, Depends(get_audit_service)]
CapabilitiesServiceDep = Annotated[CapabilitiesService, Depends(get_capabilities_service)]
ChatServiceDep = Annotated[ChatService, Depends(get_chat_service)]
KnowledgeServiceDep = Annotated[KnowledgeService, Depends(get_knowledge_service)]
UsageServiceDep = Annotated[UsageService, Depends(get_usage_service)]
FeedbackServiceDep = Annotated[FeedbackService, Depends(get_feedback_service)]
AgentServiceDep = Annotated[AgentService, Depends(get_agent_service)]
MlServiceDep = Annotated[MlService, Depends(get_ml_service)]
GovernanceServiceDep = Annotated[GovernanceService, Depends(get_governance_service)]
RetrievalServiceDep = Annotated[RetrievalService, Depends(get_retrieval_service)]
AssistantServiceDep = Annotated[AssistantService, Depends(get_assistant_service)]
IngestionServiceDep = Annotated[IngestionService, Depends(get_ingestion_service)]
IndexingServiceDep = Annotated[IndexingService, Depends(get_indexing_service)]
ObjectStorageDep = Annotated[ObjectStorage, Depends(get_object_storage)]
SearchBackendDep = Annotated[SearchBackend, Depends(get_search_backend)]
AccessControlDep = Annotated[AccessControl, Depends(get_access_control)]
EventPublisherDep = Annotated[EventPublisher, Depends(get_event_publisher)]
EventConsumerDep = Annotated[EventConsumer, Depends(get_event_consumer)]
EventStoreDep = Annotated[EventStore, Depends(get_event_store)]
PrincipalDep = Annotated[Principal, Depends(get_principal)]
PaginationDep = Annotated[Pagination, Depends(get_pagination)]
PolicyDep = Annotated[Policy, Depends(get_policy)]
PermissionMapDep = Annotated[PermissionMap, Depends(get_permission_map)]


def require_capability(capability: str):
    """FastAPI dependency factory enforcing an enterprise permission.

    Resolves the required enterprise permission for the AI capability from the
    configurable map and fails the request with 403 when the principal lacks it.
    """

    async def _dependency(
        principal: PrincipalDep,
        permissions: PermissionMapDep,
        policy: PolicyDep,
    ) -> Principal:
        policy.require(principal, permissions.permission_for(capability))
        return principal

    return _dependency
