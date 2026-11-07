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

    async def update_knowledge_source_acl(
        self,
        tenant_id: int,
        source_id: int,
        acl: dict[str, Any],
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None: ...

    async def update_knowledge_source_classification(
        self,
        tenant_id: int,
        source_id: int,
        classification: str,
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
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
        self,
        tenant_id: int,
        source_id: int,
        *,
        limit: int,
        offset: int,
        classification_ceiling_rank: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_document(
        self, tenant_id: int, document_id: int
    ) -> dict[str, Any] | None: ...

    async def update_document_metadata(
        self,
        tenant_id: int,
        document_id: int,
        *,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any] | None:
        """Update descriptive fields only, bumping the document version.

        Content (chunks/embeddings) is never touched here. Returns ``None`` when
        the document is absent or ``expected_version`` no longer matches.
        """
        ...

    async def list_document_versions(
        self,
        tenant_id: int,
        document_id: int,
        *,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """Metadata-only history of superseded/deleted versions, newest first."""
        ...

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
        self,
        tenant_id: int,
        job_id: int,
        fields: dict[str, Any],
        *,
        expected_attempts: int | None = None,
    ) -> dict[str, Any] | None:
        """Update a job, optionally fenced on the claim generation.

        ``claim_job`` increments ``attempts`` atomically, so ``attempts`` is a
        monotonic generation number for the current owner. Passing the value
        observed at claim time as ``expected_attempts`` makes the write apply
        only if this worker still owns the job: a worker whose lease expired and
        was reclaimed by another worker (which bumped ``attempts``) gets
        ``None`` instead of clobbering the new owner's run or resurrecting a
        finished job. Omitting it performs an unconditional update.
        """
        ...

    async def list_jobs_by_status(
        self, status: str, *, limit: int, due_only: bool = True
    ) -> list[dict[str, Any]]: ...

    async def claim_job(
        self,
        tenant_id: int,
        job_id: int,
        *,
        lease_seconds: float,
        due_only: bool = True,
    ) -> dict[str, Any] | None:
        """Atomically move an eligible job to ``running`` and lease it.

        Returns the claimed row, or ``None`` when another worker already owns the
        job. Implementations must make the status check and the lease write a
        single atomic step so two workers cannot both claim the same job.

        A job is eligible when it is ``queued`` (and, with ``due_only``, its
        ``next_attempt_at`` has passed) or when it is ``running`` but its lease
        has expired. Claiming increments ``attempts`` and sets
        ``lease_expires_at``.
        """
        ...


    async def list_tenant_ids(
        self, *, limit: int, after_tenant_id: int = 0
    ) -> list[int]: ...

    async def job_metrics(self, *, stale_before: datetime) -> dict[str, Any]: ...

    async def list_jobs(
        self, tenant_id: int, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def delete_source(self, tenant_id: int, source_id: int) -> bool: ...

    async def delete_document(self, tenant_id: int, document_id: int) -> bool: ...

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]: ...

    async def list_document_chunks(
        self, tenant_id: int, document_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_authoritative_chunks(
        self, tenant_id: int, chunk_ids: list[int]
    ) -> list[dict[str, Any]]: ...

    async def existing_document_ids(
        self, tenant_id: int, document_ids: list[int]
    ) -> set[int]: ...

    async def source_states(
        self, tenant_id: int, source_ids: list[int]
    ) -> dict[int, str]: ...

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

    async def update_conversation(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def touch_conversation(self, tenant_id: int, conversation_id: int) -> None: ...

    async def add_message(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def update_message(
        self, tenant_id: int, message_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def list_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def list_recent_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def add_message_sources(
        self, tenant_id: int, message_id: int, sources: list[dict[str, Any]]
    ) -> None: ...

    async def get_message_sources(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]: ...

    async def get_message(
        self, tenant_id: int, message_id: int
    ) -> dict[str, Any] | None: ...

    async def add_context_refs(
        self, tenant_id: int, message_id: int, refs: list[dict[str, Any]]
    ) -> None: ...

    async def list_context_refs(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]: ...

    async def get_conversation_summary(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None: ...

    async def upsert_conversation_summary(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    # --- Copilot tool trace + controlled actions (Stage 5) --------------
    # Tool invocations are an audit trace of read-only tool calls. They store
    # bounded argument/result summaries only.
    async def record_copilot_tool_invocation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_copilot_tool_invocations(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]: ...

    # Controlled actions. Creation is idempotent by `operation_hash`; a second
    # create with the same hash returns None so callers can surface the existing
    # proposal instead of duplicating it.
    async def create_copilot_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def get_copilot_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None: ...

    async def get_copilot_action_by_hash(
        self, tenant_id: int, operation_hash: str
    ) -> dict[str, Any] | None: ...

    async def list_copilot_actions(
        self,
        tenant_id: int,
        *,
        status: str | None,
        conversation_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    # Conditional transition proposed -> approved|rejected. Returns None when
    # the row was already decided (or was never proposed).
    async def decide_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None: ...

    # Atomic approved -> executed claim. Returns None when the action is not
    # approved or was already claimed, which is what prevents replay/duplicate
    # execution under concurrency.
    async def claim_copilot_action_execution(
        self,
        tenant_id: int,
        action_id: int,
        *,
        executor_actor_id: int | None,
        executor_name: str | None,
    ) -> dict[str, Any] | None: ...

    async def complete_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        result: dict[str, Any],
        error_class: str | None,
    ) -> dict[str, Any] | None: ...

    # --- Enterprise search: saved searches + history (Stage 4) ----------
    # Saved searches/history are personal: reads and deletes are always scoped
    # to the exact actor (`actor_id IS NOT DISTINCT FROM ...`), so one actor can
    # never observe or remove another actor's rows.
    async def create_saved_search(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_saved_searches(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> dict[str, Any] | None: ...

    async def delete_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> bool: ...

    async def record_search_history(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_search_history(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def delete_search_history(
        self, tenant_id: int, history_id: int, actor_id: int | None
    ) -> bool: ...

    async def clear_search_history(self, tenant_id: int, actor_id: int | None) -> int: ...

    # --- Enterprise search: index health + reconciliation (Stage 4) -----
    # Health is computed for the caller's tenant only; problem documents are
    # never returned across tenants. Reconciliation only *enqueues* index jobs —
    # it never mutates or deletes knowledge content directly.
    async def search_index_stats(self, tenant_id: int) -> dict[str, Any]: ...

    async def search_index_status_by_source(
        self, tenant_id: int
    ) -> list[dict[str, Any]]: ...

    async def list_problem_documents(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def sources_needing_reindex(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]: ...

    # --- Enterprise search: duplicate/conflict findings (Stage 4/P5) -----
    # Findings are advisory review records. Implementation must upsert by a
    # canonical pair key so rescans are idempotent, and must never mutate or
    # merge the underlying documents.
    async def list_documents_for_dedup(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_duplicate_findings(
        self, tenant_id: int, findings: list[dict[str, Any]]
    ) -> dict[str, int]: ...

    async def list_duplicate_findings(
        self,
        tenant_id: int,
        *,
        status: str | None,
        kind: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_duplicate_finding(
        self, tenant_id: int, finding_id: int
    ) -> dict[str, Any] | None: ...

    async def update_duplicate_finding(
        self,
        tenant_id: int,
        finding_id: int,
        *,
        status: str,
        note: str | None,
        reviewed_by: int | None,
    ) -> dict[str, Any] | None: ...

    # --- Stage 6: agent catalog and immutable versions ------------------
    async def list_agent_catalog(
        self,
        tenant_id: int,
        *,
        query: str | None,
        lifecycle_status: str | None,
        category: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def create_agent(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]: ...

    async def update_agent_draft(
        self,
        tenant_id: int,
        agent_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None: ...

    async def set_agent_lifecycle(
        self,
        tenant_id: int,
        agent_id: int,
        *,
        lifecycle_status: str,
        enabled: bool,
        updated_by: str | None,
    ) -> dict[str, Any] | None: ...

    async def create_agent_version(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def update_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None: ...

    async def get_agent_version(
        self, tenant_id: int, agent_id: int, version_id: int
    ) -> dict[str, Any] | None: ...

    async def publish_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        tool_links: list[dict[str, Any]],
        updated_by: str | None,
    ) -> dict[str, Any] | None: ...

    async def set_agent_current_version(
        self, tenant_id: int, agent_id: int, version_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def list_agent_version_tools(
        self, tenant_id: int, agent_version_id: int
    ) -> list[dict[str, Any]]: ...

    # --- Stage 6: persisted tool registry ------------------------------
    async def list_agent_tools(
        self,
        tenant_id: int,
        *,
        query: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def create_agent_tool(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_agent_tool(
        self, tenant_id: int, tool_id: int
    ) -> dict[str, Any] | None: ...

    async def update_agent_tool(
        self,
        tenant_id: int,
        tool_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None: ...

    async def create_agent_tool_version(
        self, tenant_id: int, tool_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_agent_tool_version(
        self, tenant_id: int, tool_id: int, version_id: int
    ) -> dict[str, Any] | None: ...

    async def list_agent_tool_versions(
        self, tenant_id: int, tool_id: int
    ) -> list[dict[str, Any]]: ...

    async def update_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None: ...

    async def publish_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        updated_by: str | None,
    ) -> dict[str, Any] | None: ...

    # --- Stage 6: durable agent execution ------------------------------
    async def create_agent_execution(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_agent_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None: ...

    async def list_agent_executions(
        self,
        tenant_id: int,
        *,
        state: str | None,
        agent_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        expected_state: str | None,
        fields: dict[str, Any],
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None: ...

    async def claim_agent_execution(
        self,
        *,
        worker_id: str,
        lease_seconds: int,
    ) -> dict[str, Any] | None: ...

    async def renew_agent_execution_lease(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> dict[str, Any] | None: ...

    async def start_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_seconds: int,
    ) -> dict[str, Any] | None: ...

    async def upsert_execution_step(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None: ...

    async def list_execution_steps(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]: ...

    async def record_tool_invocation(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None: ...

    async def list_tool_invocations(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]: ...

    async def latest_tool_invocation(
        self, tenant_id: int, execution_id: int, step_id: int
    ) -> dict[str, Any] | None: ...

    async def update_tool_invocation(
        self,
        tenant_id: int,
        invocation_id: int,
        fields: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None: ...

    async def add_execution_checkpoint(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None: ...

    async def latest_execution_checkpoint(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None: ...

    async def list_agent_artifacts(
        self, tenant_id: int, *, execution_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def create_agent_artifact(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    # --- Stage 6: approvals --------------------------------------------
    async def create_agent_approval(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_agent_approval(
        self, tenant_id: int, approval_id: int
    ) -> dict[str, Any] | None: ...

    async def find_pending_approval(
        self, tenant_id: int, execution_id: int, operation_hash: str
    ) -> dict[str, Any] | None: ...

    async def list_agent_approvals(
        self,
        tenant_id: int,
        *,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def decide_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None: ...

    async def consume_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        execution_id: int,
        operation_hash: str,
        consumed_by: str,
    ) -> dict[str, Any] | None: ...

    # --- Stage 6 completion: templates, memory, schedules, delegation ---
    async def list_agent_templates(
        self,
        tenant_id: int,
        *,
        category: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_agent_template(
        self, tenant_id: int, template_id: int
    ) -> dict[str, Any] | None: ...

    async def upsert_agent_template(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_agent_memory(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        scope: str | None,
        execution_id: int | None,
        conversation_id: int | None,
        owner_actor_id: int | None,
        include_expired: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def get_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None: ...

    async def upsert_agent_memory(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def delete_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None: ...

    async def purge_expired_agent_memory(self, tenant_id: int) -> int: ...

    async def create_agent_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_agent_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None: ...

    async def list_agent_schedules(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_agent_schedule(
        self,
        tenant_id: int,
        schedule_id: int,
        fields: dict[str, Any],
    ) -> dict[str, Any] | None: ...

    async def delete_agent_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> bool: ...

    async def claim_due_schedules(
        self, *, limit: int, now: Any
    ) -> list[dict[str, Any]]: ...

    async def create_agent_delegation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def update_agent_delegation(
        self,
        tenant_id: int,
        delegation_id: int,
        fields: dict[str, Any],
    ) -> dict[str, Any] | None: ...

    async def get_agent_delegation(
        self, tenant_id: int, delegation_id: int
    ) -> dict[str, Any] | None: ...

    async def list_agent_delegations(
        self, tenant_id: int, parent_execution_id: int
    ) -> list[dict[str, Any]]: ...

    async def agent_execution_stats(
        self, tenant_id: int, *, agent_id: int | None
    ) -> dict[str, Any]: ...

    async def delete_agent(
        self, tenant_id: int, agent_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def update_agent_working_config(
        self,
        tenant_id: int,
        agent_id: int,
        working_config: dict[str, Any],
        *,
        updated_by: str | None,
    ) -> dict[str, Any] | None: ...

    # --- Knowledge graph (Stage 7) --------------------------------------
    async def upsert_graph_entity(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_graph_entity(
        self, tenant_id: int, entity_id: int
    ) -> dict[str, Any] | None: ...

    async def get_graph_entity_by_key(
        self, tenant_id: int, entity_type: str, stable_key: str
    ) -> dict[str, Any] | None: ...

    async def list_graph_entities(
        self,
        tenant_id: int,
        *,
        entity_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        source_system: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_graph_entity(
        self, tenant_id: int, entity_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def delete_graph_entity(
        self, tenant_id: int, entity_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def add_graph_entity_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_graph_entity_versions(
        self, tenant_id: int, entity_id: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_graph_relationship(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_graph_relationship(
        self, tenant_id: int, relationship_id: int
    ) -> dict[str, Any] | None: ...

    async def list_graph_relationships(
        self,
        tenant_id: int,
        *,
        entity_ids: list[int] | None,
        relationship_types: list[str] | None,
        direction: str,
        include_inactive: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_graph_relationship(
        self, tenant_id: int, relationship_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def delete_graph_relationship(
        self, tenant_id: int, relationship_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def add_graph_relationship_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_graph_neighbors(
        self,
        tenant_id: int,
        *,
        entity_ids: list[int],
        relationship_types: list[str] | None,
        direction: str,
        limit: int,
    ) -> list[dict[str, Any]]: ...

    async def graph_entity_type_counts(
        self, tenant_id: int
    ) -> list[dict[str, Any]]: ...

    async def graph_stats(self, tenant_id: int) -> dict[str, Any]: ...

    async def list_graph_entity_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_graph_entity_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_graph_relationship_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_graph_relationship_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    # --- Product & BOM intelligence (Stage 8) ---------------------------
    async def upsert_product_item(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_product_item(
        self, tenant_id: int, item_id: int
    ) -> dict[str, Any] | None: ...

    async def get_product_item_by_key(
        self, tenant_id: int, item_type: str, item_key: str
    ) -> dict[str, Any] | None: ...

    async def list_product_items(
        self,
        tenant_id: int,
        *,
        item_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_product_item(
        self, tenant_id: int, item_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def count_product_items_by_type(
        self, tenant_id: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_product_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_product_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None: ...

    async def get_product_revision_by_key(
        self, tenant_id: int, item_id: int, revision: str
    ) -> dict[str, Any] | None: ...

    async def list_product_revisions(
        self,
        tenant_id: int,
        *,
        item_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_product_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_bom_header(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_bom_header(
        self, tenant_id: int, header_id: int
    ) -> dict[str, Any] | None: ...

    async def get_bom_header_by_key(
        self, tenant_id: int, bom_type: str, bom_key: str
    ) -> dict[str, Any] | None: ...

    async def list_bom_headers(
        self,
        tenant_id: int,
        *,
        bom_type: str | None,
        root_item_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_bom_header(
        self, tenant_id: int, header_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def delete_bom_header(
        self, tenant_id: int, header_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def create_bom_line(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_bom_line(
        self, tenant_id: int, line_id: int
    ) -> dict[str, Any] | None: ...

    async def list_bom_lines(
        self,
        tenant_id: int,
        *,
        header_id: int | None,
        parent_revision_id: int | None,
        child_item_id: int | None,
        active_only: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def list_bom_lines_by_parents(
        self, tenant_id: int, header_id: int, parent_revision_ids: list[int]
    ) -> list[dict[str, Any]]: ...

    async def update_bom_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def delete_bom_line(
        self, tenant_id: int, line_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None: ...

    async def add_bom_transformation_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_bom_transformation_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None: ...

    async def list_bom_transformation_runs(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]: ...

    async def add_bom_reconciliation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_bom_reconciliations(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]: ...

    # --- Manufacturing intelligence (Stage 9) ---------------------------
    async def upsert_mfg_plant(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_plant(
        self, tenant_id: int, plant_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_plant_by_key(
        self, tenant_id: int, plant_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_plants(
        self,
        tenant_id: int,
        *,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_plant(
        self, tenant_id: int, plant_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_line(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_line(
        self, tenant_id: int, line_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_line_by_key(
        self, tenant_id: int, plant_id: int, line_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_lines(
        self,
        tenant_id: int,
        *,
        plant_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_work_centre(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_work_centre_by_key(
        self, tenant_id: int, plant_id: int, work_centre_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_work_centres(
        self,
        tenant_id: int,
        *,
        plant_id: int | None,
        line_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_process(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_process(
        self, tenant_id: int, process_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_process_by_key(
        self, tenant_id: int, process_type: str, process_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_processes(
        self,
        tenant_id: int,
        *,
        process_type: str | None,
        root_item_id: int | None,
        mbom_header_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_process(
        self, tenant_id: int, process_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_process_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_process_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_process_revision_by_key(
        self, tenant_id: int, process_id: int, revision: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_process_revisions(
        self,
        tenant_id: int,
        *,
        process_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_process_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_operation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_operation(
        self, tenant_id: int, operation_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_operation_by_key(
        self, tenant_id: int, process_id: int, operation_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_operations(
        self,
        tenant_id: int,
        *,
        process_id: int | None,
        work_centre_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def list_mfg_operations_by_process(
        self, tenant_id: int, process_id: int
    ) -> list[dict[str, Any]]: ...

    async def update_mfg_operation(
        self, tenant_id: int, operation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def add_mfg_operation_dependency(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_mfg_operation_dependencies(
        self, tenant_id: int, *, process_id: int
    ) -> list[dict[str, Any]]: ...

    async def list_mfg_dependencies_for_operators(
        self, tenant_id: int, operation_ids: list[int]
    ) -> list[dict[str, Any]]: ...

    async def delete_mfg_operation_dependency(
        self, tenant_id: int, dependency_id: int
    ) -> bool: ...

    async def add_mfg_operation_consumption(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_mfg_operation_consumptions(
        self,
        tenant_id: int,
        *,
        operation_id: int | None,
        child_item_id: int | None,
        limit: int,
    ) -> list[dict[str, Any]]: ...

    async def delete_mfg_operation_consumption(
        self, tenant_id: int, consumption_id: int
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_work_instruction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_work_instruction_by_key(
        self, tenant_id: int, instruction_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_work_instructions(
        self,
        tenant_id: int,
        *,
        process_id: int | None,
        operation_id: int | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_resource(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_resource(
        self, tenant_id: int, resource_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_resource_by_key(
        self, tenant_id: int, resource_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_resources(
        self,
        tenant_id: int,
        *,
        resource_kind: str | None,
        plant_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_resource(
        self, tenant_id: int, resource_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_mfg_production_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_mfg_production_version(
        self, tenant_id: int, production_version_id: int
    ) -> dict[str, Any] | None: ...

    async def get_mfg_production_version_by_key(
        self, tenant_id: int, item_id: int, version_key: str
    ) -> dict[str, Any] | None: ...

    async def list_mfg_production_versions(
        self,
        tenant_id: int,
        *,
        item_id: int | None,
        process_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_mfg_production_version(
        self, tenant_id: int, production_version_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    # --- Quality intelligence (Stage 9) --------------------------------
    async def upsert_quality_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_quality_issue(
        self, tenant_id: int, issue_id: int
    ) -> dict[str, Any] | None: ...

    async def get_quality_issue_by_key(
        self, tenant_id: int, issue_key: str
    ) -> dict[str, Any] | None: ...

    async def list_quality_issues(
        self,
        tenant_id: int,
        *,
        status: str | None,
        severity: str | None,
        issue_type: str | None,
        component_item_id: int | None,
        product_item_id: int | None,
        supplier_ref: str | None,
        plant_id: int | None,
        operation_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_quality_issue(
        self, tenant_id: int, issue_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_quality_inspection(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_quality_inspection(
        self, tenant_id: int, inspection_id: int
    ) -> dict[str, Any] | None: ...

    async def get_quality_inspection_by_key(
        self, tenant_id: int, inspection_key: str
    ) -> dict[str, Any] | None: ...

    async def list_quality_inspections(
        self,
        tenant_id: int,
        *,
        status: str | None,
        inspection_type: str | None,
        quality_issue_id: int | None,
        operation_id: int | None,
        query: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_quality_inspection(
        self, tenant_id: int, inspection_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def add_quality_inspection_result(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_quality_inspection_results(
        self, tenant_id: int, *, inspection_id: int, limit: int
    ) -> list[dict[str, Any]]: ...

    async def add_quality_root_cause(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_quality_root_cause(
        self, tenant_id: int, root_cause_id: int
    ) -> dict[str, Any] | None: ...

    async def list_quality_root_causes(
        self, tenant_id: int, *, quality_issue_id: int, limit: int
    ) -> list[dict[str, Any]]: ...

    async def update_quality_root_cause(
        self, tenant_id: int, root_cause_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_quality_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_quality_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None: ...

    async def get_quality_action_by_key(
        self, tenant_id: int, action_key: str
    ) -> dict[str, Any] | None: ...

    async def list_quality_actions(
        self,
        tenant_id: int,
        *,
        quality_issue_id: int | None,
        status: str | None,
        action_type: str | None,
        owner_user: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_quality_action(
        self, tenant_id: int, action_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def add_quality_supplier_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_quality_supplier_issues(
        self, tenant_id: int, *, supplier_ref: str | None, limit: int
    ) -> list[dict[str, Any]]: ...

    # --- Predictive intelligence (Stage 10) -----------------------------
    async def upsert_predictive_feature_definition(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_feature_definition(
        self, tenant_id: int, feature_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_feature_definition_by_key(
        self, tenant_id: int, feature_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_feature_definitions(
        self,
        tenant_id: int,
        *,
        entity_type: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_feature_definition(
        self, tenant_id: int, feature_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_predictive_feature_value(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_predictive_feature_values(
        self,
        tenant_id: int,
        *,
        feature_key: str | None,
        entity_type: str | None,
        entity_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def upsert_predictive_dataset(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_dataset(
        self, tenant_id: int, dataset_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_dataset_by_key(
        self, tenant_id: int, dataset_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_datasets(
        self,
        tenant_id: int,
        *,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_dataset(
        self, tenant_id: int, dataset_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_predictive_dataset_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_predictive_dataset_versions(
        self, tenant_id: int, *, dataset_id: int, limit: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_predictive_model(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_model(
        self, tenant_id: int, model_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_model_by_key(
        self, tenant_id: int, model_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_models(
        self,
        tenant_id: int,
        *,
        prediction_type: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_model(
        self, tenant_id: int, model_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_predictive_model_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_predictive_model_versions(
        self, tenant_id: int, *, model_id: int, limit: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_predictive_prediction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_prediction(
        self, tenant_id: int, prediction_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_prediction_by_key(
        self, tenant_id: int, prediction_key: str
    ) -> dict[str, Any] | None: ...

    async def find_predictive_prediction_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_predictions(
        self,
        tenant_id: int,
        *,
        prediction_type: str | None,
        subject_type: str | None,
        subject_id: int | None,
        risk_category: str | None,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_prediction(
        self, tenant_id: int, prediction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def upsert_predictive_recommendation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_recommendation_by_key(
        self, tenant_id: int, recommendation_key: str
    ) -> dict[str, Any] | None: ...

    async def find_predictive_recommendation_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_recommendations(
        self,
        tenant_id: int,
        *,
        status: str | None,
        severity: str | None,
        priority: str | None,
        prediction_id: int | None,
        owner_role: str | None,
        overdue_only: bool,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def add_predictive_recommendation_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def list_predictive_recommendation_feedback(
        self, tenant_id: int, *, recommendation_id: int, limit: int
    ) -> list[dict[str, Any]]: ...

    async def upsert_predictive_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]: ...

    async def get_predictive_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None: ...

    async def get_predictive_schedule_by_key(
        self, tenant_id: int, schedule_key: str
    ) -> dict[str, Any] | None: ...

    async def list_predictive_schedules(
        self,
        tenant_id: int,
        *,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]: ...

    async def update_predictive_schedule(
        self, tenant_id: int, schedule_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None: ...

    async def list_due_predictive_schedules(
        self, *, limit: int
    ) -> list[dict[str, Any]]: ...


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

    async def delete_document(
        self,
        tenant_id: int,
        document_id: int,
        *,
        source_id: int | None = None,
        external_id: str | None = None,
    ) -> None: ...

    async def delete_source(self, tenant_id: int, source_id: int) -> None: ...

    async def scan_documents(
        self,
        tenant_id: int,
        *,
        limit: int,
        after: list[Any] | None = None,
    ) -> tuple[list[dict[str, Any]], list[Any] | None]: ...

    async def delete_documents(
        self, tenant_id: int, document_ids: list[int]
    ) -> None: ...

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

    async def claim_undelivered(
        self,
        consumer_group: str,
        *,
        limit: int,
        claimed_by: str,
        lease_seconds: float,
    ) -> list[dict[str, Any]]:
        """Atomically claim up to ``limit`` undelivered events for one worker.

        Semantics differ from :meth:`list_undelivered`, which is a read-only
        peek. A claim must guarantee that two concurrent consumers of the same
        group cannot both receive the same event. Events whose lease expired
        (the claiming worker died) become claimable again, so a crash cannot
        strand an event permanently.
        """
        ...

    async def mark_delivered(self, event_id: str, consumer_group: str) -> None: ...

    async def record_failure(
        self,
        event_id: str,
        consumer_group: str,
        error: str,
        *,
        max_attempts: int,
        retry_delay_seconds: float = 0.0,
    ) -> str: ...

    async def list_events(self, tenant_id: int, *, limit: int) -> list[dict[str, Any]]: ...

    async def get_event(self, tenant_id: int, event_id: str) -> dict[str, Any] | None: ...

    async def list_dead_letters(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]: ...

    async def replay(
        self, tenant_id: int, event_id: str, consumer_group: str
    ) -> bool: ...

    async def delivery_stats(self, tenant_id: int, consumer_group: str) -> dict[str, int]: ...

    async def delivery_backlog(self) -> dict[str, int]: ...


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
