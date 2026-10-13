"""Application ports (interfaces implemented by infrastructure).

Kept framework-free so services depend on abstractions, and tests can inject
in-memory implementations.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class AiRepository(Protocol):
    """Persistence boundary for the `ai` schema."""

    async def list_knowledge_sources(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def create_knowledge_source(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def get_knowledge_source(
        self, tenant_id: int, source_id: int
    ) -> dict[str, Any] | None: ...

    async def create_job(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def get_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None: ...

    async def record_execution(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]: ...

    async def record_usage(self, tenant_id: int, data: dict[str, Any]) -> None: ...

    async def usage_summary(self, tenant_id: int, *, since: datetime | None) -> dict[str, Any]: ...

    async def list_usage(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def write_audit(self, tenant_id: int, data: dict[str, Any]) -> None: ...

    async def list_audit(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def list_agents(self, tenant_id: int) -> list[dict[str, Any]]: ...

    async def get_agent(self, tenant_id: int, agent_id: int) -> dict[str, Any] | None: ...

    # --- Agent framework (Phase 9) --------------------------------------
    async def create_agent_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def create_agent_version_if_absent(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_agent_versions(
        self, tenant_id: int, agent_id: int
    ) -> list[dict[str, Any]]: ...

    async def get_active_agent_version(
        self, tenant_id: int, agent_id: int
    ) -> dict[str, Any] | None: ...

    async def list_executions(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        operation: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None: ...

    # --- Feedback (Phase 10) --------------------------------------------
    async def record_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_feedback(
        self,
        tenant_id: int,
        *,
        execution_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    # --- ML experiment tracking and model registry (Phase 11) ------------
    async def create_experiment_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_experiments(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_experiment(
        self, tenant_id: int, experiment_id: int
    ) -> dict[str, Any] | None: ...

    async def update_experiment_tracking(
        self,
        tenant_id: int,
        experiment_id: int,
        *,
        tracking_backend: str,
        external_experiment_id: str | None,
    ) -> dict[str, Any] | None: ...

    async def create_experiment_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_experiment_runs(
        self,
        tenant_id: int,
        *,
        experiment_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_experiment_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None: ...

    async def update_experiment_run(
        self, tenant_id: int, run_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def create_ml_model_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_ml_models(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_ml_model(self, tenant_id: int, model_id: int) -> dict[str, Any] | None: ...

    async def set_ml_model_stage(
        self, tenant_id: int, model_id: int, stage: str
    ) -> dict[str, Any] | None: ...

    async def create_ml_model_version(
        self, tenant_id: int, model_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_ml_model_versions(
        self, tenant_id: int, model_id: int
    ) -> list[dict[str, Any]]: ...

    async def get_ml_model_version(
        self, tenant_id: int, model_id: int, version: int
    ) -> dict[str, Any] | None: ...

    async def update_ml_model_version(
        self, tenant_id: int, model_id: int, version: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    # --- Evaluation definitions and results (Phase 11) -------------------
    async def create_evaluation_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_evaluations(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_evaluation(
        self, tenant_id: int, evaluation_id: int
    ) -> dict[str, Any] | None: ...

    async def record_evaluation_result(
        self, tenant_id: int, evaluation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_evaluation_results(
        self, tenant_id: int, evaluation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_governance_policy(self, tenant_id: int) -> dict[str, Any] | None: ...

    async def upsert_governance_policy(
        self, tenant_id: int, policy: dict[str, Any]
    ) -> dict[str, Any]: ...

    # --- Knowledge ingestion / retrieval (Phase 7) ----------------------
    async def create_or_replace_document(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def add_chunks(
        self, tenant_id: int, document_id: int, chunks: list[dict[str, Any]]
    ) -> list[dict[str, Any]]: ...

    async def add_embeddings(self, tenant_id: int, rows: list[dict[str, Any]]) -> int: ...

    async def vector_search(
        self, tenant_id: int, embedding: list[float], *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def lexical_search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def list_documents(
        self, tenant_id: int, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_document(
        self, tenant_id: int, document_id: int
    ) -> dict[str, Any] | None: ...

    async def find_document_by_checksum(
        self, tenant_id: int, checksum: str
    ) -> dict[str, Any] | None: ...

    async def set_document_search_state(
        self,
        tenant_id: int,
        document_id: int,
        *,
        search_indexed_at: datetime | None,
        status: str | None = None,
        error_class: str | None = None,
    ) -> None: ...

    async def set_source_status(self, tenant_id: int, source_id: int, status: str) -> None: ...

    async def update_job(
        self, tenant_id: int, job_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def list_jobs_by_status(
        self, status: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def list_jobs(
        self, tenant_id: int, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def delete_source(self, tenant_id: int, source_id: int) -> bool: ...

    async def delete_document(self, tenant_id: int, document_id: int) -> bool: ...

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]: ...

    # --- Assistant conversations (Stage 3) ------------------------------
    async def create_conversation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_conversations(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_conversation(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None: ...

    async def delete_conversation(
        self, tenant_id: int, conversation_id: int
    ) -> bool: ...

    async def touch_conversation(self, tenant_id: int, conversation_id: int) -> None: ...

    async def add_message(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def add_message_sources(
        self, tenant_id: int, message_id: int, sources: list[dict[str, Any]]
    ) -> None: ...

    async def get_message_sources(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]: ...

    async def get_message(
        self, tenant_id: int, message_id: int
    ) -> dict[str, Any] | None: ...


@runtime_checkable
class ObjectStorage(Protocol):
    """Opaque object storage for original uploaded documents.

    Keys are opaque and never exposed to clients; originals are never served
    through public object-store URLs. `backend` is a short label used by health
    checks. Implementations must fail closed (raise) when unavailable rather
    than silently dropping data.
    """

    backend: str

    async def put(self, key: str, data: bytes, *, content_type: str) -> None: ...

    async def get(self, key: str) -> bytes | None: ...

    async def delete(self, key: str) -> None: ...

    async def exists(self, key: str) -> bool: ...

    async def status(self) -> dict[str, Any]: ...


@runtime_checkable
class SearchBackend(Protocol):
    """Full-text search backend for knowledge chunks (Stage 3).

    ``search`` returns the same candidate shape as ``AiRepository.vector_search``
    (chunk_id, document_id, chunk_index, content, classification, acl, page,
    section, source_id, source_code, source_name, score) so vector and lexical
    candidates can be fused before authorization. Implementations that require an
    external service must fail closed (raise) rather than silently returning an
    empty result, and must never expose internal endpoints/credentials.
    """

    name: str

    async def search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def index_document(
        self,
        tenant_id: int,
        document: dict[str, Any],
        chunks: list[dict[str, Any]],
    ) -> None: ...

    async def delete_document(self, tenant_id: int, document_id: int) -> None: ...

    async def status(self) -> dict[str, Any]: ...


@runtime_checkable
class EventSink(Protocol):
    """A destination an event is written to (outbox store and/or Kafka)."""

    async def publish(self, records: list[dict[str, Any]]) -> None: ...


@runtime_checkable
class EventStore(Protocol):
    """Durable event log plus per-consumer-group delivery tracking."""

    async def publish(self, records: list[dict[str, Any]]) -> None: ...

    async def list_undelivered(
        self, consumer_group: str, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None: ...

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
    ) -> str: ...

    async def list_events(self, *, limit: int) -> list[dict[str, Any]]: ...

    async def get_event(self, event_id: str) -> dict[str, Any] | None: ...

    async def list_dead_letters(self, *, limit: int) -> list[dict[str, Any]]: ...

    async def replay(self, event_id: str, consumer_group: str) -> bool: ...

    async def delivery_stats(self, consumer_group: str) -> dict[str, int]: ...


@runtime_checkable
class TrackingBackend(Protocol):
    """Optional external experiment-tracking backend (MLflow or local).

    The platform repository is always the authorization-metadata authority; a
    tracking backend only mirrors runs and artifacts externally. Implementations
    must degrade honestly: `status()` reports whether external tracking is
    actually available, and methods raise `ProviderError` when it is not so the
    caller can record the run locally without failing the request.
    """

    backend: str

    @property
    def external(self) -> bool: ...

    async def status(self) -> dict[str, Any]: ...

    async def ensure_experiment(
        self,
        *,
        code: str,
        name: str,
        description: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def start_run(
        self,
        *,
        external_experiment_id: str | None,
        run_name: str | None,
        params: dict[str, Any],
        tags: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def log_batch(
        self,
        *,
        external_run_id: str,
        params: dict[str, Any],
        metrics: dict[str, Any],
        tags: dict[str, Any],
    ) -> None: ...

    async def end_run(self, *, external_run_id: str, status: str) -> None: ...

    async def register_model_version(
        self,
        *,
        name: str,
        source_uri: str,
        external_run_id: str | None,
        tags: dict[str, Any],
    ) -> dict[str, Any]: ...
