"""In-memory AiRepository for tests and local development without a database."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from itertools import count
from typing import Any
from uuid import uuid4

from ai_api.security.access_control import classification_rank


class InMemoryAiRepository:
    def __init__(self) -> None:
        self._sources: list[dict[str, Any]] = []
        self._jobs: list[dict[str, Any]] = []
        self._executions: list[dict[str, Any]] = []
        self._usage: list[dict[str, Any]] = []
        self._audit: list[dict[str, Any]] = []
        self._feedback: list[dict[str, Any]] = []
        self._agents: list[dict[str, Any]] = []
        self._agent_versions: list[dict[str, Any]] = []
        self._governance: dict[int, dict[str, Any]] = {}
        self._documents: list[dict[str, Any]] = []
        self._document_versions: list[dict[str, Any]] = []
        self._chunks: list[dict[str, Any]] = []
        self._embeddings: list[dict[str, Any]] = []
        self._experiments: list[dict[str, Any]] = []
        self._runs: list[dict[str, Any]] = []
        self._ml_models: list[dict[str, Any]] = []
        self._ml_versions: list[dict[str, Any]] = []
        self._evaluations: list[dict[str, Any]] = []
        self._evaluation_results: list[dict[str, Any]] = []
        self._conversations: list[dict[str, Any]] = []
        self._messages: list[dict[str, Any]] = []
        self._message_sources: list[dict[str, Any]] = []
        self._context_refs: list[dict[str, Any]] = []
        self._conversation_summaries: dict[int, dict[str, Any]] = {}
        self._copilot_tool_invocations: list[dict[str, Any]] = []
        self._copilot_actions: list[dict[str, Any]] = []
        self._saved_searches: list[dict[str, Any]] = []
        self._search_history: list[dict[str, Any]] = []
        self._duplicate_findings: list[dict[str, Any]] = []
        self._agent_tools: list[dict[str, Any]] = []
        self._agent_tool_versions: list[dict[str, Any]] = []
        self._agent_version_tools: list[dict[str, Any]] = []
        self._execution_steps: list[dict[str, Any]] = []
        self._tool_invocations: list[dict[str, Any]] = []
        self._agent_checkpoints: list[dict[str, Any]] = []
        self._agent_approvals: list[dict[str, Any]] = []
        self._agent_artifacts: list[dict[str, Any]] = []
        self._agent_templates: list[dict[str, Any]] = []
        self._agent_memory: list[dict[str, Any]] = []
        self._agent_schedules: list[dict[str, Any]] = []
        self._agent_delegations: list[dict[str, Any]] = []
        self._graph_entities: list[dict[str, Any]] = []
        self._graph_entity_versions: list[dict[str, Any]] = []
        self._graph_relationships: list[dict[str, Any]] = []
        self._graph_relationship_versions: list[dict[str, Any]] = []
        self._graph_entity_types: list[dict[str, Any]] = []
        self._graph_relationship_types: list[dict[str, Any]] = []
        self._product_items: list[dict[str, Any]] = []
        self._product_revisions: list[dict[str, Any]] = []
        self._bom_headers: list[dict[str, Any]] = []
        self._bom_lines: list[dict[str, Any]] = []
        self._bom_transformation_runs: list[dict[str, Any]] = []
        self._bom_transformation_entries: list[dict[str, Any]] = []
        self._bom_reconciliations: list[dict[str, Any]] = []
        self._mfg_plants: list[dict[str, Any]] = []
        self._mfg_lines: list[dict[str, Any]] = []
        self._mfg_work_centres: list[dict[str, Any]] = []
        self._mfg_processes: list[dict[str, Any]] = []
        self._mfg_process_revisions: list[dict[str, Any]] = []
        self._mfg_operations: list[dict[str, Any]] = []
        self._mfg_operation_dependencies: list[dict[str, Any]] = []
        self._mfg_operation_consumptions: list[dict[str, Any]] = []
        self._mfg_work_instructions: list[dict[str, Any]] = []
        self._mfg_resources: list[dict[str, Any]] = []
        self._mfg_production_versions: list[dict[str, Any]] = []
        self._quality_issues: list[dict[str, Any]] = []
        self._quality_inspections: list[dict[str, Any]] = []
        self._quality_inspection_results: list[dict[str, Any]] = []
        self._quality_root_causes: list[dict[str, Any]] = []
        self._quality_actions: list[dict[str, Any]] = []
        self._quality_supplier_issues: list[dict[str, Any]] = []
        self._predictive_feature_definitions: list[dict[str, Any]] = []
        self._predictive_feature_values: list[dict[str, Any]] = []
        self._predictive_datasets: list[dict[str, Any]] = []
        self._predictive_dataset_versions: list[dict[str, Any]] = []
        self._predictive_models: list[dict[str, Any]] = []
        self._predictive_model_versions: list[dict[str, Any]] = []
        self._predictive_predictions: list[dict[str, Any]] = []
        self._predictive_recommendations: list[dict[str, Any]] = []
        self._predictive_recommendation_feedback: list[dict[str, Any]] = []
        self._predictive_schedules: list[dict[str, Any]] = []
        self._ids: dict[str, count] = {}

    def _next_id(self, table: str) -> int:
        if table not in self._ids:
            self._ids[table] = count(1)
        return next(self._ids[table])

    @staticmethod
    def _now() -> datetime:
        return datetime.now(UTC)

    async def list_knowledge_sources(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [s for s in self._sources if s["tenant_id"] == tenant_id]
        total = len(items)
        page = sorted(items, key=lambda s: s["created_at"], reverse=True)[offset : offset + limit]
        return [self._public_source(s) for s in page], total

    async def create_knowledge_source(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        if any(s["tenant_id"] == tenant_id and s["code"] == data["code"] for s in self._sources):
            return None
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("source"),
            "code": data["code"],
            "name": data["name"],
            "kind": data["kind"],
            "uri": data.get("uri"),
            "classification": data.get("classification", "internal"),
            "acl": data.get("acl", {}),
            "config": data.get("config", {}),
            "status": "registered",
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        self._sources.append(record)
        return self._public_source(record)

    async def get_knowledge_source(
        self, tenant_id: int, source_id: int
    ) -> dict[str, Any] | None:
        for record in self._sources:
            if record["tenant_id"] == tenant_id and record["id"] == source_id:
                return self._public_source(record)
        return None

    async def update_knowledge_source_acl(
        self,
        tenant_id: int,
        source_id: int,
        acl: dict[str, Any],
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        record = next(
            (
                source
                for source in self._sources
                if source["tenant_id"] == tenant_id and source["id"] == source_id
            ),
            None,
        )
        if record is None or record.get("version", 1) != expected_version:
            return None
        document_ids = {
            document["id"]
            for document in self._documents
            if document["tenant_id"] == tenant_id
            and document["source_id"] == source_id
        }
        now = self._now()
        record["acl"] = dict(acl)
        record["version"] = expected_version + 1
        record["updated_at"] = now
        for document in self._documents:
            if document["id"] in document_ids:
                document["acl"] = dict(acl)
                document["search_indexed_at"] = None
                document["updated_at"] = now
        for chunk in self._chunks:
            if chunk["document_id"] in document_ids:
                chunk["acl"] = dict(acl)
        result = self._public_source(record)
        if refresh_job is not None:
            try:
                result["_refresh_job"] = await self.create_job(tenant_id, refresh_job)
            except Exception:  # noqa: BLE001 - policy already committed; reconcile recovers
                result["_refresh_job"] = None
        return result

    async def update_knowledge_source_classification(
        self,
        tenant_id: int,
        source_id: int,
        classification: str,
        *,
        expected_version: int,
        refresh_job: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        record = next(
            (
                source
                for source in self._sources
                if source["tenant_id"] == tenant_id and source["id"] == source_id
            ),
            None,
        )
        if record is None or record.get("version", 1) != expected_version:
            return None
        now = self._now()
        record["classification"] = classification
        record["version"] = expected_version + 1
        record["updated_at"] = now
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["source_id"] == source_id:
                document["search_indexed_at"] = None
        result = self._public_source(record)
        if refresh_job is not None:
            try:
                result["_refresh_job"] = await self.create_job(tenant_id, refresh_job)
            except Exception:  # noqa: BLE001 - policy already committed; reconcile recovers
                result["_refresh_job"] = None
        return result

    @staticmethod
    def _public_source(record: dict[str, Any]) -> dict[str, Any]:
        public = {
            key: record[key]
            for key in (
                "id",
                "code",
                "name",
                "kind",
                "uri",
                "classification",
                "acl",
                "status",
                "created_at",
                "updated_at",
            )
        }
        public["version"] = int(record.get("version", 1))
        return public

    async def create_job(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        key = data.get("idempotency_key")
        if key:
            for job in self._jobs:
                if job["tenant_id"] == tenant_id and job["idempotency_key"] == key:
                    return self._public_job(job)
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("job"),
            "type": data["type"],
            "status": "queued",
            "source_id": data.get("source_id"),
            "idempotency_key": key,
            "progress": 0,
            "attempts": 0,
            "max_attempts": data.get("max_attempts", 5),
            "stage": data.get("stage"),
            "error_class": None,
            "lease_expires_at": None,
            "next_attempt_at": data.get("next_attempt_at"),
            "payload": data.get("payload", {}),
            "result": None,
            "error": None,
            "created_at": self._now(),
            "started_at": None,
            "finished_at": None,
        }
        self._jobs.append(record)
        return self._public_job(record)

    async def get_job(self, tenant_id: int, job_id: int) -> dict[str, Any] | None:
        for job in self._jobs:
            if job["tenant_id"] == tenant_id and job["id"] == job_id:
                return self._public_job(job)
        return None

    @staticmethod
    def _public_job(record: dict[str, Any]) -> dict[str, Any]:
        return {
            key: record.get(key)
            for key in (
                "id",
                "type",
                "status",
                "source_id",
                "progress",
                "attempts",
                "max_attempts",
                "stage",
                "error_class",
                "lease_expires_at",
                "next_attempt_at",
                "payload",
                "result",
                "error",
                "created_at",
                "started_at",
                "finished_at",
            )
        }

    async def record_execution(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("execution"),
            "request_id": data.get("request_id"),
            **data,
            "created_at": self._now(),
        }
        self._executions.append(record)
        return {"id": record["id"], "request_id": record["request_id"]}

    async def record_usage(self, tenant_id: int, data: dict[str, Any]) -> None:
        record = {"tenant_id": tenant_id, "id": self._next_id("usage"), **data}
        record["created_at"] = self._now()
        self._usage.append(record)

    async def usage_summary(
        self, tenant_id: int, *, since: datetime | None
    ) -> dict[str, Any]:
        rows = [
            row
            for row in self._usage
            if row["tenant_id"] == tenant_id and (since is None or row["created_at"] >= since)
        ]
        by_kind: dict[str, dict[str, Any]] = {}
        total_quantity = 0
        total_cost = 0.0
        for row in rows:
            kind = row["kind"]
            bucket = by_kind.setdefault(kind, {"kind": kind, "quantity": 0, "total_cost": 0.0})
            bucket["quantity"] += int(row.get("quantity", 0))
            bucket["total_cost"] += float(row.get("total_cost") or 0)
            total_quantity += int(row.get("quantity", 0))
            total_cost += float(row.get("total_cost") or 0)
        return {
            "quantity": total_quantity,
            "total_cost": total_cost,
            "currency": "USD",
            "by_kind": [by_kind[k] for k in sorted(by_kind)],
        }

    async def list_usage(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [r for r in self._usage if r["tenant_id"] == tenant_id]
        page = sorted(rows, key=lambda r: r["created_at"], reverse=True)[offset : offset + limit]
        return [
            {
                "id": r["id"],
                "kind": r.get("kind"),
                "provider_code": r.get("provider_code"),
                "model_code": r.get("model_code"),
                "quantity": r.get("quantity"),
                "unit": r.get("unit", "tokens"),
                "total_cost": r.get("total_cost"),
                "currency": r.get("currency", "USD"),
                "created_at": r["created_at"],
            }
            for r in page
        ], len(rows)

    async def write_audit(self, tenant_id: int, data: dict[str, Any]) -> None:
        record = {"tenant_id": tenant_id, "id": self._next_id("audit"), **data}
        record["created_at"] = self._now()
        self._audit.append(record)

    async def list_audit(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [r for r in self._audit if r["tenant_id"] == tenant_id]
        page = sorted(rows, key=lambda r: r["created_at"], reverse=True)[offset : offset + limit]
        return [
            {
                "id": r["id"],
                "actor_id": r.get("actor_id"),
                "action": r.get("action"),
                "resource_type": r.get("resource_type"),
                "resource_id": r.get("resource_id"),
                "outcome": r.get("outcome", "success"),
                "request_id": r.get("request_id"),
                "detail": r.get("detail", {}),
                "created_at": r["created_at"],
            }
            for r in page
        ], len(rows)

    async def list_agents(self, tenant_id: int) -> list[dict[str, Any]]:
        return [a for a in self._agents if a["tenant_id"] == tenant_id]

    async def get_agent(self, tenant_id: int, agent_id: int) -> dict[str, Any] | None:
        for agent in self._agents:
            if agent["tenant_id"] == tenant_id and agent["id"] == agent_id:
                return agent
        return None

    async def create_agent_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for agent in self._agents:
            if agent["tenant_id"] == tenant_id and agent["code"] == data["code"]:
                return agent
        return self.add_agent(tenant_id, **data)

    async def create_agent_version_if_absent(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for version in self._agent_versions:
            if version["agent_id"] == agent_id and version["version"] == data["version"]:
                return version
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_version"),
            "agent_id": agent_id,
            "version": data["version"],
            "definition": data.get("definition", {}),
            "status": data.get("status", "active"),
            "created_at": self._now(),
        }
        self._agent_versions.append(record)
        return record

    async def list_agent_versions(
        self, tenant_id: int, agent_id: int
    ) -> list[dict[str, Any]]:
        versions = [
            v
            for v in self._agent_versions
            if v["tenant_id"] == tenant_id and v["agent_id"] == agent_id
        ]
        return sorted(versions, key=lambda v: v["version"], reverse=True)

    async def get_active_agent_version(
        self, tenant_id: int, agent_id: int
    ) -> dict[str, Any] | None:
        versions = [
            v
            for v in self._agent_versions
            if v["tenant_id"] == tenant_id
            and v["agent_id"] == agent_id
            and v["status"] == "active"
        ]
        if not versions:
            return None
        return max(versions, key=lambda v: v["version"])

    async def list_executions(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        operation: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [r for r in self._executions if r["tenant_id"] == tenant_id]
        if agent_id is not None:
            rows = [r for r in rows if r.get("agent_id") == agent_id]
        if operation is not None:
            rows = [r for r in rows if r.get("operation") == operation]
        total = len(rows)
        page = sorted(
            rows, key=lambda r: r.get("created_at") or self._now(), reverse=True
        )[offset : offset + limit]
        return [self._public_execution(r) for r in page], total

    async def get_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        for row in self._executions:
            if row["tenant_id"] == tenant_id and row["id"] == execution_id:
                return self._public_execution(row)
        return None

    @staticmethod
    def _public_execution(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "request_id": str(row.get("request_id")) if row.get("request_id") else None,
            "actor_id": row.get("actor_id"),
            "agent_id": row.get("agent_id"),
            "operation": row.get("operation"),
            "status": row.get("status"),
            "latency_ms": row.get("latency_ms"),
            "token_usage": row.get("token_usage") or {},
            "created_at": row.get("created_at"),
        }

    async def record_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("feedback"),
            "created_at": self._now(),
            **data,
        }
        self._feedback.append(record)
        return record

    async def list_feedback(
        self,
        tenant_id: int,
        *,
        execution_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [r for r in self._feedback if r["tenant_id"] == tenant_id]
        if execution_id is not None:
            rows = [r for r in rows if r.get("execution_id") == execution_id]
        total = len(rows)
        page = sorted(rows, key=lambda r: r["created_at"], reverse=True)[
            offset : offset + limit
        ]
        return [
            {
                "id": r["id"],
                "execution_id": r.get("execution_id"),
                "actor_id": r.get("actor_id"),
                "rating": r.get("rating"),
                "comment": r.get("comment"),
                "created_at": r["created_at"],
            }
            for r in page
        ], total

    async def get_governance_policy(self, tenant_id: int) -> dict[str, Any] | None:
        return self._governance.get(tenant_id)

    async def upsert_governance_policy(
        self, tenant_id: int, policy: dict[str, Any]
    ) -> dict[str, Any]:
        stored = dict(policy)
        self._governance[tenant_id] = stored
        return stored

    def add_agent(self, tenant_id: int, **fields: Any) -> dict[str, Any]:
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent"),
            "enabled": True,
            "created_at": self._now(),
            "updated_at": self._now(),
            **fields,
        }
        self._agents.append(record)
        return record

    # --- Knowledge ingestion / retrieval (Phase 7) ----------------------

    def _chunk_join(self, tenant_id: int) -> list[dict[str, Any]]:
        sources = {s["id"]: s for s in self._sources if s["tenant_id"] == tenant_id}
        documents = {
            d["id"]: d for d in self._documents if d["tenant_id"] == tenant_id
        }
        results: list[dict[str, Any]] = []
        for chunk in self._chunks:
            if chunk["tenant_id"] != tenant_id:
                continue
            document = documents.get(chunk["document_id"])
            if document is None:
                continue
            source = sources.get(document["source_id"])
            if source is None:
                continue
            results.append(
                {
                    "chunk_id": chunk["id"],
                    "document_id": chunk["document_id"],
                    "chunk_index": chunk["chunk_index"],
                    "content": chunk["content"],
                    "classification": chunk["classification"],
                    "acl": chunk["acl"],
                    "page": chunk.get("page"),
                    "section": chunk.get("section"),
                    "title": document.get("title"),
                    "mime_type": document.get("mime_type"),
                    "external_id": document.get("external_id"),
                    "document_status": document.get("status"),
                    "document_created_at": document.get("created_at"),
                    "document_updated_at": document.get("updated_at"),
                    "document_metadata": document.get("metadata") or {},
                    "document_version": document.get("version", 1),
                    "source_id": source["id"],
                    "source_code": source["code"],
                    "source_name": source["name"],
                }
            )
        return results

    async def create_or_replace_document(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        """Replace indexed content, carrying the document version forward.

        Mirrors the Postgres repository: the prior row is snapshotted into
        version history before deletion and the replacement continues at
        ``previous.version + 1``. Client-supplied versions are ignored.
        """
        doomed = [
            d
            for d in self._documents
            if d["tenant_id"] == tenant_id
            and d["source_id"] == data["source_id"]
            and d["external_id"] == data["external_id"]
        ]
        doomed_ids = {d["id"] for d in doomed}
        version = 1
        for previous in doomed:
            version = max(version, int(previous.get("version") or 1) + 1)
            self._snapshot_version(
                tenant_id,
                previous,
                reason=data.get("version_reason", "superseded"),
            )
        self._documents = [d for d in self._documents if d["id"] not in doomed_ids]
        chunk_ids = {c["id"] for c in self._chunks if c["document_id"] in doomed_ids}
        self._chunks = [c for c in self._chunks if c["document_id"] not in doomed_ids]
        self._embeddings = [
            e for e in self._embeddings if e["chunk_id"] not in chunk_ids
        ]
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("document"),
            "title": data.get("title"),
            "mime_type": data.get("mime_type"),
            "uri": data.get("uri"),
            "object_key": data.get("object_key"),
            "checksum": data.get("checksum"),
            "size_bytes": data.get("size_bytes"),
            "classification": data.get("classification", "internal"),
            "acl": data.get("acl", {}),
            "metadata": data.get("metadata", {}),
            "status": "indexed",
            "indexed_at": self._now(),
            "search_indexed_at": None,
            "error_class": None,
            "created_at": self._now(),
            "updated_at": self._now(),
            "version": version,
            "source_id": data["source_id"],
            "external_id": data["external_id"],
        }
        self._documents.append(record)
        return dict(record)

    def _snapshot_version(
        self,
        tenant_id: int,
        document: dict[str, Any],
        *,
        reason: str,
    ) -> None:
        """Record metadata-only history for a superseded document version."""
        version = int(document.get("version") or 1)
        exists = any(
            v["tenant_id"] == tenant_id
            and v["document_id"] == document["id"]
            and v["version"] == version
            for v in self._document_versions
        )
        if not exists:
            self._document_versions.append(
                {
                    "tenant_id": tenant_id,
                    "id": self._next_id("document_version"),
                    "document_id": document["id"],
                    "source_id": document["source_id"],
                    "external_id": document["external_id"],
                    "version": version,
                    "title": document.get("title"),
                    "mime_type": document.get("mime_type"),
                    "checksum": document.get("checksum"),
                    "size_bytes": document.get("size_bytes"),
                    "classification": document.get("classification", "internal"),
                    "acl": document.get("acl") or {},
                    "metadata": document.get("metadata") or {},
                    "status": document.get("status") or "indexed",
                    "reason": reason,
                    "superseded_at": self._now(),
                }
            )
        identity = (document["source_id"], document["external_id"])
        history = sorted(
            (
                v
                for v in self._document_versions
                if v["tenant_id"] == tenant_id
                and (v["source_id"], v["external_id"]) == identity
            ),
            key=lambda v: v["version"],
            reverse=True,
        )
        if len(history) > 50:
            keep = {v["id"] for v in history[:50]}
            self._document_versions = [
                v
                for v in self._document_versions
                if v["id"] in keep
                or (v["source_id"], v["external_id"]) != identity
            ]

    async def update_document_metadata(
        self,
        tenant_id: int,
        document_id: int,
        *,
        title: str | None = None,
        metadata: dict[str, Any] | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any] | None:
        for document in self._documents:
            if document["tenant_id"] != tenant_id or document["id"] != document_id:
                continue
            if (
                expected_version is not None
                and int(document.get("version") or 1) != expected_version
            ):
                return None
            self._snapshot_version(tenant_id, document, reason="metadata_update")
            if title is not None:
                document["title"] = title
            if metadata is not None:
                document["metadata"] = metadata
            document["version"] = int(document.get("version") or 1) + 1
            document["updated_at"] = self._now()
            document["search_indexed_at"] = None
            return dict(document)
        return None

    async def list_document_versions(
        self,
        tenant_id: int,
        document_id: int,
        *,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        current = next(
            (
                d
                for d in self._documents
                if d["tenant_id"] == tenant_id and d["id"] == document_id
            ),
            None,
        )
        identity = (
            (current["source_id"], current["external_id"])
            if current is not None
            else None
        )
        rows = [
            dict(v)
            for v in self._document_versions
            if v["tenant_id"] == tenant_id
            and (
                v["document_id"] == document_id
                or identity
                == (v["source_id"], v["external_id"])
            )
        ]
        rows.sort(key=lambda v: (v["version"], v["id"]), reverse=True)
        return rows[offset : offset + limit], len(rows)

    async def add_chunks(
        self, tenant_id: int, document_id: int, chunks: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for chunk in chunks:
            record = {
                "tenant_id": tenant_id,
                "id": self._next_id("chunk"),
                "document_id": document_id,
                "chunk_index": chunk["chunk_index"],
                "content": chunk["content"],
                "token_count": chunk.get("token_count"),
                "checksum": chunk.get("checksum"),
                "classification": chunk.get("classification", "internal"),
                "acl": chunk.get("acl", {}),
                "metadata": chunk.get("metadata", {}),
                "page": chunk.get("page"),
                "section": chunk.get("section"),
                "created_at": self._now(),
            }
            self._chunks.append(record)
            rows.append(dict(record))
        return rows

    async def add_embeddings(self, tenant_id: int, rows: list[dict[str, Any]]) -> int:
        for row in rows:
            self._embeddings.append(
                {
                    "tenant_id": tenant_id,
                    "chunk_id": row["chunk_id"],
                    "model_code": row["model_code"],
                    "dimensions": int(row.get("dimensions", 1536)),
                    "embedding": [float(v) for v in row["embedding"]],
                    "created_at": self._now(),
                }
            )
        return len(rows)

    async def vector_search(
        self, tenant_id: int, embedding: list[float], *, limit: int
    ) -> list[dict[str, Any]]:
        query = [float(v) for v in embedding]
        candidates = {c["chunk_id"]: c for c in self._chunk_join(tenant_id)}
        scored: list[tuple[float, dict[str, Any]]] = []
        for row in self._embeddings:
            if row["tenant_id"] != tenant_id:
                continue
            candidate = candidates.get(row["chunk_id"])
            if candidate is None:
                continue
            scored.append((_cosine(query, row["embedding"]), candidate))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [{**candidate, "score": score} for score, candidate in scored[:limit]]

    async def lexical_search(
        self, tenant_id: int, query: str, *, limit: int
    ) -> list[dict[str, Any]]:
        terms = [t for t in query.lower().split() if t]
        scored: list[tuple[float, dict[str, Any]]] = []
        for candidate in self._chunk_join(tenant_id):
            content = candidate["content"].lower()
            hits = sum(content.count(term) for term in terms)
            if hits:
                scored.append((float(hits), candidate))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [{**candidate, "score": score} for score, candidate in scored[:limit]]

    async def list_documents(
        self,
        tenant_id: int,
        source_id: int,
        *,
        limit: int,
        offset: int,
        classification_ceiling_rank: int,
    ) -> tuple[list[dict[str, Any]], int]:
        source = next(
            (
                s
                for s in self._sources
                if s["tenant_id"] == tenant_id and s["id"] == source_id
            ),
            None,
        )
        if source is None or source.get("status") == "disabled":
            return [], 0
        source_classification = source.get("classification") or "internal"
        items = []
        for document in self._documents:
            if document["tenant_id"] != tenant_id or document["source_id"] != source_id:
                continue
            effective_rank = max(
                classification_rank(document.get("classification") or "internal"),
                classification_rank(source_classification),
            )
            if effective_rank > classification_ceiling_rank:
                continue
            items.append(
                {
                    **document,
                    "source_classification": source_classification,
                    "source_acl": source.get("acl", {}),
                    "source_status": source.get("status"),
                }
            )
        page = sorted(
            items,
            key=lambda d: (d["created_at"], d["id"]),
            reverse=True,
        )[offset : offset + limit]
        return [dict(d) for d in page], len(items)

    async def list_source_chunks(
        self, tenant_id: int, source_id: int
    ) -> list[dict[str, Any]]:
        document_ids = {
            d["id"]
            for d in self._documents
            if d["tenant_id"] == tenant_id and d["source_id"] == source_id
        }
        documents = {d["id"]: d for d in self._documents}
        sources = {s["id"]: s for s in self._sources}
        rows = [
            {
                "document_id": c["document_id"],
                "external_id": documents[c["document_id"]]["external_id"],
                "title": documents[c["document_id"]].get("title"),
                "mime_type": documents[c["document_id"]].get("mime_type"),
                "object_key": documents[c["document_id"]].get("object_key"),
                "chunk_index": c["chunk_index"],
                "content": c["content"],
                "classification": c.get("classification", "internal"),
                "acl": c.get("acl", {}),
                "metadata": c.get("metadata", {}),
                "page": c.get("page"),
                "section": c.get("section"),
                "document_classification": documents[c["document_id"]].get(
                    "classification", "internal"
                ),
                "document_acl": documents[c["document_id"]].get("acl", {}),
                "document_status": documents[c["document_id"]].get("status"),
                "document_metadata": documents[c["document_id"]].get("metadata") or {},
                "document_version": documents[c["document_id"]].get("version", 1),
                "source_classification": sources[
                    documents[c["document_id"]]["source_id"]
                ].get("classification", "internal"),
                "source_acl": sources[documents[c["document_id"]]["source_id"]].get(
                    "acl", {}
                ),
                "source_status": sources[documents[c["document_id"]]["source_id"]].get(
                    "status"
                ),
            }
            for c in self._chunks
            if c["tenant_id"] == tenant_id and c["document_id"] in document_ids
        ]
        rows.sort(key=lambda r: (r["document_id"], r["chunk_index"]))
        return rows

    async def list_document_chunks(
        self, tenant_id: int, document_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        document = next(
            (
                d
                for d in self._documents
                if d["tenant_id"] == tenant_id and d["id"] == document_id
            ),
            None,
        )
        if document is None:
            return [], 0
        items = [
            {
                "chunk_id": c["id"],
                "document_id": c["document_id"],
                "chunk_index": c["chunk_index"],
                "content": c["content"],
                "classification": c.get("classification", "internal"),
                "acl": c.get("acl", {}),
                "metadata": c.get("metadata", {}),
                "page": c.get("page"),
                "section": c.get("section"),
            }
            for c in self._chunks
            if c["tenant_id"] == tenant_id and c["document_id"] == document_id
        ]
        items.sort(key=lambda r: (r["chunk_index"], r["chunk_id"]))
        return items[offset : offset + limit], len(items)

    async def get_authoritative_chunks(
        self, tenant_id: int, chunk_ids: list[int]
    ) -> list[dict[str, Any]]:
        if not chunk_ids:
            return []
        wanted = set(chunk_ids)
        documents = {
            d["id"]: d for d in self._documents if d["tenant_id"] == tenant_id
        }
        sources = {s["id"]: s for s in self._sources if s["tenant_id"] == tenant_id}
        rows: list[dict[str, Any]] = []
        for chunk in self._chunks:
            if chunk["tenant_id"] != tenant_id or chunk["id"] not in wanted:
                continue
            document = documents.get(chunk["document_id"])
            if document is None:
                continue
            source = sources.get(document["source_id"])
            if source is None:
                continue
            rows.append(
                {
                    "chunk_id": chunk["id"],
                    "document_id": chunk["document_id"],
                    "chunk_index": chunk["chunk_index"],
                    "content": chunk["content"],
                    "chunk_classification": chunk.get("classification", "internal"),
                    "chunk_acl": chunk.get("acl", {}),
                    "page": chunk.get("page"),
                    "section": chunk.get("section"),
                    "source_id": source["id"],
                    "title": document.get("title"),
                    "mime_type": document.get("mime_type"),
                    "external_id": document.get("external_id"),
                    "document_status": document.get("status"),
                    "document_classification": document.get(
                        "classification", "internal"
                    ),
                    "document_acl": document.get("acl", {}),
                    "document_created_at": document.get("created_at"),
                    "document_updated_at": document.get("updated_at"),
                    "document_metadata": document.get("metadata") or {},
                    "document_version": document.get("version", 1),
                    "source_code": source["code"],
                    "source_name": source["name"],
                    "source_status": source.get("status"),
                    "source_classification": source.get(
                        "classification", "internal"
                    ),
                    "source_acl": source.get("acl", {}),
                }
            )
        return rows

    async def existing_document_ids(
        self, tenant_id: int, document_ids: list[int]
    ) -> set[int]:
        wanted = set(document_ids)
        return {
            int(d["id"])
            for d in self._documents
            if d["tenant_id"] == tenant_id and d["id"] in wanted
        }

    async def source_states(
        self, tenant_id: int, source_ids: list[int]
    ) -> dict[int, str]:
        wanted = set(source_ids)
        return {
            int(s["id"]): s.get("status", "")
            for s in self._sources
            if s["tenant_id"] == tenant_id and s["id"] in wanted
        }

    async def get_document(
        self, tenant_id: int, document_id: int
    ) -> dict[str, Any] | None:
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["id"] == document_id:
                result = dict(document)
                source = next(
                    (
                        s
                        for s in self._sources
                        if s["tenant_id"] == tenant_id
                        and s["id"] == document["source_id"]
                    ),
                    None,
                )
                if source is not None:
                    result.setdefault("source_code", source.get("code"))
                    result["source_classification"] = source.get(
                        "classification", "internal"
                    )
                    result["source_acl"] = source.get("acl", {})
                    result["source_status"] = source.get("status")
                return result
        return None

    async def find_document_by_checksum(
        self, tenant_id: int, checksum: str
    ) -> dict[str, Any] | None:
        matches = [
            dict(d)
            for d in self._documents
            if d["tenant_id"] == tenant_id and d.get("checksum") == checksum
        ]
        matches.sort(key=lambda d: d["created_at"], reverse=True)
        return matches[0] if matches else None

    async def set_document_search_state(
        self,
        tenant_id: int,
        document_id: int,
        *,
        search_indexed_at: datetime | None,
        status: str | None = None,
        error_class: str | None = None,
    ) -> None:
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["id"] == document_id:
                if search_indexed_at is not None:
                    document["search_indexed_at"] = search_indexed_at
                if status is not None:
                    document["status"] = status
                document["error_class"] = error_class
                return

    async def set_source_status(self, tenant_id: int, source_id: int, status: str) -> None:
        for source in self._sources:
            if source["tenant_id"] == tenant_id and source["id"] == source_id:
                source["status"] = status

    async def update_job(
        self,
        tenant_id: int,
        job_id: int,
        fields: dict[str, Any],
        *,
        expected_attempts: int | None = None,
    ) -> dict[str, Any] | None:
        for job in self._jobs:
            if job["tenant_id"] == tenant_id and job["id"] == job_id:
                if (
                    expected_attempts is not None
                    and int(job.get("attempts", 0)) != int(expected_attempts)
                ):
                    return None
                job.update(fields)
                return dict(job)
        return None

    async def claim_job(
        self,
        tenant_id: int,
        job_id: int,
        *,
        lease_seconds: float,
        due_only: bool = True,
    ) -> dict[str, Any] | None:
        """Atomically lease an eligible job, mirroring ``PostgresAiRepository``.

        There is no ``await`` between the eligibility check and the mutation, so
        the claim is atomic with respect to other coroutines in this process.
        """
        now = self._now()
        for job in self._jobs:
            if job["tenant_id"] != tenant_id or job["id"] != job_id:
                continue
            status = job.get("status")
            if status == "queued":
                due_at = job.get("next_attempt_at")
                if due_only and due_at is not None and due_at > now:
                    return None
            elif status == "running":
                lease = job.get("lease_expires_at")
                if lease is None or lease >= now:
                    return None
            else:
                return None
            job.update(
                {
                    "status": "running",
                    "stage": "processing",
                    "started_at": now,
                    "attempts": int(job.get("attempts", 0)) + 1,
                    "lease_expires_at": now + timedelta(
                        seconds=max(0.0, lease_seconds)
                    ),
                    "next_attempt_at": None,
                }
            )
            return self._public_job(job)
        return None

    async def list_jobs_by_status(
        self, status: str, *, limit: int, due_only: bool = True
    ) -> list[dict[str, Any]]:
        now = self._now()
        jobs = [
            dict(j)
            for j in self._jobs
            if j["status"] == status
            and (
                not due_only
                or j.get("next_attempt_at") is None
                or j["next_attempt_at"] <= now
            )
        ]
        jobs.sort(key=lambda j: j["id"])
        return jobs[:limit]

    async def list_tenant_ids(
        self, *, limit: int, after_tenant_id: int = 0
    ) -> list[int]:
        tenant_ids = {
            int(record["tenant_id"])
            for collection in (self._sources, self._documents, self._jobs)
            for record in collection
            if record.get("tenant_id") is not None
        }
        return sorted(t for t in tenant_ids if t > after_tenant_id)[:limit]

    async def job_metrics(self, *, stale_before: datetime) -> dict[str, Any]:
        by_status: dict[str, int] = {}
        overdue = 0
        for job in self._jobs:
            by_status[job["status"]] = by_status.get(job["status"], 0) + 1
            if (
                str(job.get("idempotency_key") or "").startswith("source-security-")
                and job["status"] in ("queued", "running", "failed")
                and (job.get("next_attempt_at") or job.get("created_at")) is not None
                and (job.get("next_attempt_at") or job.get("created_at")) < stale_before
            ):
                overdue += 1
        return {"by_status": by_status, "security_refresh_overdue": overdue}

    async def list_jobs(
        self, tenant_id: int, *, status: str | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        jobs = [
            self._public_job(j)
            for j in self._jobs
            if j["tenant_id"] == tenant_id and (status is None or j["status"] == status)
        ]
        jobs.sort(key=lambda j: j["id"], reverse=True)
        total = len(jobs)
        return jobs[offset : offset + limit], total

    async def delete_source(self, tenant_id: int, source_id: int) -> bool:
        before = len(self._sources)
        self._sources = [
            s
            for s in self._sources
            if not (s["tenant_id"] == tenant_id and s["id"] == source_id)
        ]
        removed = len(self._sources) != before
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["source_id"] == source_id:
                self._snapshot_version(tenant_id, document, reason="deleted")
        doomed_docs = {
            d["id"]
            for d in self._documents
            if d["tenant_id"] == tenant_id and d["source_id"] == source_id
        }
        doomed_chunks = {c["id"] for c in self._chunks if c["document_id"] in doomed_docs}
        self._documents = [d for d in self._documents if d["id"] not in doomed_docs]
        self._chunks = [c for c in self._chunks if c["id"] not in doomed_chunks]
        self._embeddings = [e for e in self._embeddings if e["chunk_id"] not in doomed_chunks]
        return removed

    async def delete_document(self, tenant_id: int, document_id: int) -> bool:
        doomed = [
            d["id"]
            for d in self._documents
            if d["tenant_id"] == tenant_id and d["id"] == document_id
        ]
        if not doomed:
            return False
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["id"] == document_id:
                self._snapshot_version(tenant_id, document, reason="deleted")
        self._documents = [d for d in self._documents if d["id"] != document_id]
        doomed_chunks = {
            c["id"] for c in self._chunks if c["document_id"] == document_id
        }
        self._chunks = [c for c in self._chunks if c["document_id"] != document_id]
        self._embeddings = [
            e for e in self._embeddings if e["chunk_id"] not in doomed_chunks
        ]
        return True

    # --- ML experiment tracking and model registry (Phase 11) ------------
    async def create_experiment_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for record in self._experiments:
            if record["tenant_id"] == tenant_id and record["code"] == data["code"]:
                return dict(record)
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("experiment"),
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "problem_type": data.get("problem_type", "classification"),
            "tracking_backend": data.get("tracking_backend", "local"),
            "external_experiment_id": data.get("external_experiment_id"),
            "tags": data.get("tags", {}),
            "created_at": now,
            "updated_at": now,
        }
        self._experiments.append(record)
        return dict(record)

    async def list_experiments(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [dict(e) for e in self._experiments if e["tenant_id"] == tenant_id]
        items.sort(key=lambda e: e["created_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_experiment(
        self, tenant_id: int, experiment_id: int
    ) -> dict[str, Any] | None:
        for record in self._experiments:
            if record["tenant_id"] == tenant_id and record["id"] == experiment_id:
                return dict(record)
        return None

    async def update_experiment_tracking(
        self,
        tenant_id: int,
        experiment_id: int,
        *,
        tracking_backend: str,
        external_experiment_id: str | None,
    ) -> dict[str, Any] | None:
        for record in self._experiments:
            if record["tenant_id"] == tenant_id and record["id"] == experiment_id:
                record["tracking_backend"] = tracking_backend
                record["external_experiment_id"] = external_experiment_id
                record["updated_at"] = self._now()
                return dict(record)
        return None

    async def create_experiment_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("experiment_run"),
            "experiment_id": data["experiment_id"],
            "run_uuid": str(uuid4()),
            "run_name": data.get("run_name"),
            "status": data.get("status", "running"),
            "external_run_id": data.get("external_run_id"),
            "artifact_uri": data.get("artifact_uri"),
            "params": data.get("params", {}),
            "metrics": data.get("metrics", {}),
            "training_config": data.get("training_config", {}),
            "dataset_ref": data.get("dataset_ref", {}),
            "code_version": data.get("code_version"),
            "logged_by": data.get("logged_by"),
            "created_at": now,
            "finished_at": None,
        }
        self._runs.append(record)
        return dict(record)

    async def list_experiment_runs(
        self,
        tenant_id: int,
        *,
        experiment_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(r)
            for r in self._runs
            if r["tenant_id"] == tenant_id
            and (experiment_id is None or r["experiment_id"] == experiment_id)
        ]
        items.sort(key=lambda r: r["created_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_experiment_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None:
        for record in self._runs:
            if record["tenant_id"] == tenant_id and record["id"] == run_id:
                return dict(record)
        return None

    async def update_experiment_run(
        self, tenant_id: int, run_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for record in self._runs:
            if record["tenant_id"] == tenant_id and record["id"] == run_id:
                record.update(fields)
                return dict(record)
        return None

    async def create_ml_model_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for record in self._ml_models:
            if record["tenant_id"] == tenant_id and record["code"] == data["code"]:
                return dict(record)
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("ml_model"),
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "problem_type": data.get("problem_type", "classification"),
            "framework": data.get("framework", "scikit-learn"),
            "task": data.get("task"),
            "stage": data.get("stage", "none"),
            "created_at": now,
            "updated_at": now,
        }
        self._ml_models.append(record)
        return dict(record)

    async def list_ml_models(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [dict(m) for m in self._ml_models if m["tenant_id"] == tenant_id]
        items.sort(key=lambda m: m["created_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_ml_model(self, tenant_id: int, model_id: int) -> dict[str, Any] | None:
        for record in self._ml_models:
            if record["tenant_id"] == tenant_id and record["id"] == model_id:
                return dict(record)
        return None

    async def set_ml_model_stage(
        self, tenant_id: int, model_id: int, stage: str
    ) -> dict[str, Any] | None:
        for record in self._ml_models:
            if record["tenant_id"] == tenant_id and record["id"] == model_id:
                record["stage"] = stage
                record["updated_at"] = self._now()
                return dict(record)
        return None

    async def create_ml_model_version(
        self, tenant_id: int, model_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        existing = [
            v
            for v in self._ml_versions
            if v["tenant_id"] == tenant_id and v["ml_model_id"] == model_id
        ]
        version = max((v["version"] for v in existing), default=0) + 1
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("ml_model_version"),
            "ml_model_id": model_id,
            "version": version,
            "run_id": data.get("run_id"),
            "status": data.get("status", "staging"),
            "framework": data.get("framework"),
            "metrics": data.get("metrics", {}),
            "parameters": data.get("parameters", {}),
            "validation": data.get("validation", {}),
            "artifact_uri": data.get("artifact_uri"),
            "external_model_version": data.get("external_model_version"),
            "created_at": self._now(),
        }
        self._ml_versions.append(record)
        return dict(record)

    async def list_ml_model_versions(
        self, tenant_id: int, model_id: int
    ) -> list[dict[str, Any]]:
        items = [
            dict(v)
            for v in self._ml_versions
            if v["tenant_id"] == tenant_id and v["ml_model_id"] == model_id
        ]
        items.sort(key=lambda v: v["version"], reverse=True)
        return items

    async def get_ml_model_version(
        self, tenant_id: int, model_id: int, version: int
    ) -> dict[str, Any] | None:
        for record in self._ml_versions:
            if (
                record["tenant_id"] == tenant_id
                and record["ml_model_id"] == model_id
                and record["version"] == version
            ):
                return dict(record)
        return None

    async def update_ml_model_version(
        self, tenant_id: int, model_id: int, version: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for record in self._ml_versions:
            if (
                record["tenant_id"] == tenant_id
                and record["ml_model_id"] == model_id
                and record["version"] == version
            ):
                record.update(fields)
                return dict(record)
        return None

    async def create_evaluation_if_absent(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for record in self._evaluations:
            if record["tenant_id"] == tenant_id and record["code"] == data["code"]:
                return dict(record)
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("evaluation"),
            "code": data["code"],
            "name": data["name"],
            "kind": data.get("kind", "retrieval"),
            "config": data.get("config", {}),
            "created_at": self._now(),
        }
        self._evaluations.append(record)
        return dict(record)

    async def list_evaluations(
        self, tenant_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [dict(e) for e in self._evaluations if e["tenant_id"] == tenant_id]
        items.sort(key=lambda e: e["created_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_evaluation(
        self, tenant_id: int, evaluation_id: int
    ) -> dict[str, Any] | None:
        for record in self._evaluations:
            if record["tenant_id"] == tenant_id and record["id"] == evaluation_id:
                return dict(record)
        return None

    async def record_evaluation_result(
        self, tenant_id: int, evaluation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("evaluation_result"),
            "evaluation_id": evaluation_id,
            "case_id": data["case_id"],
            "metrics": data.get("metrics", {}),
            "passed": data.get("passed"),
            "created_at": self._now(),
        }
        self._evaluation_results.append(record)
        return dict(record)

    async def list_evaluation_results(
        self, tenant_id: int, evaluation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(r)
            for r in self._evaluation_results
            if r["tenant_id"] == tenant_id and r["evaluation_id"] == evaluation_id
        ]
        items.sort(key=lambda r: r["created_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    # --- Assistant conversations (Stage 3) ------------------------------
    async def create_conversation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "id": self._next_id("conversation"),
            "tenant_id": tenant_id,
            "actor_id": data.get("actor_id"),
            "title": data.get("title"),
            "status": "active",
            "metadata": data.get("metadata", {}),
            "created_at": now,
            "updated_at": now,
        }
        self._conversations.append(record)
        return dict(record)

    async def list_conversations(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(c)
            for c in self._conversations
            if c["tenant_id"] == tenant_id
            and c["status"] != "deleted"
            and (actor_id is None or c["actor_id"] == actor_id)
        ]
        items.sort(key=lambda c: c["updated_at"], reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_conversation(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None:
        for record in self._conversations:
            if (
                record["tenant_id"] == tenant_id
                and record["id"] == conversation_id
                and record["status"] != "deleted"
            ):
                return dict(record)
        return None

    async def delete_conversation(self, tenant_id: int, conversation_id: int) -> bool:
        for record in self._conversations:
            if (
                record["tenant_id"] == tenant_id
                and record["id"] == conversation_id
                and record["status"] != "deleted"
            ):
                record["status"] = "deleted"
                record["deleted_at"] = self._now()
                record["updated_at"] = self._now()
                return True
        return False

    async def touch_conversation(self, tenant_id: int, conversation_id: int) -> None:
        for record in self._conversations:
            if record["tenant_id"] == tenant_id and record["id"] == conversation_id:
                record["updated_at"] = self._now()
                return

    async def update_conversation(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        for record in self._conversations:
            if (
                record["tenant_id"] == tenant_id
                and record["id"] == conversation_id
                and record["status"] != "deleted"
            ):
                if data.get("title") is not None:
                    record["title"] = data["title"]
                if data.get("status") is not None:
                    record["status"] = data["status"]
                if data.get("metadata") is not None:
                    record["metadata"] = data["metadata"]
                record["updated_at"] = self._now()
                return dict(record)
        return None

    async def add_message(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("message"),
            "tenant_id": tenant_id,
            "conversation_id": conversation_id,
            "role": data["role"],
            "content": data.get("content", ""),
            "answer_status": data.get("answer_status"),
            "warnings": list(data.get("warnings") or []),
            "citations_required": bool(data.get("citations_required", False)),
            "citation_status": data.get("citation_status"),
            "confidence": data.get("confidence"),
            "is_mock": data.get("is_mock"),
            "model_code": data.get("model_code"),
            "provider_code": data.get("provider_code"),
            "token_usage": data.get("token_usage", {}),
            "latency_ms": data.get("latency_ms"),
            "execution_id": data.get("execution_id"),
            "request_id": data.get("request_id"),
            "error": data.get("error"),
            "task_type": data.get("task_type"),
            "generation_status": data.get("generation_status") or "completed",
            "prompt_version": data.get("prompt_version"),
            "parent_message_id": data.get("parent_message_id"),
            "cancelled_at": data.get("cancelled_at"),
            "created_at": self._now(),
        }
        self._messages.append(record)
        return dict(record)

    async def update_message(
        self, tenant_id: int, message_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        for record in self._messages:
            if record["tenant_id"] == tenant_id and record["id"] == message_id:
                for field in (
                    "content",
                    "answer_status",
                    "warnings",
                    "citations_required",
                    "citation_status",
                    "confidence",
                    "token_usage",
                    "latency_ms",
                    "error",
                    "generation_status",
                ):
                    if data.get(field) is not None:
                        record[field] = data[field]
                if data.get("generation_status") == "cancelled":
                    record["cancelled_at"] = record.get("cancelled_at") or self._now()
                return dict(record)
        return None

    async def list_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(m)
            for m in self._messages
            if m["tenant_id"] == tenant_id
            and m["conversation_id"] == conversation_id
        ]
        items.sort(key=lambda m: (m["created_at"], m["id"]))
        return items[offset : offset + limit], len(items)

    async def list_recent_messages(
        self, tenant_id: int, conversation_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        items = [
            dict(m)
            for m in self._messages
            if m["tenant_id"] == tenant_id
            and m["conversation_id"] == conversation_id
        ]
        items.sort(key=lambda m: (m["created_at"], m["id"]))
        return items[-limit:] if limit else []

    async def add_message_sources(
        self, tenant_id: int, message_id: int, sources: list[dict[str, Any]]
    ) -> None:
        existing = {
            s["rank"]
            for s in self._message_sources
            if s["tenant_id"] == tenant_id and s["message_id"] == message_id
        }
        for source in sources:
            rank = source["rank"]
            if rank in existing:
                continue
            existing.add(rank)
            self._message_sources.append(
                {
                    "id": self._next_id("message_source"),
                    "tenant_id": tenant_id,
                    "message_id": message_id,
                    "rank": rank,
                    "source_id": source.get("source_id"),
                    "document_id": source.get("document_id"),
                    "chunk_id": source.get("chunk_id"),
                    "source_code": source.get("source_code"),
                    "chunk_index": source.get("chunk_index"),
                    "page": source.get("page"),
                    "section": source.get("section"),
                    "score": source.get("score"),
                    "snippet": source.get("snippet"),
                }
            )

    async def get_message_sources(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        items = [
            dict(s)
            for s in self._message_sources
            if s["tenant_id"] == tenant_id and s["message_id"] == message_id
        ]
        items.sort(key=lambda s: s["rank"])
        return items

    async def get_message(
        self, tenant_id: int, message_id: int
    ) -> dict[str, Any] | None:
        for message in self._messages:
            if message["tenant_id"] == tenant_id and message["id"] == message_id:
                return dict(message)
        return None

    async def add_context_refs(
        self, tenant_id: int, message_id: int, refs: list[dict[str, Any]]
    ) -> None:
        message = next(
            (
                m
                for m in self._messages
                if m["tenant_id"] == tenant_id and m["id"] == message_id
            ),
            None,
        )
        if message is None:
            return
        for ref in refs:
            existing = next(
                (
                    r
                    for r in self._context_refs
                    if r["tenant_id"] == tenant_id
                    and r["message_id"] == message_id
                    and r["context_type"] == ref["context_type"]
                    and r["object_id"] == ref["object_id"]
                ),
                None,
            )
            payload = {
                "tenant_id": tenant_id,
                "conversation_id": message["conversation_id"],
                "message_id": message_id,
                "context_type": ref["context_type"],
                "object_id": ref["object_id"],
                "display_name": ref.get("display_name"),
                "source_system": ref.get("source_system"),
                "revision": ref.get("revision"),
                "lifecycle_state": ref.get("lifecycle_state"),
                "metadata": ref.get("metadata", {}),
                "provenance": ref.get("provenance", {}),
            }
            if existing is not None:
                existing.update(payload)
            else:
                self._context_refs.append(
                    {"id": self._next_id("context_ref"), **payload, "created_at": self._now()}
                )

    async def list_context_refs(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        items = [
            dict(r)
            for r in self._context_refs
            if r["tenant_id"] == tenant_id and r["message_id"] == message_id
        ]
        items.sort(key=lambda r: r["id"])
        return items

    async def get_conversation_summary(
        self, tenant_id: int, conversation_id: int
    ) -> dict[str, Any] | None:
        record = self._conversation_summaries.get(conversation_id)
        if record is None or record["tenant_id"] != tenant_id:
            return None
        return dict(record)

    async def upsert_conversation_summary(
        self, tenant_id: int, conversation_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        existing = self._conversation_summaries.get(conversation_id)
        record = {
            "tenant_id": tenant_id,
            "conversation_id": conversation_id,
            "summary": data["summary"],
            "through_message_id": data.get("through_message_id"),
            "token_estimate": data.get("token_estimate"),
            "created_at": existing["created_at"] if existing else now,
            "updated_at": now,
        }
        self._conversation_summaries[conversation_id] = record
        return dict(record)

    # --- Copilot tool trace + controlled actions (Stage 5) -------------
    async def record_copilot_tool_invocation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("copilot_tool_invocation"),
            "tenant_id": tenant_id,
            "conversation_id": data.get("conversation_id"),
            "message_id": data.get("message_id"),
            "tool_code": data["tool_code"],
            "status": data.get("status") or "succeeded",
            "read_only": bool(data.get("read_only", True)),
            "arguments": dict(data.get("arguments") or {}),
            "result_summary": dict(data.get("result_summary") or {}),
            "error_class": data.get("error_class"),
            "duration_ms": data.get("duration_ms"),
            "request_id": data.get("request_id"),
            "created_at": self._now(),
        }
        self._copilot_tool_invocations.append(record)
        return dict(record)

    async def list_copilot_tool_invocations(
        self, tenant_id: int, message_id: int
    ) -> list[dict[str, Any]]:
        items = [
            dict(row)
            for row in self._copilot_tool_invocations
            if row["tenant_id"] == tenant_id and row["message_id"] == message_id
        ]
        items.sort(key=lambda row: row["id"])
        return items

    async def create_copilot_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if (
                row["tenant_id"] == tenant_id
                and row["operation_hash"] == data["operation_hash"]
            ):
                return None
        now = self._now()
        record = {
            "id": self._next_id("copilot_action"),
            "tenant_id": tenant_id,
            "conversation_id": data.get("conversation_id"),
            "message_id": data.get("message_id"),
            "action_type": data["action_type"],
            "target": data.get("target"),
            "summary": data["summary"],
            "arguments": dict(data.get("arguments") or {}),
            "expected_effect": data.get("expected_effect"),
            "evidence": list(data.get("evidence") or []),
            "operation_hash": data["operation_hash"],
            "risk_class": data.get("risk_class") or "controlled_mutation",
            "status": "proposed",
            "requested_by": data.get("requested_by"),
            "requested_by_name": data.get("requested_by_name"),
            "approved_by": None,
            "approved_by_name": None,
            "decision_reason": None,
            "decided_at": None,
            "executed_by": None,
            "executed_by_name": None,
            "executed_at": None,
            "result": {},
            "error_class": None,
            "request_id": data.get("request_id"),
            "expires_at": data.get("expires_at"),
            "created_at": now,
            "updated_at": now,
        }
        self._copilot_actions.append(record)
        return dict(record)

    async def get_copilot_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if row["tenant_id"] == tenant_id and row["id"] == action_id:
                return dict(row)
        return None

    async def get_copilot_action_by_hash(
        self, tenant_id: int, operation_hash: str
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if row["tenant_id"] == tenant_id and row["operation_hash"] == operation_hash:
                return dict(row)
        return None

    async def list_copilot_actions(
        self,
        tenant_id: int,
        *,
        status: str | None,
        conversation_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            dict(row)
            for row in self._copilot_actions
            if row["tenant_id"] == tenant_id
            and (status is None or row["status"] == status)
            and (conversation_id is None or row["conversation_id"] == conversation_id)
        ]
        rows.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
        return rows[offset : offset + limit], len(rows)

    async def decide_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == action_id
                and row["status"] == "proposed"
            ):
                row.update(
                    {
                        "status": status,
                        "approved_by": reviewer_actor_id,
                        "approved_by_name": reviewer_name,
                        "decision_reason": reason,
                        "decided_at": self._now(),
                        "updated_at": self._now(),
                    }
                )
                return dict(row)
        return None

    async def claim_copilot_action_execution(
        self,
        tenant_id: int,
        action_id: int,
        *,
        executor_actor_id: int | None,
        executor_name: str | None,
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == action_id
                and row["status"] == "approved"
                and row.get("executed_by") is None
            ):
                row.update(
                    {
                        "executed_by": executor_actor_id,
                        "executed_by_name": executor_name,
                        "executed_at": self._now(),
                        "updated_at": self._now(),
                    }
                )
                return dict(row)
        return None

    async def complete_copilot_action(
        self,
        tenant_id: int,
        action_id: int,
        *,
        status: str,
        result: dict[str, Any],
        error_class: str | None,
    ) -> dict[str, Any] | None:
        for row in self._copilot_actions:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == action_id
                and row["status"] == "approved"
            ):
                row.update(
                    {
                        "status": status,
                        "result": dict(result or {}),
                        "error_class": error_class,
                        "updated_at": self._now(),
                    }
                )
                return dict(row)
        return None

    # --- Enterprise search: saved searches + history (Stage 4) ----------
    @staticmethod
    def _owned(record: dict[str, Any], tenant_id: int, actor_id: int | None) -> bool:
        return record["tenant_id"] == tenant_id and record.get("actor_id") == actor_id

    async def create_saved_search(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "id": self._next_id("saved_search"),
            "tenant_id": tenant_id,
            "actor_id": data.get("actor_id"),
            "name": data["name"],
            "query": data["query"],
            "mode": data.get("mode", "hybrid"),
            "filters": data.get("filters", []),
            "sort": data.get("sort", "relevance"),
            "metadata": data.get("metadata", {}),
            "created_at": now,
            "updated_at": now,
        }
        self._saved_searches.append(record)
        return dict(record)

    async def list_saved_searches(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(s)
            for s in self._saved_searches
            if self._owned(s, tenant_id, actor_id)
        ]
        items.sort(key=lambda s: (s["updated_at"], s["id"]), reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> dict[str, Any] | None:
        for record in self._saved_searches:
            if record["id"] == saved_id and self._owned(record, tenant_id, actor_id):
                return dict(record)
        return None

    async def delete_saved_search(
        self, tenant_id: int, saved_id: int, actor_id: int | None
    ) -> bool:
        for i, record in enumerate(self._saved_searches):
            if record["id"] == saved_id and self._owned(record, tenant_id, actor_id):
                self._saved_searches.pop(i)
                return True
        return False

    async def record_search_history(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("search_history"),
            "tenant_id": tenant_id,
            "actor_id": data.get("actor_id"),
            "query": data["query"],
            "mode": data.get("mode", "hybrid"),
            "filters": data.get("filters", []),
            "sort": data.get("sort", "relevance"),
            "result_count": data.get("result_count", 0),
            "fallback": data.get("fallback", False),
            "created_at": self._now(),
        }
        self._search_history.append(record)
        return dict(record)

    async def list_search_history(
        self, tenant_id: int, actor_id: int | None, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(h)
            for h in self._search_history
            if self._owned(h, tenant_id, actor_id)
        ]
        items.sort(key=lambda h: (h["created_at"], h["id"]), reverse=True)
        return items[offset : offset + limit], len(items)

    async def delete_search_history(
        self, tenant_id: int, history_id: int, actor_id: int | None
    ) -> bool:
        for i, record in enumerate(self._search_history):
            if record["id"] == history_id and self._owned(record, tenant_id, actor_id):
                self._search_history.pop(i)
                return True
        return False

    async def clear_search_history(self, tenant_id: int, actor_id: int | None) -> int:
        keep = [
            h for h in self._search_history if not self._owned(h, tenant_id, actor_id)
        ]
        removed = len(self._search_history) - len(keep)
        self._search_history = keep
        return removed

    # --- Enterprise search: index health + reconciliation (Stage 4) -----
    @staticmethod
    def _is_problem(doc: dict[str, Any]) -> bool:
        if doc.get("status") in ("stale", "failed", "pending", "indexing"):
            return True
        if doc.get("error_class") is not None:
            return True
        return doc.get("status") == "indexed" and doc.get("search_indexed_at") is None

    async def search_index_stats(self, tenant_id: int) -> dict[str, Any]:
        docs = [d for d in self._documents if d["tenant_id"] == tenant_id]
        chunks = [c for c in self._chunks if c["tenant_id"] == tenant_id]
        embeddings = [e for e in self._embeddings if e["tenant_id"] == tenant_id]
        jobs = [
            j for j in self._jobs if j["tenant_id"] == tenant_id and j["type"] == "index"
        ]
        job_counts: dict[str, int] = {}
        for job in jobs:
            job_counts[job["status"]] = job_counts.get(job["status"], 0) + 1
        stamps = [
            d.get("search_indexed_at") or d.get("indexed_at")
            for d in docs
            if d.get("search_indexed_at") or d.get("indexed_at")
        ]
        return {
            "documents_total": len(docs),
            "documents_indexed": sum(
                1
                for d in docs
                if d.get("status") == "indexed"
                and d.get("search_indexed_at") is not None
                and d.get("error_class") is None
            ),
            "documents_pending": sum(
                1 for d in docs if d.get("status") in ("pending", "indexing")
            ),
            "documents_stale": sum(1 for d in docs if d.get("status") == "stale"),
            "documents_missing": sum(
                1
                for d in docs
                if d.get("status") == "indexed" and d.get("search_indexed_at") is None
            ),
            "documents_failed": sum(
                1
                for d in docs
                if d.get("status") == "failed" or d.get("error_class") is not None
            ),
            "chunks_total": len(chunks),
            "embeddings_total": len(embeddings),
            "jobs": job_counts,
            "last_indexed_at": max(stamps) if stamps else None,
        }

    async def search_index_status_by_source(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for source in self._sources:
            if source["tenant_id"] != tenant_id:
                continue
            docs = [
                d
                for d in self._documents
                if d["tenant_id"] == tenant_id and d["source_id"] == source["id"]
            ]
            result.append(
                {
                    "source_id": source["id"],
                    "source_code": source["code"],
                    "source_status": source["status"],
                    "documents_total": len(docs),
                    "indexed": sum(
                        1
                        for d in docs
                        if d.get("status") == "indexed"
                        and d.get("search_indexed_at") is not None
                        and d.get("error_class") is None
                    ),
                    "pending": sum(
                        1 for d in docs if d.get("status") in ("pending", "indexing")
                    ),
                    "stale": sum(1 for d in docs if d.get("status") == "stale"),
                    "missing": sum(
                        1
                        for d in docs
                        if d.get("status") == "indexed"
                        and d.get("search_indexed_at") is None
                    ),
                    "failed": sum(
                        1
                        for d in docs
                        if d.get("status") == "failed" or d.get("error_class") is not None
                    ),
                }
            )
        return result

    async def list_problem_documents(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        codes = {s["id"]: s["code"] for s in self._sources}
        docs = [
            d
            for d in self._documents
            if d["tenant_id"] == tenant_id and self._is_problem(d)
        ]
        docs.sort(key=lambda d: (d.get("updated_at") or d.get("created_at"), d["id"]), reverse=True)
        return [
            {
                "document_id": d["id"],
                "source_id": d["source_id"],
                "external_id": d["external_id"],
                "title": d.get("title"),
                "status": d.get("status"),
                "search_indexed_at": d.get("search_indexed_at"),
                "indexed_at": d.get("indexed_at"),
                "error_class": d.get("error_class"),
                "source_code": codes.get(d["source_id"]),
            }
            for d in docs[:limit]
        ]

    async def sources_needing_reindex(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        sources = {s["id"]: s for s in self._sources}
        source_ids = sorted(
            {
                d["source_id"]
                for d in self._documents
                if d["tenant_id"] == tenant_id and self._is_problem(d)
            }
        )
        return [
            {
                "source_id": sid,
                "source_code": sources.get(sid, {}).get("code"),
                "source_status": sources.get(sid, {}).get("status"),
            }
            for sid in source_ids[:limit]
        ]

    # --- Enterprise search: duplicate/conflict findings (Stage 4/P5) -----
    async def list_documents_for_dedup(
        self, tenant_id: int, *, limit: int
    ) -> list[dict[str, Any]]:
        codes = {s["id"]: s["code"] for s in self._sources}
        docs = sorted(
            (d for d in self._documents if d["tenant_id"] == tenant_id),
            key=lambda d: d["id"],
        )
        return [
            {
                "id": d["id"],
                "source_id": d["source_id"],
                "external_id": d.get("external_id"),
                "title": d.get("title"),
                "checksum": d.get("checksum"),
                "status": d.get("status"),
                "classification": d.get("classification"),
                "created_at": d.get("created_at"),
                "source_code": codes.get(d["source_id"]),
            }
            for d in docs[:limit]
        ]

    async def upsert_duplicate_findings(
        self, tenant_id: int, findings: list[dict[str, Any]]
    ) -> dict[str, int]:
        created = updated = skipped = 0
        for finding in findings:
            existing = next(
                (
                    f
                    for f in self._duplicate_findings
                    if f["tenant_id"] == tenant_id
                    and f["dedupe_key"] == finding["dedupe_key"]
                ),
                None,
            )
            if existing is None:
                now = self._now()
                self._duplicate_findings.append(
                    {
                        "id": self._next_id("duplicate_finding"),
                        "tenant_id": tenant_id,
                        "dedupe_key": finding["dedupe_key"],
                        "kind": finding["kind"],
                        "match_type": finding["match_type"],
                        "confidence": finding["confidence"],
                        "document_a_id": finding["document_a_id"],
                        "document_b_id": finding["document_b_id"],
                        "evidence": finding.get("evidence", {}),
                        "status": "open",
                        "note": None,
                        "reviewed_by": None,
                        "reviewed_at": None,
                        "created_at": now,
                        "updated_at": now,
                    }
                )
                created += 1
            elif existing["status"] == "open":
                existing.update(
                    {
                        "kind": finding["kind"],
                        "match_type": finding["match_type"],
                        "confidence": finding["confidence"],
                        "evidence": finding.get("evidence", {}),
                        "updated_at": self._now(),
                    }
                )
                updated += 1
            else:
                skipped += 1
        return {"total": len(findings), "created": created, "updated": updated, "skipped": skipped}

    async def list_duplicate_findings(
        self,
        tenant_id: int,
        *,
        status: str | None,
        kind: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            dict(f)
            for f in self._duplicate_findings
            if f["tenant_id"] == tenant_id
            and (status is None or f["status"] == status)
            and (kind is None or f["kind"] == kind)
        ]
        items.sort(key=lambda f: (f["confidence"], f["id"]), reverse=True)
        return items[offset : offset + limit], len(items)

    async def get_duplicate_finding(
        self, tenant_id: int, finding_id: int
    ) -> dict[str, Any] | None:
        for finding in self._duplicate_findings:
            if finding["tenant_id"] == tenant_id and finding["id"] == finding_id:
                return dict(finding)
        return None

    async def update_duplicate_finding(
        self,
        tenant_id: int,
        finding_id: int,
        *,
        status: str,
        note: str | None,
        reviewed_by: int | None,
    ) -> dict[str, Any] | None:
        for finding in self._duplicate_findings:
            if finding["tenant_id"] == tenant_id and finding["id"] == finding_id:
                finding["status"] = status
                if note is not None:
                    finding["note"] = note
                finding["reviewed_by"] = reviewed_by
                finding["reviewed_at"] = self._now()
                finding["updated_at"] = self._now()
                return dict(finding)
        return None


    # --- Stage 6: agent catalog and immutable versions ------------------

    @staticmethod
    def _public_agent(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "code": record["code"],
            "name": record["name"],
            "description": record.get("description"),
            "kind": record.get("kind", "workflow"),
            "category": record.get("category"),
            "owner": record.get("owner"),
            "team": record.get("team"),
            "lifecycle_status": record.get("lifecycle_status", "published"),
            "current_version_id": record.get("current_version_id"),
            "enabled": bool(record.get("enabled", True)),
            "lock_version": int(record.get("lock_version", 1)),
            "duplicated_from_agent_id": record.get("duplicated_from_agent_id"),
            "suspended_at": record.get("suspended_at"),
            "archived_at": record.get("archived_at"),
            "deleted_at": record.get("deleted_at"),
            "working_config": record.get("working_config", {}),
            "created_by": record.get("created_by"),
            "updated_by": record.get("updated_by"),
            "created_at": record.get("created_at"),
            "updated_at": record.get("updated_at"),
        }

    @staticmethod
    def _public_agent_version(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "agent_id": record["agent_id"],
            "version": record["version"],
            "definition": record.get("definition", {}),
            "status": record.get("status", "draft"),
            "validation": record.get("validation", {}),
            "config_hash": record.get("config_hash"),
            "published_at": record.get("published_at"),
            "published_by": record.get("published_by"),
            "created_by": record.get("created_by"),
            "lock_version": int(record.get("lock_version", 1)),
            "created_at": record.get("created_at"),
        }

    async def list_agent_catalog(
        self,
        tenant_id: int,
        *,
        query: str | None,
        lifecycle_status: str | None,
        category: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            a
            for a in self._agents
            if a["tenant_id"] == tenant_id and a.get("deleted_at") is None
        ]
        if lifecycle_status:
            rows = [a for a in rows if a.get("lifecycle_status", "published") == lifecycle_status]
        if category:
            rows = [a for a in rows if a.get("category") == category]
        if query:
            needle = query.lower()
            rows = [
                a
                for a in rows
                if needle in str(a.get("code", "")).lower()
                or needle in str(a.get("name", "")).lower()
                or needle in str(a.get("description") or "").lower()
            ]
        rows = sorted(rows, key=lambda a: (a.get("name") or a["code"]).lower())
        return [self._public_agent(a) for a in rows[offset : offset + limit]], len(rows)

    async def create_agent(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        if any(a["tenant_id"] == tenant_id and a["code"] == data["code"] for a in self._agents):
            from ai_api.domain.errors import ConflictError

            raise ConflictError("agent code already exists", details={"code": data["code"]})
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent"),
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "kind": data.get("kind", "workflow"),
            "category": data.get("category"),
            "owner": data.get("owner"),
            "team": data.get("team"),
            "lifecycle_status": data.get("lifecycle_status", "draft"),
            "current_version_id": None,
            "enabled": bool(data.get("enabled", False)),
            "config": data.get("config", {}),
            "created_by": data.get("created_by"),
            "updated_by": data.get("created_by"),
            "lock_version": 1,
            "duplicated_from_agent_id": data.get("duplicated_from_agent_id"),
            "suspended_at": None,
            "archived_at": None,
            "deleted_at": None,
            "working_config": data.get("working_config", {}),
            "created_at": now,
            "updated_at": now,
        }
        self._agents.append(record)
        return self._public_agent(record)

    async def update_agent_draft(
        self,
        tenant_id: int,
        agent_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        for agent in self._agents:
            if agent["tenant_id"] != tenant_id or agent["id"] != agent_id:
                continue
            if int(agent.get("lock_version", 1)) != expected_lock:
                return None
            for key in ("name", "description", "category", "owner", "team", "kind"):
                if key in fields:
                    agent[key] = fields[key]
            agent["updated_by"] = fields.get("updated_by")
            agent["lock_version"] += 1
            agent["updated_at"] = self._now()
            return self._public_agent(agent)
        return None

    async def set_agent_lifecycle(
        self,
        tenant_id: int,
        agent_id: int,
        *,
        lifecycle_status: str,
        enabled: bool,
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        for agent in self._agents:
            if agent["tenant_id"] == tenant_id and agent["id"] == agent_id:
                agent["lifecycle_status"] = lifecycle_status
                agent["enabled"] = enabled
                agent["updated_by"] = updated_by
                agent["lock_version"] += 1
                agent["updated_at"] = self._now()
                return self._public_agent(agent)
        return None

    async def create_agent_version(
        self, tenant_id: int, agent_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        agent = next(
            (a for a in self._agents if a["tenant_id"] == tenant_id and a["id"] == agent_id),
            None,
        )
        if agent is None:
            from ai_api.domain.errors import NotFoundError

            raise NotFoundError("agent not found", details={"agent_id": agent_id})
        version_number = data.get("version")
        if version_number is None:
            existing = [
                v["version"] for v in self._agent_versions if v["agent_id"] == agent_id
            ]
            version_number = max(existing, default=0) + 1
        if any(
            v["agent_id"] == agent_id and v["version"] == version_number
            for v in self._agent_versions
        ):
            from ai_api.domain.errors import ConflictError

            raise ConflictError("agent version already exists")
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_version"),
            "agent_id": agent_id,
            "version": version_number,
            "definition": data.get("definition", {}),
            "status": data.get("status", "draft"),
            "validation": data.get("validation", {}),
            "config_hash": data.get("config_hash"),
            "published_at": data.get("published_at"),
            "published_by": data.get("published_by"),
            "created_by": data.get("created_by"),
            "lock_version": 1,
            "created_at": self._now(),
        }
        self._agent_versions.append(record)
        return self._public_agent_version(record)

    async def update_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        for version in self._agent_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["agent_id"] == agent_id
                and version["id"] == version_id
            ):
                if version.get("status") not in ("draft", "validating"):
                    return None
                if int(version.get("lock_version", 1)) != expected_lock:
                    return None
                for key in ("definition", "validation", "status"):
                    if key in fields:
                        version[key] = fields[key]
                version["lock_version"] += 1
                return self._public_agent_version(version)
        return None

    async def get_agent_version(
        self, tenant_id: int, agent_id: int, version_id: int
    ) -> dict[str, Any] | None:
        for version in self._agent_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["agent_id"] == agent_id
                and version["id"] == version_id
            ):
                return self._public_agent_version(version)
        return None

    async def publish_agent_version(
        self,
        tenant_id: int,
        agent_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        tool_links: list[dict[str, Any]],
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        published = None
        for version in self._agent_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["agent_id"] == agent_id
                and version["id"] == version_id
            ):
                if version.get("status") not in ("draft", "validating"):
                    return None
                version["status"] = "published"
                version["validation"] = fields.get("validation", version.get("validation", {}))
                version["config_hash"] = fields.get("config_hash")
                version["published_at"] = self._now()
                version["published_by"] = updated_by
                published = self._public_agent_version(version)
                break
        if published is None:
            return None
        self._agent_version_tools = [
            link for link in self._agent_version_tools if link["agent_version_id"] != version_id
        ]
        for link in tool_links:
            self._agent_version_tools.append(
                {
                    "tenant_id": tenant_id,
                    "id": self._next_id("agent_version_tool"),
                    "agent_version_id": version_id,
                    **link,
                    "created_at": self._now(),
                }
            )
        for agent in self._agents:
            if agent["tenant_id"] == tenant_id and agent["id"] == agent_id:
                was_disabled = agent.get("lifecycle_status") == "disabled"
                agent["current_version_id"] = version_id
                agent["lifecycle_status"] = "disabled" if was_disabled else "published"
                agent["enabled"] = not was_disabled
                agent["updated_by"] = updated_by
                agent["lock_version"] += 1
                agent["updated_at"] = self._now()
                break
        return published

    async def set_agent_current_version(
        self, tenant_id: int, agent_id: int, version_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        version = await self.get_agent_version(tenant_id, agent_id, version_id)
        if version is None or version["status"] not in ("published", "active"):
            return None
        for agent in self._agents:
            if agent["tenant_id"] == tenant_id and agent["id"] == agent_id:
                was_disabled = agent.get("lifecycle_status") == "disabled"
                agent["current_version_id"] = version_id
                agent["lifecycle_status"] = "disabled" if was_disabled else "published"
                agent["enabled"] = not was_disabled
                agent["updated_by"] = updated_by
                agent["lock_version"] += 1
                agent["updated_at"] = self._now()
                return self._public_agent(agent)
        return None

    async def list_agent_version_tools(
        self, tenant_id: int, agent_version_id: int
    ) -> list[dict[str, Any]]:
        return [
            dict(link)
            for link in self._agent_version_tools
            if link["tenant_id"] == tenant_id
            and link["agent_version_id"] == agent_version_id
        ]

    # --- Stage 6: persisted tool registry -------------------------------

    @staticmethod
    def _public_tool(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "code": record["code"],
            "name": record["name"],
            "description": record.get("description"),
            "category": record.get("category"),
            "owner": record.get("owner"),
            "enabled": bool(record.get("enabled", True)),
            "lifecycle_status": record.get("lifecycle_status", "draft"),
            "current_version_id": record.get("current_version_id"),
            "lock_version": int(record.get("lock_version", 1)),
            "created_at": record.get("created_at"),
            "updated_at": record.get("updated_at"),
        }

    @staticmethod
    def _public_tool_version(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "tool_id": record["tool_id"],
            "version": record["version"],
            "definition": record.get("definition", {}),
            "status": record.get("status", "draft"),
            "validation": record.get("validation", {}),
            "config_hash": record.get("config_hash"),
            "published_at": record.get("published_at"),
            "published_by": record.get("published_by"),
            "created_at": record.get("created_at"),
        }

    async def list_agent_tools(
        self,
        tenant_id: int,
        *,
        query: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [t for t in self._agent_tools if t["tenant_id"] == tenant_id]
        if enabled is not None:
            rows = [t for t in rows if bool(t.get("enabled", True)) is enabled]
        if query:
            needle = query.lower()
            rows = [
                t
                for t in rows
                if needle in str(t.get("code", "")).lower()
                or needle in str(t.get("name", "")).lower()
            ]
        rows = sorted(rows, key=lambda t: t["code"])
        return [self._public_tool(t) for t in rows[offset : offset + limit]], len(rows)

    async def create_agent_tool(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        if any(
            t["tenant_id"] == tenant_id and t["code"] == data["code"]
            for t in self._agent_tools
        ):
            from ai_api.domain.errors import ConflictError

            raise ConflictError("tool code already exists", details={"code": data["code"]})
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_tool"),
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "category": data.get("category"),
            "owner": data.get("owner"),
            "enabled": bool(data.get("enabled", True)),
            "lifecycle_status": data.get("lifecycle_status", "draft"),
            "current_version_id": None,
            "created_by": data.get("created_by"),
            "updated_by": data.get("created_by"),
            "lock_version": 1,
            "created_at": now,
            "updated_at": now,
        }
        self._agent_tools.append(record)
        return self._public_tool(record)

    async def get_agent_tool(self, tenant_id: int, tool_id: int) -> dict[str, Any] | None:
        for tool in self._agent_tools:
            if tool["tenant_id"] == tenant_id and tool["id"] == tool_id:
                return self._public_tool(tool)
        return None

    async def update_agent_tool(
        self,
        tenant_id: int,
        tool_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        for tool in self._agent_tools:
            if tool["tenant_id"] == tenant_id and tool["id"] == tool_id:
                if int(tool.get("lock_version", 1)) != expected_lock:
                    return None
                for key in ("name", "description", "category", "owner", "enabled"):
                    if key in fields:
                        tool[key] = fields[key]
                tool["updated_by"] = fields.get("updated_by")
                tool["lock_version"] += 1
                tool["updated_at"] = self._now()
                return self._public_tool(tool)
        return None

    async def create_agent_tool_version(
        self, tenant_id: int, tool_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        if not await self.get_agent_tool(tenant_id, tool_id):
            from ai_api.domain.errors import NotFoundError

            raise NotFoundError("tool not found", details={"tool_id": tool_id})
        version_number = data.get("version")
        if version_number is None:
            existing = [
                v["version"] for v in self._agent_tool_versions if v["tool_id"] == tool_id
            ]
            version_number = max(existing, default=0) + 1
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_tool_version"),
            "tool_id": tool_id,
            "version": version_number,
            "definition": data.get("definition", {}),
            "status": data.get("status", "draft"),
            "validation": data.get("validation", {}),
            "config_hash": data.get("config_hash"),
            "published_at": data.get("published_at"),
            "published_by": data.get("published_by"),
            "created_by": data.get("created_by"),
            "created_at": self._now(),
        }
        self._agent_tool_versions.append(record)
        return self._public_tool_version(record)

    async def get_agent_tool_version(
        self, tenant_id: int, tool_id: int, version_id: int
    ) -> dict[str, Any] | None:
        for version in self._agent_tool_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["tool_id"] == tool_id
                and version["id"] == version_id
            ):
                return self._public_tool_version(version)
        return None

    async def list_agent_tool_versions(
        self, tenant_id: int, tool_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            v
            for v in self._agent_tool_versions
            if v["tenant_id"] == tenant_id and v["tool_id"] == tool_id
        ]
        return [
            self._public_tool_version(v)
            for v in sorted(rows, key=lambda v: v["version"], reverse=True)
        ]

    async def update_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        fields: dict[str, Any],
        *,
        expected_lock: int,
    ) -> dict[str, Any] | None:
        for version in self._agent_tool_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["tool_id"] == tool_id
                and version["id"] == version_id
            ):
                if version.get("status") not in ("draft", "validating"):
                    return None
                for key in ("definition", "validation", "status", "config_hash"):
                    if key in fields:
                        version[key] = fields[key]
                return self._public_tool_version(version)
        return None

    async def publish_agent_tool_version(
        self,
        tenant_id: int,
        tool_id: int,
        version_id: int,
        *,
        fields: dict[str, Any],
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        published = None
        for version in self._agent_tool_versions:
            if (
                version["tenant_id"] == tenant_id
                and version["tool_id"] == tool_id
                and version["id"] == version_id
            ):
                if version.get("status") not in ("draft", "validating"):
                    return None
                version["status"] = "published"
                version["validation"] = fields.get("validation", {})
                version["config_hash"] = fields.get("config_hash")
                version["published_at"] = self._now()
                version["published_by"] = updated_by
                published = self._public_tool_version(version)
                break
        if published is None:
            return None
        for tool in self._agent_tools:
            if tool["tenant_id"] == tenant_id and tool["id"] == tool_id:
                tool["current_version_id"] = version_id
                tool["lifecycle_status"] = "published"
                tool["enabled"] = True
                tool["updated_by"] = updated_by
                tool["lock_version"] += 1
                tool["updated_at"] = self._now()
                break
        return published

    # --- Stage 6: durable agent execution ------------------------------

    async def create_agent_execution(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        key = data.get("idempotency_key")
        if key:
            for execution in self._executions:
                if (
                    execution["tenant_id"] == tenant_id
                    and execution.get("operation") == "agent"
                    and execution.get("idempotency_key") == key
                ):
                    return dict(execution)
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("execution"),
            "request_id": str(uuid4()),
            "actor_id": data.get("actor_id"),
            "agent_id": data["agent_id"],
            "agent_version_id": data.get("agent_version_id"),
            "parent_execution_id": data.get("parent_execution_id"),
            "model_id": None,
            "operation": "agent",
            "status": data.get("status", "queued"),
            "idempotency_key": key,
            "plan": data.get("plan", {}),
            "budgets": data.get("budgets", {}),
            "current_step": None,
            "step_count": 0,
            "tool_call_count": 0,
            "model_call_count": 0,
            "input": data.get("input", {}),
            "input_snapshot": data.get("input_snapshot"),
            "input_hash": data.get("input_hash"),
            "output": None,
            "output_snapshot": None,
            "error": None,
            "latency_ms": None,
            "token_usage": {},
            "cancel_requested_at": None,
            "lease_owner": None,
            "lease_expires_at": None,
            "lease_generation": 0,
            "started_at": None,
            "completed_at": None,
            "state_version": 0,
            "schedule_id": data.get("schedule_id"),
            "schedule_run_key": data.get("schedule_run_key"),
            "memory_scope": data.get("memory_scope"),
            "delegation_depth": int(data.get("delegation_depth") or 0),
            "delegated_by_agent_id": data.get("delegated_by_agent_id"),
            "created_at": now,
        }
        self._executions.append(record)
        return dict(record)

    async def get_agent_execution(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        for execution in self._executions:
            if (
                execution["tenant_id"] == tenant_id
                and execution["id"] == execution_id
                and execution.get("operation") == "agent"
            ):
                return dict(execution)
        return None

    async def list_agent_executions(
        self,
        tenant_id: int,
        *,
        state: str | None,
        agent_id: int | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            e
            for e in self._executions
            if e["tenant_id"] == tenant_id and e.get("operation") == "agent"
        ]
        if state:
            rows = [e for e in rows if e["status"] == state]
        if agent_id is not None:
            rows = [e for e in rows if e.get("agent_id") == agent_id]
        rows = sorted(rows, key=lambda e: e["created_at"], reverse=True)
        return [dict(e) for e in rows[offset : offset + limit]], len(rows)

    async def update_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        expected_state: str | None,
        fields: dict[str, Any],
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        for execution in self._executions:
            if (
                execution["tenant_id"] == tenant_id
                and execution["id"] == execution_id
                and execution.get("operation") == "agent"
            ):
                if expected_state is not None and execution["status"] != expected_state:
                    return None
                if lease_owner is not None and execution.get("lease_owner") != lease_owner:
                    return None
                if lease_generation is not None and int(
                    execution.get("lease_generation") or 0
                ) != int(lease_generation):
                    return None
                execution.update(fields)
                execution["state_version"] = int(execution.get("state_version", 0)) + 1
                return dict(execution)
        return None

    async def claim_agent_execution(
        self, *, worker_id: str, lease_seconds: int
    ) -> dict[str, Any] | None:
        now = self._now()
        for execution in self._executions:
            if execution.get("operation") != "agent":
                continue
            queued = execution["status"] == "queued"
            expired = (
                execution["status"] == "running"
                and execution.get("lease_expires_at") is not None
                and execution["lease_expires_at"] < now
            )
            if not (queued or expired):
                continue
            from datetime import timedelta

            execution["status"] = "running"
            execution["lease_owner"] = worker_id
            execution["lease_expires_at"] = now + timedelta(seconds=lease_seconds)
            execution["lease_generation"] = int(execution.get("lease_generation") or 0) + 1
            execution["started_at"] = execution.get("started_at") or now
            execution["state_version"] = int(execution.get("state_version", 0)) + 1
            return dict(execution)
        return None

    async def start_agent_execution(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_seconds: int,
    ) -> dict[str, Any] | None:
        from datetime import timedelta

        for execution in self._executions:
            if (
                execution["tenant_id"] == tenant_id
                and execution["id"] == execution_id
                and execution.get("operation") == "agent"
                and execution["status"] == "queued"
            ):
                now = self._now()
                execution["status"] = "running"
                execution["lease_owner"] = worker_id
                execution["lease_expires_at"] = now + timedelta(seconds=lease_seconds)
                execution["lease_generation"] = int(
                    execution.get("lease_generation") or 0
                ) + 1
                execution["started_at"] = execution.get("started_at") or now
                execution["state_version"] = int(execution.get("state_version", 0)) + 1
                return dict(execution)
        return None

    async def renew_agent_execution_lease(
        self,
        tenant_id: int,
        execution_id: int,
        *,
        worker_id: str,
        lease_generation: int,
        lease_seconds: int,
    ) -> dict[str, Any] | None:
        from datetime import timedelta

        for execution in self._executions:
            if (
                execution["tenant_id"] == tenant_id
                and execution["id"] == execution_id
                and execution.get("operation") == "agent"
                and execution.get("lease_owner") == worker_id
                and int(execution.get("lease_generation") or 0) == int(lease_generation)
                and execution["status"] in ("running", "cancel_requested")
            ):
                execution["lease_expires_at"] = self._now() + timedelta(
                    seconds=lease_seconds
                )
                return dict(execution)
        return None

    def _fenced_execution(
        self,
        tenant_id: int,
        execution_id: int,
        lease_owner: str | None,
        lease_generation: int | None,
    ) -> dict[str, Any] | None:
        for execution in self._executions:
            if (
                execution["tenant_id"] == tenant_id
                and execution["id"] == execution_id
                and execution.get("operation") == "agent"
            ):
                if lease_owner is not None and execution.get("lease_owner") != lease_owner:
                    return None
                if lease_generation is not None and int(
                    execution.get("lease_generation") or 0
                ) != int(lease_generation):
                    return None
                return execution
        return None

    async def upsert_execution_step(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        if (lease_owner is not None or lease_generation is not None) and (
            self._fenced_execution(
                tenant_id, execution_id, lease_owner, lease_generation
            )
            is None
        ):
            return None
        for step in self._execution_steps:
            if (
                step["tenant_id"] == tenant_id
                and step["execution_id"] == execution_id
                and step["step_key"] == data["step_key"]
            ):
                step.update(data)
                return dict(step)
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("execution_step"),
            "execution_id": execution_id,
            "status": "pending",
            "attempts": 0,
            "max_attempts": 3,
            "input_summary": {},
            "output_summary": {},
            "error_class": None,
            "error_message": None,
            "started_at": None,
            "finished_at": None,
            "created_at": self._now(),
            **data,
        }
        self._execution_steps.append(record)
        return dict(record)

    async def list_execution_steps(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            s
            for s in self._execution_steps
            if s["tenant_id"] == tenant_id and s["execution_id"] == execution_id
        ]
        return [dict(s) for s in sorted(rows, key=lambda s: s["sequence"])]

    async def record_tool_invocation(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        if (lease_owner is not None or lease_generation is not None) and (
            self._fenced_execution(
                tenant_id, execution_id, lease_owner, lease_generation
            )
            is None
        ):
            return None
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("tool_invocation"),
            "execution_id": execution_id,
            "status": "running",
            "attempt": 1,
            "outcome_certainty": "certain",
            "arguments_summary": {},
            "result": None,
            "result_summary": {},
            "error_class": None,
            "error_message": None,
            "started_at": self._now(),
            "finished_at": None,
            **data,
        }
        self._tool_invocations.append(record)
        return dict(record)

    async def list_tool_invocations(
        self, tenant_id: int, execution_id: int
    ) -> list[dict[str, Any]]:
        return [
            dict(invocation)
            for invocation in self._tool_invocations
            if invocation["tenant_id"] == tenant_id
            and invocation["execution_id"] == execution_id
        ]

    async def latest_tool_invocation(
        self, tenant_id: int, execution_id: int, step_id: int
    ) -> dict[str, Any] | None:
        rows = [
            invocation
            for invocation in self._tool_invocations
            if invocation["tenant_id"] == tenant_id
            and invocation["execution_id"] == execution_id
            and invocation.get("step_id") == step_id
        ]
        if not rows:
            return None
        return dict(max(rows, key=lambda invocation: invocation["id"]))

    async def update_tool_invocation(
        self,
        tenant_id: int,
        invocation_id: int,
        fields: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        for invocation in self._tool_invocations:
            if invocation["tenant_id"] == tenant_id and invocation["id"] == invocation_id:
                if (lease_owner is not None or lease_generation is not None) and (
                    self._fenced_execution(
                        tenant_id,
                        invocation["execution_id"],
                        lease_owner,
                        lease_generation,
                    )
                    is None
                ):
                    return None
                invocation.update(fields)
                return dict(invocation)
        return None

    async def add_execution_checkpoint(
        self,
        tenant_id: int,
        execution_id: int,
        data: dict[str, Any],
        *,
        lease_owner: str | None = None,
        lease_generation: int | None = None,
    ) -> dict[str, Any] | None:
        if (lease_owner is not None or lease_generation is not None) and (
            self._fenced_execution(
                tenant_id, execution_id, lease_owner, lease_generation
            )
            is None
        ):
            return None
        sequence = int(data.get("sequence") or 0)
        if sequence <= 0:
            sequence = 1 + max(
                (
                    c["sequence"]
                    for c in self._agent_checkpoints
                    if c["tenant_id"] == tenant_id and c["execution_id"] == execution_id
                ),
                default=0,
            )
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_checkpoint"),
            "execution_id": execution_id,
            "sequence": sequence,
            "state": data.get("state", {}),
            "created_at": self._now(),
        }
        self._agent_checkpoints.append(record)
        return dict(record)

    async def latest_execution_checkpoint(
        self, tenant_id: int, execution_id: int
    ) -> dict[str, Any] | None:
        rows = [
            c
            for c in self._agent_checkpoints
            if c["tenant_id"] == tenant_id and c["execution_id"] == execution_id
        ]
        if not rows:
            return None
        return dict(max(rows, key=lambda c: c["sequence"]))

    async def list_agent_artifacts(
        self, tenant_id: int, *, execution_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [a for a in self._agent_artifacts if a["tenant_id"] == tenant_id]
        if execution_id is not None:
            rows = [a for a in rows if a.get("execution_id") == execution_id]
        rows = sorted(rows, key=lambda a: a["created_at"], reverse=True)
        return [dict(a) for a in rows[offset : offset + limit]], len(rows)

    async def create_agent_artifact(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_artifact"),
            **data,
            "created_at": self._now(),
        }
        self._agent_artifacts.append(record)
        return dict(record)

    # --- Stage 6: approvals --------------------------------------------

    async def create_agent_approval(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for approval in self._agent_approvals:
            if (
                approval["tenant_id"] == tenant_id
                and approval.get("execution_id") == data["execution_id"]
                and approval["operation_hash"] == data["operation_hash"]
                and approval.get("consumed_at") is None
                and approval["status"] in ("pending", "approved")
                and approval.get("expires_at") is not None
                and approval["expires_at"] <= now
            ):
                approval["status"] = "expired"
                approval["decided_at"] = approval.get("decided_at") or now
        for approval in self._agent_approvals:
            if (
                approval["tenant_id"] == tenant_id
                and approval.get("execution_id") == data["execution_id"]
                and approval["operation_hash"] == data["operation_hash"]
                and approval.get("consumed_at") is None
                and approval["status"] in ("pending", "approved")
            ):
                return dict(approval)
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_approval"),
            "status": "pending",
            "reviewer_actor_id": None,
            "reviewer_name": None,
            "decision_reason": None,
            "decided_at": None,
            "consumed_at": None,
            "consumed_by": None,
            "created_at": self._now(),
            **data,
        }
        self._agent_approvals.append(record)
        return dict(record)

    async def get_agent_approval(
        self, tenant_id: int, approval_id: int
    ) -> dict[str, Any] | None:
        for approval in self._agent_approvals:
            if approval["tenant_id"] == tenant_id and approval["id"] == approval_id:
                return dict(approval)
        return None

    async def find_pending_approval(
        self, tenant_id: int, execution_id: int, operation_hash: str
    ) -> dict[str, Any] | None:
        for approval in self._agent_approvals:
            if (
                approval["tenant_id"] == tenant_id
                and approval["execution_id"] == execution_id
                and approval["operation_hash"] == operation_hash
                and approval["status"] == "pending"
                and approval.get("consumed_at") is None
                and approval.get("expires_at") is not None
                and approval["expires_at"] > self._now()
            ):
                return dict(approval)
        return None

    async def list_agent_approvals(
        self,
        tenant_id: int,
        *,
        status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [a for a in self._agent_approvals if a["tenant_id"] == tenant_id]
        if status:
            rows = [a for a in rows if a["status"] == status]
        rows = sorted(rows, key=lambda a: a["created_at"], reverse=True)
        return [dict(a) for a in rows[offset : offset + limit]], len(rows)

    async def decide_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        status: str,
        reviewer_actor_id: int | None,
        reviewer_name: str | None,
        reason: str | None,
    ) -> dict[str, Any] | None:
        for approval in self._agent_approvals:
            if approval["tenant_id"] != tenant_id or approval["id"] != approval_id:
                continue
            if approval["status"] != "pending" or approval.get("consumed_at") is not None:
                return None
            if approval.get("expires_at") is not None and approval["expires_at"] <= self._now():
                return None
            approval.update(
                {
                    "status": status,
                    "reviewer_actor_id": reviewer_actor_id,
                    "reviewer_name": reviewer_name,
                    "decision_reason": reason,
                    "decided_at": self._now(),
                }
            )
            return dict(approval)
        return None

    async def consume_agent_approval(
        self,
        tenant_id: int,
        approval_id: int,
        *,
        execution_id: int,
        operation_hash: str,
        consumed_by: str,
    ) -> dict[str, Any] | None:
        for approval in self._agent_approvals:
            if (
                approval["tenant_id"] == tenant_id
                and approval["id"] == approval_id
                and approval["execution_id"] == execution_id
                and approval["operation_hash"] == operation_hash
                and approval["status"] == "approved"
                and approval.get("consumed_at") is None
                and approval.get("expires_at") is not None
                and approval["expires_at"] > self._now()
            ):
                approval["consumed_at"] = self._now()
                approval["consumed_by"] = consumed_by
                return dict(approval)
        return None



    # --- Stage 6 completion: templates, memory, schedules, delegation ---

    @staticmethod
    def _public_delegation(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "parent_execution_id": record["parent_execution_id"],
            "child_execution_id": record.get("child_execution_id"),
            "parent_agent_id": record.get("parent_agent_id"),
            "child_agent_id": record["child_agent_id"],
            "step_key": record["step_key"],
            "mode": record.get("mode", "sequential"),
            "status": record.get("status", "pending"),
            "depth": int(record.get("depth", 1)),
            "input_summary": record.get("input_summary", {}),
            "result_summary": record.get("result_summary", {}),
            "error_class": record.get("error_class"),
            "created_at": record.get("created_at"),
            "updated_at": record.get("updated_at"),
        }

    async def list_agent_templates(
        self,
        tenant_id: int,
        *,
        category: str | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [t for t in self._agent_templates if t["tenant_id"] == tenant_id]
        if category:
            rows = [t for t in rows if t.get("category") == category]
        if enabled is not None:
            rows = [t for t in rows if bool(t.get("enabled", True)) == enabled]
        rows = sorted(rows, key=lambda t: (t.get("name") or t["code"]).lower())
        return [dict(t) for t in rows[offset : offset + limit]], len(rows)

    async def get_agent_template(
        self, tenant_id: int, template_id: int
    ) -> dict[str, Any] | None:
        for template in self._agent_templates:
            if template["tenant_id"] == tenant_id and template["id"] == template_id:
                return dict(template)
        return None

    async def upsert_agent_template(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for template in self._agent_templates:
            if template["tenant_id"] == tenant_id and template["code"] == data["code"]:
                template.update(
                    {
                        "name": data["name"],
                        "description": data.get("description"),
                        "category": data.get("category"),
                        "use_case": data.get("use_case"),
                        "definition": data.get("definition", {}),
                        "system_tools": data.get("system_tools", []),
                        "enabled": bool(data.get("enabled", True)),
                        "updated_at": self._now(),
                    }
                )
                return dict(template)
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_template"),
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "category": data.get("category"),
            "use_case": data.get("use_case"),
            "definition": data.get("definition", {}),
            "system_tools": data.get("system_tools", []),
            "enabled": bool(data.get("enabled", True)),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
        }
        self._agent_templates.append(record)
        return dict(record)

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
    ) -> tuple[list[dict[str, Any]], int]:
        now = self._now()
        rows = [m for m in self._agent_memory if m["tenant_id"] == tenant_id]
        if agent_id is not None:
            rows = [m for m in rows if m.get("agent_id") == agent_id]
        if scope is not None:
            rows = [m for m in rows if m.get("scope") == scope]
        if execution_id is not None:
            rows = [m for m in rows if m.get("execution_id") == execution_id]
        if conversation_id is not None:
            rows = [m for m in rows if m.get("conversation_id") == conversation_id]
        if owner_actor_id is not None:
            rows = [m for m in rows if m.get("owner_actor_id") == owner_actor_id]
        if not include_expired:
            rows = [
                m
                for m in rows
                if m.get("expires_at") is None or m["expires_at"] > now
            ]
        rows = sorted(rows, key=lambda m: m.get("updated_at") or now, reverse=True)
        return [dict(m) for m in rows[offset : offset + limit]], len(rows)

    async def get_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None:
        for entry in self._agent_memory:
            if entry["tenant_id"] == tenant_id and entry["id"] == entry_id:
                return dict(entry)
        return None

    async def upsert_agent_memory(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        key = (
            data.get("agent_id"),
            data.get("scope", "agent"),
            data.get("owner_actor_id"),
            data["memory_key"],
        )
        for entry in self._agent_memory:
            if entry["tenant_id"] != tenant_id:
                continue
            if (
                entry.get("agent_id"),
                entry.get("scope", "agent"),
                entry.get("owner_actor_id"),
                entry["memory_key"],
            ) != key:
                continue
            entry.update(
                {
                    "content": data["content"],
                    "metadata": data.get("metadata", {}),
                    "classification": data.get("classification", "internal"),
                    "expires_at": data.get("expires_at"),
                    "execution_id": data.get("execution_id"),
                    "conversation_id": data.get("conversation_id"),
                    "updated_at": now,
                }
            )
            return dict(entry)
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_memory"),
            "agent_id": data.get("agent_id"),
            "scope": data.get("scope", "agent"),
            "execution_id": data.get("execution_id"),
            "conversation_id": data.get("conversation_id"),
            "owner_actor_id": data.get("owner_actor_id"),
            "owner_username": data.get("owner_username"),
            "memory_key": data["memory_key"],
            "content": data["content"],
            "metadata": data.get("metadata", {}),
            "classification": data.get("classification", "internal"),
            "expires_at": data.get("expires_at"),
            "created_at": now,
            "updated_at": now,
        }
        self._agent_memory.append(record)
        return dict(record)

    async def delete_agent_memory(
        self, tenant_id: int, entry_id: int
    ) -> dict[str, Any] | None:
        for index, entry in enumerate(self._agent_memory):
            if entry["tenant_id"] == tenant_id and entry["id"] == entry_id:
                return self._agent_memory.pop(index)
        return None

    async def purge_expired_agent_memory(self, tenant_id: int) -> int:
        now = self._now()
        kept = [
            m
            for m in self._agent_memory
            if not (
                m["tenant_id"] == tenant_id
                and m.get("expires_at") is not None
                and m["expires_at"] <= now
            )
        ]
        removed = len(self._agent_memory) - len(kept)
        self._agent_memory = kept
        return removed

    async def create_agent_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_schedule"),
            "agent_id": data["agent_id"],
            "name": data["name"],
            "enabled": bool(data.get("enabled", True)),
            "schedule_kind": data.get("schedule_kind", "once"),
            "cron": data.get("cron"),
            "run_at": data.get("run_at"),
            "timezone": data.get("timezone", "UTC"),
            "input": data.get("input", {}),
            "input_text": data.get("input_text"),
            "next_run_at": data.get("next_run_at"),
            "last_run_at": None,
            "last_run_key": None,
            "last_execution_id": None,
            "last_status": None,
            "failure_count": 0,
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
        }
        self._agent_schedules.append(record)
        return dict(record)

    async def get_agent_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None:
        for schedule in self._agent_schedules:
            if schedule["tenant_id"] == tenant_id and schedule["id"] == schedule_id:
                return dict(schedule)
        return None

    async def list_agent_schedules(
        self,
        tenant_id: int,
        *,
        agent_id: int | None,
        enabled: bool | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [s for s in self._agent_schedules if s["tenant_id"] == tenant_id]
        if agent_id is not None:
            rows = [s for s in rows if s.get("agent_id") == agent_id]
        if enabled is not None:
            rows = [s for s in rows if bool(s.get("enabled", True)) == enabled]
        rows = sorted(rows, key=lambda s: s.get("created_at"), reverse=True)
        return [dict(s) for s in rows[offset : offset + limit]], len(rows)

    async def update_agent_schedule(
        self, tenant_id: int, schedule_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for schedule in self._agent_schedules:
            if schedule["tenant_id"] == tenant_id and schedule["id"] == schedule_id:
                schedule.update(fields)
                schedule["updated_at"] = self._now()
                return dict(schedule)
        return None

    async def delete_agent_schedule(self, tenant_id: int, schedule_id: int) -> bool:
        for index, schedule in enumerate(self._agent_schedules):
            if schedule["tenant_id"] == tenant_id and schedule["id"] == schedule_id:
                self._agent_schedules.pop(index)
                return True
        return False

    async def claim_due_schedules(
        self, *, limit: int, now: Any
    ) -> list[dict[str, Any]]:
        due = [
            s
            for s in self._agent_schedules
            if s.get("enabled")
            and s.get("next_run_at") is not None
            and s["next_run_at"] <= now
        ]
        due.sort(key=lambda s: s["next_run_at"])
        claimed: list[dict[str, Any]] = []
        for schedule in due[:limit]:
            run_at = schedule["next_run_at"]
            schedule["last_run_key"] = run_at.astimezone(UTC).isoformat()
            schedule["last_run_at"] = run_at
            schedule["next_run_at"] = None
            schedule["updated_at"] = self._now()
            claimed.append(dict(schedule))
        return claimed

    async def create_agent_delegation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for delegation in self._agent_delegations:
            if (
                delegation["tenant_id"] == tenant_id
                and delegation["parent_execution_id"] == data["parent_execution_id"]
                and delegation["step_key"] == data["step_key"]
            ):
                if delegation.get("child_execution_id") is None and data.get(
                    "child_execution_id"
                ):
                    delegation["child_execution_id"] = data["child_execution_id"]
                delegation["status"] = data.get("status", delegation["status"])
                delegation["result_summary"] = data.get(
                    "result_summary", delegation.get("result_summary", {})
                )
                delegation["error_class"] = data.get("error_class")
                delegation["updated_at"] = self._now()
                return self._public_delegation(delegation)
        now = self._now()
        record = {
            "tenant_id": tenant_id,
            "id": self._next_id("agent_delegation"),
            "parent_execution_id": data["parent_execution_id"],
            "child_execution_id": data.get("child_execution_id"),
            "parent_agent_id": data.get("parent_agent_id"),
            "child_agent_id": data["child_agent_id"],
            "step_key": data["step_key"],
            "mode": data.get("mode", "sequential"),
            "status": data.get("status", "pending"),
            "depth": int(data.get("depth", 1)),
            "input_summary": data.get("input_summary", {}),
            "result_summary": data.get("result_summary", {}),
            "error_class": data.get("error_class"),
            "created_at": now,
            "updated_at": now,
        }
        self._agent_delegations.append(record)
        return self._public_delegation(record)

    async def update_agent_delegation(
        self, tenant_id: int, delegation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for delegation in self._agent_delegations:
            if delegation["tenant_id"] == tenant_id and delegation["id"] == delegation_id:
                for key in ("child_execution_id", "status", "result_summary", "error_class"):
                    if key in fields:
                        delegation[key] = fields[key]
                delegation["updated_at"] = self._now()
                return self._public_delegation(delegation)
        return None

    async def get_agent_delegation(
        self, tenant_id: int, delegation_id: int
    ) -> dict[str, Any] | None:
        for delegation in self._agent_delegations:
            if delegation["tenant_id"] == tenant_id and delegation["id"] == delegation_id:
                return self._public_delegation(delegation)
        return None

    async def list_agent_delegations(
        self, tenant_id: int, parent_execution_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            d
            for d in self._agent_delegations
            if d["tenant_id"] == tenant_id
            and d["parent_execution_id"] == parent_execution_id
        ]
        rows.sort(key=lambda d: (d.get("created_at"), d["id"]))
        return [self._public_delegation(d) for d in rows]

    async def agent_execution_stats(
        self, tenant_id: int, *, agent_id: int | None
    ) -> dict[str, Any]:
        rows = [
            e
            for e in self._executions
            if e["tenant_id"] == tenant_id
            and e.get("operation") == "agent"
            and (agent_id is None or e.get("agent_id") == agent_id)
        ]
        latencies = [e["latency_ms"] for e in rows if e.get("latency_ms") is not None]
        tokens = 0
        for execution in rows:
            try:
                tokens += int((execution.get("token_usage") or {}).get("total_tokens") or 0)
            except (TypeError, ValueError):
                continue
        return {
            "total": len(rows),
            "succeeded": sum(1 for e in rows if e.get("status") in ("completed", "succeeded")),
            "failed": sum(1 for e in rows if e.get("status") == "failed"),
            "cancelled": sum(1 for e in rows if e.get("status") == "cancelled"),
            "waiting_approval": sum(1 for e in rows if e.get("status") == "waiting_approval"),
            "active": sum(1 for e in rows if e.get("status") in ("queued", "running")),
            "avg_latency_ms": (sum(latencies) / len(latencies)) if latencies else None,
            "total_tokens": tokens,
        }

    async def delete_agent(
        self, tenant_id: int, agent_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        for agent in self._agents:
            if (
                agent["tenant_id"] == tenant_id
                and agent["id"] == agent_id
                and agent.get("deleted_at") is None
            ):
                agent["lifecycle_status"] = "archived"
                agent["enabled"] = False
                agent["archived_at"] = agent.get("archived_at") or self._now()
                agent["deleted_at"] = self._now()
                agent["updated_by"] = updated_by
                agent["lock_version"] += 1
                agent["updated_at"] = self._now()
                return self._public_agent(agent)
        return None

    async def update_agent_working_config(
        self,
        tenant_id: int,
        agent_id: int,
        working_config: dict[str, Any],
        *,
        updated_by: str | None,
    ) -> dict[str, Any] | None:
        for agent in self._agents:
            if (
                agent["tenant_id"] == tenant_id
                and agent["id"] == agent_id
                and agent.get("deleted_at") is None
            ):
                agent["working_config"] = working_config
                agent["updated_by"] = updated_by
                agent["lock_version"] += 1
                agent["updated_at"] = self._now()
                return self._public_agent(agent)
        return None

    # --- Knowledge graph (Stage 7) --------------------------------------
    async def upsert_graph_entity(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for entity in self._graph_entities:
            if (
                entity["tenant_id"] == tenant_id
                and entity["entity_type"] == data["entity_type"]
                and entity["stable_key"] == data["stable_key"]
            ):
                entity.update(
                    {
                        "external_id": data.get("external_id")
                        or entity.get("external_id"),
                        "source_system": data.get("source_system")
                        or entity.get("source_system"),
                        "source_ref": data.get("source_ref") or entity.get("source_ref"),
                        "name": data.get("name") or entity.get("name"),
                        "description": data.get("description")
                        or entity.get("description"),
                        "classification": data.get("classification", "internal"),
                        "acl": data.get("acl", {}),
                        "lifecycle_status": data.get("lifecycle_status", "active"),
                        "confidence": float(data.get("confidence", 1.0)),
                        "properties": dict(data.get("properties", {})),
                        "metadata": {**entity.get("metadata", {}), **data.get("metadata", {})},
                        "valid_from": data.get("valid_from") or entity.get("valid_from"),
                        "valid_to": data.get("valid_to") or entity.get("valid_to"),
                        "updated_by": data.get("updated_by") or data.get("created_by"),
                        "deleted_at": None,
                        "version": int(entity.get("version", 1)) + 1,
                        "updated_at": now,
                    }
                )
                return dict(entity)
        record = {
            "id": self._next_id("graph_entity"),
            "tenant_id": tenant_id,
            "entity_type": data["entity_type"],
            "stable_key": data["stable_key"],
            "external_id": data.get("external_id"),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "name": data.get("name"),
            "description": data.get("description"),
            "classification": data.get("classification", "internal"),
            "acl": data.get("acl", {}),
            "lifecycle_status": data.get("lifecycle_status", "active"),
            "confidence": float(data.get("confidence", 1.0)),
            "properties": dict(data.get("properties", {})),
            "metadata": dict(data.get("metadata", {})),
            "valid_from": data.get("valid_from"),
            "valid_to": data.get("valid_to"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._graph_entities.append(record)
        return dict(record)

    async def get_graph_entity(
        self, tenant_id: int, entity_id: int
    ) -> dict[str, Any] | None:
        for entity in self._graph_entities:
            if (
                entity["tenant_id"] == tenant_id
                and entity["id"] == entity_id
                and entity.get("deleted_at") is None
            ):
                return dict(entity)
        return None

    async def get_graph_entity_by_key(
        self, tenant_id: int, entity_type: str, stable_key: str
    ) -> dict[str, Any] | None:
        for entity in self._graph_entities:
            if (
                entity["tenant_id"] == tenant_id
                and entity["entity_type"] == entity_type
                and entity["stable_key"] == stable_key
                and entity.get("deleted_at") is None
            ):
                return dict(entity)
        return None

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
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            e
            for e in self._graph_entities
            if e["tenant_id"] == tenant_id and e.get("deleted_at") is None
        ]
        if entity_types:
            allowed = set(entity_types)
            rows = [e for e in rows if e["entity_type"] in allowed]
        if lifecycle_status:
            rows = [e for e in rows if e["lifecycle_status"] == lifecycle_status]
        if source_system:
            rows = [e for e in rows if e.get("source_system") == source_system]
        if query:
            needle = query.lower()
            rows = [
                e
                for e in rows
                if needle in str(e.get("name") or "").lower()
                or needle in str(e.get("stable_key") or "").lower()
                or needle in str(e.get("external_id") or "").lower()
            ]
        rows = sorted(rows, key=lambda e: e["updated_at"], reverse=True)
        return [dict(e) for e in rows[offset : offset + limit]], len(rows)

    async def update_graph_entity(
        self, tenant_id: int, entity_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "external_id",
            "source_system",
            "source_ref",
            "name",
            "description",
            "classification",
            "acl",
            "lifecycle_status",
            "confidence",
            "properties",
            "metadata",
            "valid_from",
            "valid_to",
            "updated_by",
        }
        for entity in self._graph_entities:
            if (
                entity["tenant_id"] == tenant_id
                and entity["id"] == entity_id
                and entity.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        entity[key] = value
                entity["version"] = int(entity.get("version", 1)) + 1
                entity["updated_at"] = self._now()
                return dict(entity)
        return None

    async def delete_graph_entity(
        self, tenant_id: int, entity_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        for entity in self._graph_entities:
            if (
                entity["tenant_id"] == tenant_id
                and entity["id"] == entity_id
                and entity.get("deleted_at") is None
            ):
                entity["lifecycle_status"] = "archived"
                entity["deleted_at"] = self._now()
                entity["updated_by"] = updated_by
                entity["version"] = int(entity.get("version", 1)) + 1
                entity["updated_at"] = self._now()
                return dict(entity)
        return None

    async def add_graph_entity_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for row in self._graph_entity_versions:
            if (
                row["tenant_id"] == tenant_id
                and row["entity_id"] == data["entity_id"]
                and row["version"] == data["version"]
            ):
                row["snapshot"] = data.get("snapshot", {})
                row["change_reason"] = data.get("change_reason")
                return dict(row)
        record = {
            "id": self._next_id("graph_entity_version"),
            "tenant_id": tenant_id,
            "entity_id": data["entity_id"],
            "version": data["version"],
            "snapshot": data.get("snapshot", {}),
            "change_reason": data.get("change_reason"),
            "created_by": data.get("created_by"),
            "created_at": self._now(),
        }
        self._graph_entity_versions.append(record)
        return dict(record)

    async def list_graph_entity_versions(
        self, tenant_id: int, entity_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            r
            for r in self._graph_entity_versions
            if r["tenant_id"] == tenant_id and r["entity_id"] == entity_id
        ]
        rows.sort(key=lambda r: r["version"], reverse=True)
        return [dict(r) for r in rows]

    async def upsert_graph_relationship(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for rel in self._graph_relationships:
            if (
                rel["tenant_id"] == tenant_id
                and rel["relationship_type"] == data["relationship_type"]
                and rel["source_entity_id"] == data["source_entity_id"]
                and rel["target_entity_id"] == data["target_entity_id"]
                and rel.get("deleted_at") is None
            ):
                rel.update(
                    {
                        "properties": dict(data.get("properties", {})),
                        "confidence": float(data.get("confidence", 1.0)),
                        "source_system": data.get("source_system")
                        or rel.get("source_system"),
                        "source_ref": data.get("source_ref") or rel.get("source_ref"),
                        "lifecycle_status": data.get("lifecycle_status", "active"),
                        "valid_from": data.get("valid_from") or rel.get("valid_from"),
                        "valid_to": data.get("valid_to") or rel.get("valid_to"),
                        "updated_by": data.get("updated_by") or data.get("created_by"),
                        "version": int(rel.get("version", 1)) + 1,
                        "updated_at": now,
                    }
                )
                return dict(rel)
        record = {
            "id": self._next_id("graph_relationship"),
            "tenant_id": tenant_id,
            "relationship_type": data["relationship_type"],
            "source_entity_id": data["source_entity_id"],
            "target_entity_id": data["target_entity_id"],
            "properties": dict(data.get("properties", {})),
            "confidence": float(data.get("confidence", 1.0)),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "lifecycle_status": data.get("lifecycle_status", "active"),
            "valid_from": data.get("valid_from"),
            "valid_to": data.get("valid_to"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._graph_relationships.append(record)
        return dict(record)

    async def get_graph_relationship(
        self, tenant_id: int, relationship_id: int
    ) -> dict[str, Any] | None:
        for rel in self._graph_relationships:
            if (
                rel["tenant_id"] == tenant_id
                and rel["id"] == relationship_id
                and rel.get("deleted_at") is None
            ):
                return dict(rel)
        return None

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
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            r
            for r in self._graph_relationships
            if r["tenant_id"] == tenant_id and r.get("deleted_at") is None
        ]
        if entity_ids:
            wanted = set(entity_ids)
            if direction == "outgoing":
                rows = [r for r in rows if r["source_entity_id"] in wanted]
            elif direction == "incoming":
                rows = [r for r in rows if r["target_entity_id"] in wanted]
            else:
                rows = [
                    r
                    for r in rows
                    if r["source_entity_id"] in wanted or r["target_entity_id"] in wanted
                ]
        if relationship_types:
            allowed = set(relationship_types)
            rows = [r for r in rows if r["relationship_type"] in allowed]
        if not include_inactive:
            rows = [r for r in rows if r["lifecycle_status"] == "active"]
        rows.sort(key=lambda r: r["id"])
        return [dict(r) for r in rows[offset : offset + limit]], len(rows)

    async def update_graph_relationship(
        self, tenant_id: int, relationship_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "properties",
            "confidence",
            "source_system",
            "source_ref",
            "lifecycle_status",
            "valid_from",
            "valid_to",
            "updated_by",
        }
        for rel in self._graph_relationships:
            if (
                rel["tenant_id"] == tenant_id
                and rel["id"] == relationship_id
                and rel.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        rel[key] = value
                rel["version"] = int(rel.get("version", 1)) + 1
                rel["updated_at"] = self._now()
                return dict(rel)
        return None

    async def delete_graph_relationship(
        self, tenant_id: int, relationship_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        for rel in self._graph_relationships:
            if (
                rel["tenant_id"] == tenant_id
                and rel["id"] == relationship_id
                and rel.get("deleted_at") is None
            ):
                rel["lifecycle_status"] = "archived"
                rel["deleted_at"] = self._now()
                rel["updated_by"] = updated_by
                rel["version"] = int(rel.get("version", 1)) + 1
                rel["updated_at"] = self._now()
                return dict(rel)
        return None

    async def add_graph_relationship_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for row in self._graph_relationship_versions:
            if (
                row["tenant_id"] == tenant_id
                and row["relationship_id"] == data["relationship_id"]
                and row["version"] == data["version"]
            ):
                row["snapshot"] = data.get("snapshot", {})
                row["change_reason"] = data.get("change_reason")
                return dict(row)
        record = {
            "id": self._next_id("graph_relationship_version"),
            "tenant_id": tenant_id,
            "relationship_id": data["relationship_id"],
            "version": data["version"],
            "snapshot": data.get("snapshot", {}),
            "change_reason": data.get("change_reason"),
            "created_by": data.get("created_by"),
            "created_at": self._now(),
        }
        self._graph_relationship_versions.append(record)
        return dict(record)

    async def list_graph_neighbors(
        self,
        tenant_id: int,
        *,
        entity_ids: list[int],
        relationship_types: list[str] | None,
        direction: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        wanted = set(entity_ids)
        rows: list[dict[str, Any]] = []
        for rel in self._graph_relationships:
            if rel["tenant_id"] != tenant_id:
                continue
            if rel.get("deleted_at") is not None:
                continue
            if rel["lifecycle_status"] != "active":
                continue
            if direction == "outgoing" and rel["source_entity_id"] not in wanted:
                continue
            if direction == "incoming" and rel["target_entity_id"] not in wanted:
                continue
            if direction == "both" and (
                rel["source_entity_id"] not in wanted
                and rel["target_entity_id"] not in wanted
            ):
                continue
            if relationship_types and rel["relationship_type"] not in set(
                relationship_types
            ):
                continue
            rows.append(
                {
                    "id": rel["id"],
                    "relationship_type": rel["relationship_type"],
                    "source_entity_id": rel["source_entity_id"],
                    "target_entity_id": rel["target_entity_id"],
                    "confidence": rel["confidence"],
                    "source_system": rel.get("source_system"),
                    "properties": rel.get("properties", {}),
                    "lifecycle_status": rel["lifecycle_status"],
                }
            )
            if len(rows) >= limit:
                break
        rows.sort(key=lambda r: r["id"])
        return rows[:limit]

    async def graph_entity_type_counts(self, tenant_id: int) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for entity in self._graph_entities:
            if entity["tenant_id"] != tenant_id or entity.get("deleted_at") is not None:
                continue
            counts[entity["entity_type"]] = counts.get(entity["entity_type"], 0) + 1
        return [
            {"entity_type": key, "total": value}
            for key, value in sorted(
                counts.items(), key=lambda item: (-item[1], item[0])
            )
        ]

    async def graph_stats(self, tenant_id: int) -> dict[str, Any]:
        entities = [
            e
            for e in self._graph_entities
            if e["tenant_id"] == tenant_id and e.get("deleted_at") is None
        ]
        relationships = [
            r
            for r in self._graph_relationships
            if r["tenant_id"] == tenant_id
            and r.get("deleted_at") is None
            and r["lifecycle_status"] == "active"
        ]
        entity_updates = [e["updated_at"] for e in entities]
        rel_updates = [
            r["updated_at"]
            for r in self._graph_relationships
            if r["tenant_id"] == tenant_id
        ]
        return {
            "entities": len(entities),
            "relationships": len(relationships),
            "stale_entities": sum(
                1 for e in entities if e["lifecycle_status"] == "stale"
            ),
            "last_entity_update": max(entity_updates) if entity_updates else None,
            "last_relationship_update": max(rel_updates) if rel_updates else None,
        }

    async def list_graph_entity_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(r) for r in self._graph_entity_types if r["tenant_id"] == tenant_id
        ]
        rows.sort(key=lambda r: r["code"])
        return rows

    async def upsert_graph_entity_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for row in self._graph_entity_types:
            if row["tenant_id"] == tenant_id and row["code"] == data["code"]:
                row.update(
                    {
                        "name": data["name"],
                        "description": data.get("description"),
                        "category": data.get("category"),
                        "property_schema": data.get("property_schema", {}),
                        "enabled": bool(data.get("enabled", True)),
                        "updated_at": now,
                    }
                )
                return dict(row)
        record = {
            "id": self._next_id("graph_entity_type"),
            "tenant_id": tenant_id,
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "category": data.get("category"),
            "property_schema": data.get("property_schema", {}),
            "enabled": bool(data.get("enabled", True)),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
        }
        self._graph_entity_types.append(record)
        return dict(record)

    async def list_graph_relationship_types(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(r)
            for r in self._graph_relationship_types
            if r["tenant_id"] == tenant_id
        ]
        rows.sort(key=lambda r: r["code"])
        return rows

    async def upsert_graph_relationship_type(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for row in self._graph_relationship_types:
            if row["tenant_id"] == tenant_id and row["code"] == data["code"]:
                row.update(
                    {
                        "name": data["name"],
                        "description": data.get("description"),
                        "source_types": list(data.get("source_types", [])),
                        "target_types": list(data.get("target_types", [])),
                        "directed": bool(data.get("directed", True)),
                        "property_schema": data.get("property_schema", {}),
                        "enabled": bool(data.get("enabled", True)),
                        "updated_at": now,
                    }
                )
                return dict(row)
        record = {
            "id": self._next_id("graph_relationship_type"),
            "tenant_id": tenant_id,
            "code": data["code"],
            "name": data["name"],
            "description": data.get("description"),
            "source_types": list(data.get("source_types", [])),
            "target_types": list(data.get("target_types", [])),
            "directed": bool(data.get("directed", True)),
            "property_schema": data.get("property_schema", {}),
            "enabled": bool(data.get("enabled", True)),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
        }
        self._graph_relationship_types.append(record)
        return dict(record)

    # --- Product & BOM intelligence (Stage 8) ---------------------------
    async def upsert_product_item(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for item in self._product_items:
            if (
                item["tenant_id"] == tenant_id
                and item["item_type"] == data["item_type"]
                and item["item_key"] == data["item_key"]
            ):
                item.update(
                    {
                        "name": data.get("name") or item.get("name"),
                        "description": data.get("description") or item.get("description"),
                        "unit_of_measure": data.get("unit_of_measure")
                        or item.get("unit_of_measure", "EA"),
                        "lifecycle_status": data.get("lifecycle_status")
                        or item.get("lifecycle_status", "active"),
                        "configuration": dict(
                            data.get("configuration", item.get("configuration", {}))
                        ),
                        "variants": list(data.get("variants", item.get("variants", []))),
                        "effectivity_from": data.get("effectivity_from")
                        or item.get("effectivity_from"),
                        "effectivity_to": data.get("effectivity_to")
                        or item.get("effectivity_to"),
                        "external_id": data.get("external_id")
                        or item.get("external_id"),
                        "source_system": data.get("source_system")
                        or item.get("source_system"),
                        "source_ref": data.get("source_ref") or item.get("source_ref"),
                        "classification": data.get("classification", "internal"),
                        "acl": dict(data.get("acl", item.get("acl", {}))),
                        "graph_entity_id": data.get("graph_entity_id")
                        or item.get("graph_entity_id"),
                        "updated_by": data.get("updated_by") or data.get("created_by"),
                        "deleted_at": None,
                        "version": int(item.get("version", 1)) + 1,
                        "updated_at": now,
                    }
                )
                return dict(item)
        record = {
            "id": self._next_id("product_item"),
            "tenant_id": tenant_id,
            "item_type": data["item_type"],
            "item_key": data["item_key"],
            "name": data.get("name"),
            "description": data.get("description"),
            "unit_of_measure": data.get("unit_of_measure", "EA"),
            "lifecycle_status": data.get("lifecycle_status", "active"),
            "configuration": dict(data.get("configuration", {})),
            "variants": list(data.get("variants", [])),
            "effectivity_from": data.get("effectivity_from"),
            "effectivity_to": data.get("effectivity_to"),
            "external_id": data.get("external_id"),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "classification": data.get("classification", "internal"),
            "acl": dict(data.get("acl", {})),
            "graph_entity_id": data.get("graph_entity_id"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._product_items.append(record)
        return dict(record)

    async def get_product_item(
        self, tenant_id: int, item_id: int
    ) -> dict[str, Any] | None:
        for item in self._product_items:
            if (
                item["tenant_id"] == tenant_id
                and item["id"] == item_id
                and item.get("deleted_at") is None
            ):
                return dict(item)
        return None

    async def get_product_item_by_key(
        self, tenant_id: int, item_type: str, item_key: str
    ) -> dict[str, Any] | None:
        for item in self._product_items:
            if (
                item["tenant_id"] == tenant_id
                and item["item_type"] == item_type
                and item["item_key"] == item_key
                and item.get("deleted_at") is None
            ):
                return dict(item)
        return None

    async def list_product_items(
        self,
        tenant_id: int,
        *,
        item_types: list[str] | None,
        query: str | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            i
            for i in self._product_items
            if i["tenant_id"] == tenant_id and i.get("deleted_at") is None
        ]
        if item_types:
            allowed = set(item_types)
            rows = [i for i in rows if i["item_type"] in allowed]
        if lifecycle_status:
            rows = [i for i in rows if i["lifecycle_status"] == lifecycle_status]
        if query:
            needle = query.lower()
            rows = [
                i
                for i in rows
                if needle in str(i.get("item_key") or "").lower()
                or needle in str(i.get("name") or "").lower()
                or needle in str(i.get("external_id") or "").lower()
            ]
        rows.sort(key=lambda i: i["updated_at"], reverse=True)
        return [dict(i) for i in rows[offset : offset + limit]], len(rows)

    async def update_product_item(
        self, tenant_id: int, item_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "name",
            "description",
            "unit_of_measure",
            "lifecycle_status",
            "configuration",
            "variants",
            "effectivity_from",
            "effectivity_to",
            "external_id",
            "source_system",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        for item in self._product_items:
            if (
                item["tenant_id"] == tenant_id
                and item["id"] == item_id
                and item.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        item[key] = value
                item["version"] = int(item.get("version", 1)) + 1
                item["updated_at"] = self._now()
                return dict(item)
        return None

    async def count_product_items_by_type(
        self, tenant_id: int
    ) -> list[dict[str, Any]]:
        counts: dict[str, int] = {}
        for item in self._product_items:
            if item["tenant_id"] != tenant_id or item.get("deleted_at") is not None:
                continue
            counts[item["item_type"]] = counts.get(item["item_type"], 0) + 1
        return [
            {"item_type": key, "total": total}
            for key, total in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

    async def upsert_product_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for rev in self._product_revisions:
            if (
                rev["tenant_id"] == tenant_id
                and rev["item_id"] == data["item_id"]
                and rev["revision"] == data["revision"]
            ):
                rev.update(
                    {
                        "lifecycle_status": data.get("lifecycle_status")
                        or rev.get("lifecycle_status", "draft"),
                        "effectivity_from": data.get("effectivity_from")
                        or rev.get("effectivity_from"),
                        "effectivity_to": data.get("effectivity_to")
                        or rev.get("effectivity_to"),
                        "configuration": dict(
                            data.get("configuration", rev.get("configuration", {}))
                        ),
                        "external_id": data.get("external_id")
                        or rev.get("external_id"),
                        "source_system": data.get("source_system")
                        or rev.get("source_system"),
                        "source_ref": data.get("source_ref") or rev.get("source_ref"),
                        "classification": data.get("classification", "internal"),
                        "acl": dict(data.get("acl", rev.get("acl", {}))),
                        "graph_entity_id": data.get("graph_entity_id")
                        or rev.get("graph_entity_id"),
                        "updated_by": data.get("updated_by") or data.get("created_by"),
                        "deleted_at": None,
                        "version": int(rev.get("version", 1)) + 1,
                        "updated_at": now,
                    }
                )
                return dict(rev)
        record = {
            "id": self._next_id("product_revision"),
            "tenant_id": tenant_id,
            "item_id": data["item_id"],
            "revision": data["revision"],
            "lifecycle_status": data.get("lifecycle_status", "draft"),
            "effectivity_from": data.get("effectivity_from"),
            "effectivity_to": data.get("effectivity_to"),
            "configuration": dict(data.get("configuration", {})),
            "external_id": data.get("external_id"),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "classification": data.get("classification", "internal"),
            "acl": dict(data.get("acl", {})),
            "graph_entity_id": data.get("graph_entity_id"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._product_revisions.append(record)
        return dict(record)

    async def get_product_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None:
        for rev in self._product_revisions:
            if (
                rev["tenant_id"] == tenant_id
                and rev["id"] == revision_id
                and rev.get("deleted_at") is None
            ):
                return dict(rev)
        return None

    async def get_product_revision_by_key(
        self, tenant_id: int, item_id: int, revision: str
    ) -> dict[str, Any] | None:
        for rev in self._product_revisions:
            if (
                rev["tenant_id"] == tenant_id
                and rev["item_id"] == item_id
                and rev["revision"] == revision
                and rev.get("deleted_at") is None
            ):
                return dict(rev)
        return None

    async def list_product_revisions(
        self,
        tenant_id: int,
        *,
        item_id: int | None,
        lifecycle_status: str | None,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            r
            for r in self._product_revisions
            if r["tenant_id"] == tenant_id and r.get("deleted_at") is None
        ]
        if item_id is not None:
            rows = [r for r in rows if r["item_id"] == item_id]
        if lifecycle_status:
            rows = [r for r in rows if r["lifecycle_status"] == lifecycle_status]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return [dict(r) for r in rows[offset : offset + limit]], len(rows)

    async def update_product_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "lifecycle_status",
            "effectivity_from",
            "effectivity_to",
            "configuration",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        for rev in self._product_revisions:
            if (
                rev["tenant_id"] == tenant_id
                and rev["id"] == revision_id
                and rev.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        rev[key] = value
                rev["version"] = int(rev.get("version", 1)) + 1
                rev["updated_at"] = self._now()
                return dict(rev)
        return None

    async def upsert_bom_header(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        for header in self._bom_headers:
            if (
                header["tenant_id"] == tenant_id
                and header["bom_type"] == data["bom_type"]
                and header["bom_key"] == data["bom_key"]
            ):
                header.update(
                    {
                        "name": data.get("name") or header.get("name"),
                        "description": data.get("description")
                        or header.get("description"),
                        "root_item_id": data.get("root_item_id")
                        or header.get("root_item_id"),
                        "root_revision_id": data.get("root_revision_id")
                        or header.get("root_revision_id"),
                        "plant": data.get("plant") or header.get("plant"),
                        "configuration": dict(
                            data.get("configuration", header.get("configuration", {}))
                        ),
                        "lifecycle_status": data.get("lifecycle_status")
                        or header.get("lifecycle_status", "draft"),
                        "external_id": data.get("external_id")
                        or header.get("external_id"),
                        "source_system": data.get("source_system")
                        or header.get("source_system"),
                        "source_ref": data.get("source_ref")
                        or header.get("source_ref"),
                        "classification": data.get("classification", "internal"),
                        "acl": dict(data.get("acl", header.get("acl", {}))),
                        "graph_entity_id": data.get("graph_entity_id")
                        or header.get("graph_entity_id"),
                        "updated_by": data.get("updated_by") or data.get("created_by"),
                        "deleted_at": None,
                        "version": int(header.get("version", 1)) + 1,
                        "updated_at": now,
                    }
                )
                return dict(header)
        record = {
            "id": self._next_id("bom_header"),
            "tenant_id": tenant_id,
            "bom_type": data["bom_type"],
            "bom_key": data["bom_key"],
            "name": data.get("name"),
            "description": data.get("description"),
            "root_item_id": data.get("root_item_id"),
            "root_revision_id": data.get("root_revision_id"),
            "plant": data.get("plant"),
            "configuration": dict(data.get("configuration", {})),
            "lifecycle_status": data.get("lifecycle_status", "draft"),
            "external_id": data.get("external_id"),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "classification": data.get("classification", "internal"),
            "acl": dict(data.get("acl", {})),
            "graph_entity_id": data.get("graph_entity_id"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._bom_headers.append(record)
        return dict(record)

    async def get_bom_header(
        self, tenant_id: int, header_id: int
    ) -> dict[str, Any] | None:
        for header in self._bom_headers:
            if (
                header["tenant_id"] == tenant_id
                and header["id"] == header_id
                and header.get("deleted_at") is None
            ):
                return dict(header)
        return None

    async def get_bom_header_by_key(
        self, tenant_id: int, bom_type: str, bom_key: str
    ) -> dict[str, Any] | None:
        for header in self._bom_headers:
            if (
                header["tenant_id"] == tenant_id
                and header["bom_type"] == bom_type
                and header["bom_key"] == bom_key
                and header.get("deleted_at") is None
            ):
                return dict(header)
        return None

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
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            h
            for h in self._bom_headers
            if h["tenant_id"] == tenant_id and h.get("deleted_at") is None
        ]
        if bom_type:
            rows = [h for h in rows if h["bom_type"] == bom_type]
        if root_item_id is not None:
            rows = [h for h in rows if h.get("root_item_id") == root_item_id]
        if lifecycle_status:
            rows = [h for h in rows if h["lifecycle_status"] == lifecycle_status]
        if query:
            needle = query.lower()
            rows = [
                h
                for h in rows
                if needle in str(h.get("bom_key") or "").lower()
                or needle in str(h.get("name") or "").lower()
            ]
        rows.sort(key=lambda h: h["updated_at"], reverse=True)
        return [dict(h) for h in rows[offset : offset + limit]], len(rows)

    async def update_bom_header(
        self, tenant_id: int, header_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "name",
            "description",
            "root_item_id",
            "root_revision_id",
            "plant",
            "configuration",
            "lifecycle_status",
            "source_ref",
            "classification",
            "acl",
            "graph_entity_id",
            "updated_by",
        }
        for header in self._bom_headers:
            if (
                header["tenant_id"] == tenant_id
                and header["id"] == header_id
                and header.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        header[key] = value
                header["version"] = int(header.get("version", 1)) + 1
                header["updated_at"] = self._now()
                return dict(header)
        return None

    async def delete_bom_header(
        self, tenant_id: int, header_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        for header in self._bom_headers:
            if (
                header["tenant_id"] == tenant_id
                and header["id"] == header_id
                and header.get("deleted_at") is None
            ):
                header["lifecycle_status"] = "archived"
                header["deleted_at"] = self._now()
                header["updated_by"] = updated_by
                header["version"] = int(header.get("version", 1)) + 1
                header["updated_at"] = self._now()
                return dict(header)
        return None

    async def create_bom_line(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for line in self._bom_lines:
            if (
                line["tenant_id"] == tenant_id
                and line["bom_header_id"] == data["bom_header_id"]
                and line["line_key"] == data["line_key"]
                and line.get("deleted_at") is None
            ):
                for key, value in data.items():
                    line[key] = value
                line["version"] = int(line.get("version", 1)) + 1
                line["updated_at"] = self._now()
                return dict(line)
        now = self._now()
        record = {
            "id": self._next_id("bom_line"),
            "tenant_id": tenant_id,
            "bom_header_id": data["bom_header_id"],
            "parent_revision_id": data["parent_revision_id"],
            "child_item_id": data["child_item_id"],
            "child_revision_id": data.get("child_revision_id"),
            "line_key": data["line_key"],
            "quantity": float(data.get("quantity", 1)),
            "unit_of_measure": data.get("unit_of_measure", "EA"),
            "find_number": data.get("find_number"),
            "sequence": int(data.get("sequence", 0)),
            "reference_designators": list(data.get("reference_designators", [])),
            "usage": data.get("usage", "DESIGN"),
            "line_status": data.get("line_status", "active"),
            "is_phantom": bool(data.get("is_phantom", False)),
            "is_reference": bool(data.get("is_reference", False)),
            "alternate_of_line_id": data.get("alternate_of_line_id"),
            "substitute_for_item_id": data.get("substitute_for_item_id"),
            "plant": data.get("plant"),
            "effectivity_from": data.get("effectivity_from"),
            "effectivity_to": data.get("effectivity_to"),
            "configuration": dict(data.get("configuration", {})),
            "attributes": dict(data.get("attributes", {})),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "external_id": data.get("external_id"),
            "version": 1,
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._bom_lines.append(record)
        return dict(record)

    async def get_bom_line(
        self, tenant_id: int, line_id: int
    ) -> dict[str, Any] | None:
        for line in self._bom_lines:
            if (
                line["tenant_id"] == tenant_id
                and line["id"] == line_id
                and line.get("deleted_at") is None
            ):
                return dict(line)
        return None

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
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            line
            for line in self._bom_lines
            if line["tenant_id"] == tenant_id and line.get("deleted_at") is None
        ]
        if header_id is not None:
            rows = [line for line in rows if line["bom_header_id"] == header_id]
        if parent_revision_id is not None:
            rows = [
                line
                for line in rows
                if line["parent_revision_id"] == parent_revision_id
            ]
        if child_item_id is not None:
            rows = [line for line in rows if line["child_item_id"] == child_item_id]
        if active_only:
            rows = [line for line in rows if line["line_status"] == "active"]
        rows.sort(key=lambda line: (line["sequence"], line["line_key"]))
        return [dict(line) for line in rows[offset : offset + limit]], len(rows)

    async def list_bom_lines_by_parents(
        self, tenant_id: int, header_id: int, parent_revision_ids: list[int]
    ) -> list[dict[str, Any]]:
        wanted = set(parent_revision_ids)
        rows = [
            dict(line)
            for line in self._bom_lines
            if line["tenant_id"] == tenant_id
            and line["bom_header_id"] == header_id
            and line["parent_revision_id"] in wanted
            and line.get("deleted_at") is None
            and line["line_status"] == "active"
        ]
        rows.sort(key=lambda line: (line["sequence"], line["line_key"]))
        return rows

    async def update_bom_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        allowed = {
            "child_revision_id",
            "quantity",
            "unit_of_measure",
            "find_number",
            "sequence",
            "reference_designators",
            "usage",
            "line_status",
            "is_phantom",
            "is_reference",
            "substitute_for_item_id",
            "plant",
            "effectivity_from",
            "effectivity_to",
            "configuration",
            "attributes",
            "source_ref",
            "external_id",
            "updated_by",
        }
        for line in self._bom_lines:
            if (
                line["tenant_id"] == tenant_id
                and line["id"] == line_id
                and line.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    if key in allowed:
                        if key == "quantity" and value is not None:
                            value = float(value)
                        line[key] = value
                line["version"] = int(line.get("version", 1)) + 1
                line["updated_at"] = self._now()
                return dict(line)
        return None

    async def delete_bom_line(
        self, tenant_id: int, line_id: int, *, updated_by: str | None
    ) -> dict[str, Any] | None:
        for line in self._bom_lines:
            if (
                line["tenant_id"] == tenant_id
                and line["id"] == line_id
                and line.get("deleted_at") is None
            ):
                line["line_status"] = "obsolete"
                line["deleted_at"] = self._now()
                line["updated_by"] = updated_by
                line["version"] = int(line.get("version", 1)) + 1
                line["updated_at"] = self._now()
                return dict(line)
        return None

    async def add_bom_transformation_run(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        run_id = self._next_id("bom_transformation_run")
        entries: list[dict[str, Any]] = []
        for entry in data.get("entries", []):
            record = {
                "id": self._next_id("bom_transformation_entry"),
                "tenant_id": tenant_id,
                "run_id": run_id,
                "source_line_id": entry.get("source_line_id"),
                "target_line_id": entry.get("target_line_id"),
                "mapping_type": entry.get("mapping_type", "UNMATCHED"),
                "quantity": entry.get("quantity"),
                "unit_of_measure": entry.get("unit_of_measure"),
                "notes": entry.get("notes"),
                "created_at": now,
            }
            self._bom_transformation_entries.append(record)
            entries.append(dict(record))
        run = {
            "id": run_id,
            "tenant_id": tenant_id,
            "source_header_id": data["source_header_id"],
            "target_header_id": data.get("target_header_id"),
            "mode": data.get("mode", "DRY_RUN"),
            "status": data.get("status", "completed"),
            "summary": dict(data.get("summary", {})),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
            "entries": entries,
        }
        self._bom_transformation_runs.append(run)
        return dict(run)

    async def get_bom_transformation_run(
        self, tenant_id: int, run_id: int
    ) -> dict[str, Any] | None:
        for run in self._bom_transformation_runs:
            if (
                run["tenant_id"] == tenant_id
                and run["id"] == run_id
                and run.get("deleted_at") is None
            ):
                out = dict(run)
                out["entries"] = [
                    dict(e)
                    for e in self._bom_transformation_entries
                    if e["tenant_id"] == tenant_id and e["run_id"] == run_id
                ]
                return out
        return None

    async def list_bom_transformation_runs(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(r)
            for r in self._bom_transformation_runs
            if r["tenant_id"] == tenant_id and r.get("deleted_at") is None
        ]
        if source_header_id is not None:
            rows = [r for r in rows if r["source_header_id"] == source_header_id]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return rows[:limit]

    async def add_bom_reconciliation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "id": self._next_id("bom_reconciliation"),
            "tenant_id": tenant_id,
            "source_header_id": data["source_header_id"],
            "target_header_id": data.get("target_header_id"),
            "run_id": data.get("run_id"),
            "status": data.get("status", "open"),
            "exceptions": list(data.get("exceptions", [])),
            "summary": dict(data.get("summary", {})),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._bom_reconciliations.append(record)
        return dict(record)

    async def list_bom_reconciliations(
        self, tenant_id: int, *, source_header_id: int | None, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(r)
            for r in self._bom_reconciliations
            if r["tenant_id"] == tenant_id and r.get("deleted_at") is None
        ]
        if source_header_id is not None:
            rows = [r for r in rows if r["source_header_id"] == source_header_id]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return rows[:limit]


    # --- Manufacturing & quality intelligence (Stage 9) ----------------
    @staticmethod
    def _mq_copy(value: Any) -> Any:
        if isinstance(value, dict):
            return dict(value)
        if isinstance(value, list):
            return [dict(item) if isinstance(item, dict) else item for item in value]
        return value

    def _mq_upsert(
        self,
        table: str,
        store: list[dict[str, Any]],
        tenant_id: int,
        identity: dict[str, Any],
        data: dict[str, Any],
        defaults: dict[str, Any],
        *,
        optimistic_version: bool = True,
    ) -> dict[str, Any]:
        now = self._now()
        for row in store:
            if row["tenant_id"] != tenant_id:
                continue
            if all(row.get(key) == value for key, value in identity.items()):
                for key, value in data.items():
                    if value is not None:
                        row[key] = self._mq_copy(value)
                if optimistic_version:
                    row["version"] = int(row.get("version", 1)) + 1
                row["updated_at"] = now
                row["deleted_at"] = None
                return dict(row)
        record = {
            "id": self._next_id(table),
            "tenant_id": tenant_id,
            **{key: self._mq_copy(value) for key, value in defaults.items()},
            **{key: self._mq_copy(value) for key, value in data.items() if value is not None},
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        if optimistic_version:
            record["version"] = 1
        store.append(record)
        return dict(record)

    def _mq_get(self, store, tenant_id: int, record_id: int) -> dict[str, Any] | None:
        for row in store:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == record_id
                and row.get("deleted_at") is None
            ):
                return dict(row)
        return None

    def _mq_get_by(
        self, store, tenant_id: int, identity: dict[str, Any]
    ) -> dict[str, Any] | None:
        for row in store:
            if row["tenant_id"] != tenant_id or row.get("deleted_at") is not None:
                continue
            if all(row.get(key) == value for key, value in identity.items()):
                return dict(row)
        return None

    def _mq_list(
        self,
        store,
        tenant_id: int,
        *,
        filters: dict[str, Any] | None = None,
        query: str | None = None,
        query_fields: tuple[str, ...] = ("name",),
        limit: int,
        offset: int,
        sort_key: str = "updated_at",
    ) -> tuple[list[dict[str, Any]], int]:
        rows = [
            row
            for row in store
            if row["tenant_id"] == tenant_id and row.get("deleted_at") is None
        ]
        for key, value in (filters or {}).items():
            if value is not None:
                rows = [row for row in rows if row.get(key) == value]
        if query:
            needle = query.lower()
            rows = [
                row
                for row in rows
                if any(needle in str(row.get(field) or "").lower() for field in query_fields)
            ]
        rows.sort(key=lambda row: (str(row.get(sort_key) or ""), row["id"]), reverse=True)
        total = len(rows)
        page = rows[offset : offset + limit] if limit else []
        return [dict(row) for row in page], total

    def _mq_update(
        self, store, tenant_id: int, record_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for row in store:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == record_id
                and row.get("deleted_at") is None
            ):
                for key, value in fields.items():
                    row[key] = self._mq_copy(value)
                row["version"] = int(row.get("version", 1)) + 1
                row["updated_at"] = self._now()
                return dict(row)
        return None

    async def upsert_mfg_plant(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_plant", self._mfg_plants, tenant_id,
            {"plant_key": data["plant_key"]}, data,
            {"lifecycle_status": "active", "attributes": {}},
        )

    async def get_mfg_plant(self, tenant_id: int, plant_id: int) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_plants, tenant_id, plant_id)

    async def get_mfg_plant_by_key(
        self, tenant_id: int, plant_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(self._mfg_plants, tenant_id, {"plant_key": plant_key})

    async def list_mfg_plants(
        self, tenant_id: int, *, query: str | None, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_plants, tenant_id,
            filters={"lifecycle_status": lifecycle_status}, query=query,
            query_fields=("plant_key", "name", "site_code"), limit=limit, offset=offset,
        )

    async def update_mfg_plant(
        self, tenant_id: int, plant_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_plants, tenant_id, plant_id, fields)

    async def upsert_mfg_line(self, tenant_id: int, data: dict[str, Any]) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_line", self._mfg_lines, tenant_id,
            {"plant_id": data["plant_id"], "line_key": data["line_key"]}, data,
            {"lifecycle_status": "active", "attributes": {}},
        )

    async def get_mfg_line(self, tenant_id: int, line_id: int) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_lines, tenant_id, line_id)

    async def get_mfg_line_by_key(
        self, tenant_id: int, plant_id: int, line_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_lines, tenant_id,
            {"plant_id": plant_id, "line_key": line_key},
        )

    async def list_mfg_lines(
        self, tenant_id: int, *, plant_id: int | None, query: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_lines, tenant_id,
            filters={"plant_id": plant_id, "lifecycle_status": lifecycle_status},
            query=query, query_fields=("line_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_line(
        self, tenant_id: int, line_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_lines, tenant_id, line_id, fields)

    async def upsert_mfg_work_centre(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_work_centre", self._mfg_work_centres, tenant_id,
            {"plant_id": data["plant_id"], "work_centre_key": data["work_centre_key"]},
            data,
            {"lifecycle_status": "active", "work_centre_type": "other", "attributes": {}},
        )

    async def get_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_work_centres, tenant_id, work_centre_id)

    async def get_mfg_work_centre_by_key(
        self, tenant_id: int, plant_id: int, work_centre_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_work_centres, tenant_id,
            {"plant_id": plant_id, "work_centre_key": work_centre_key},
        )

    async def list_mfg_work_centres(
        self, tenant_id: int, *, plant_id: int | None, line_id: int | None,
        query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_work_centres, tenant_id,
            filters={"plant_id": plant_id, "line_id": line_id},
            query=query, query_fields=("work_centre_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_work_centre(
        self, tenant_id: int, work_centre_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_work_centres, tenant_id, work_centre_id, fields)

    async def upsert_mfg_process(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_process", self._mfg_processes, tenant_id,
            {"process_type": data["process_type"], "process_key": data["process_key"]},
            data,
            {"lifecycle_status": "draft", "revision": "A", "configuration": {}},
        )

    async def get_mfg_process(
        self, tenant_id: int, process_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_processes, tenant_id, process_id)

    async def get_mfg_process_by_key(
        self, tenant_id: int, process_type: str, process_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_processes, tenant_id,
            {"process_type": process_type, "process_key": process_key},
        )

    async def list_mfg_processes(
        self, tenant_id: int, *, process_type: str | None, root_item_id: int | None,
        mbom_header_id: int | None, query: str | None, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_processes, tenant_id,
            filters={
                "process_type": process_type,
                "root_item_id": root_item_id,
                "mbom_header_id": mbom_header_id,
                "lifecycle_status": lifecycle_status,
            },
            query=query, query_fields=("process_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_process(
        self, tenant_id: int, process_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_processes, tenant_id, process_id, fields)

    async def upsert_mfg_process_revision(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_process_revision", self._mfg_process_revisions, tenant_id,
            {"process_id": data["process_id"], "revision": data["revision"]}, data,
            {"lifecycle_status": "draft", "change_reason": "", "configuration": {}},
        )

    async def get_mfg_process_revision(
        self, tenant_id: int, revision_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_process_revisions, tenant_id, revision_id)

    async def get_mfg_process_revision_by_key(
        self, tenant_id: int, process_id: int, revision: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_process_revisions, tenant_id,
            {"process_id": process_id, "revision": revision},
        )

    async def list_mfg_process_revisions(
        self, tenant_id: int, *, process_id: int | None, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_process_revisions, tenant_id,
            filters={"process_id": process_id}, limit=limit, offset=offset,
        )

    async def update_mfg_process_revision(
        self, tenant_id: int, revision_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_process_revisions, tenant_id, revision_id, fields)

    async def upsert_mfg_operation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_operation", self._mfg_operations, tenant_id,
            {"process_id": data["process_id"], "operation_key": data["operation_key"]},
            data,
            {"lifecycle_status": "draft", "operation_type": "value_add",
             "sequence": 0, "attributes": {}},
        )

    async def get_mfg_operation(
        self, tenant_id: int, operation_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_operations, tenant_id, operation_id)

    async def get_mfg_operation_by_key(
        self, tenant_id: int, process_id: int, operation_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_operations, tenant_id,
            {"process_id": process_id, "operation_key": operation_key},
        )

    async def list_mfg_operations(
        self, tenant_id: int, *, process_id: int | None, work_centre_id: int | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_operations, tenant_id,
            filters={
                "process_id": process_id,
                "work_centre_id": work_centre_id,
                "lifecycle_status": lifecycle_status,
            },
            limit=limit, offset=offset, sort_key="sequence",
        )

    async def list_mfg_operations_by_process(
        self, tenant_id: int, process_id: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._mfg_operations
            if row["tenant_id"] == tenant_id
            and row.get("process_id") == process_id
            and row.get("deleted_at") is None
        ]
        rows.sort(key=lambda row: (int(row.get("sequence") or 0), row["id"]))
        return rows

    async def update_mfg_operation(
        self, tenant_id: int, operation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_operations, tenant_id, operation_id, fields)

    async def add_mfg_operation_dependency(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        for row in self._mfg_operation_dependencies:
            if (
                row["tenant_id"] == tenant_id
                and row["operation_id"] == data["operation_id"]
                and row["depends_on_operation_id"] == data["depends_on_operation_id"]
            ):
                return dict(row)
        record = {
            "id": self._next_id("mfg_operation_dependency"),
            "tenant_id": tenant_id,
            "process_id": data["process_id"],
            "operation_id": data["operation_id"],
            "depends_on_operation_id": data["depends_on_operation_id"],
            "dependency_type": data.get("dependency_type", "finish_to_start"),
            "lag_minutes": data.get("lag_minutes"),
            "created_at": self._now(),
        }
        self._mfg_operation_dependencies.append(record)
        return dict(record)

    async def list_mfg_operation_dependencies(
        self, tenant_id: int, *, process_id: int
    ) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self._mfg_operation_dependencies
            if row["tenant_id"] == tenant_id and row["process_id"] == process_id
        ]

    async def list_mfg_dependencies_for_operators(
        self, tenant_id: int, operation_ids: list[int]
    ) -> list[dict[str, Any]]:
        wanted = set(operation_ids)
        return [
            dict(row)
            for row in self._mfg_operation_dependencies
            if row["tenant_id"] == tenant_id and row["operation_id"] in wanted
        ]

    async def delete_mfg_operation_dependency(
        self, tenant_id: int, dependency_id: int
    ) -> bool:
        before = len(self._mfg_operation_dependencies)
        self._mfg_operation_dependencies[:] = [
            row for row in self._mfg_operation_dependencies
            if not (row["tenant_id"] == tenant_id and row["id"] == dependency_id)
        ]
        return len(self._mfg_operation_dependencies) != before

    async def add_mfg_operation_consumption(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("mfg_operation_consumption"),
            "tenant_id": tenant_id,
            "operation_id": data["operation_id"],
            "child_item_id": data["child_item_id"],
            "bom_line_id": data.get("bom_line_id"),
            "quantity": data.get("quantity", 1.0),
            "unit_of_measure": data.get("unit_of_measure", "EA"),
            "consumption_type": data.get("consumption_type", "component"),
            "notes": data.get("notes"),
            "external_id": data.get("external_id"),
            "source_system": data.get("source_system"),
            "source_ref": data.get("source_ref"),
            "created_by": data.get("created_by"),
            "created_at": self._now(),
            "updated_at": self._now(),
            "deleted_at": None,
        }
        self._mfg_operation_consumptions.append(record)
        return dict(record)

    async def list_mfg_operation_consumptions(
        self, tenant_id: int, *, operation_id: int | None, child_item_id: int | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._mfg_operation_consumptions
            if row["tenant_id"] == tenant_id and row.get("deleted_at") is None
        ]
        if operation_id is not None:
            rows = [row for row in rows if row["operation_id"] == operation_id]
        if child_item_id is not None:
            rows = [row for row in rows if row["child_item_id"] == child_item_id]
        return rows[:limit]

    async def delete_mfg_operation_consumption(
        self, tenant_id: int, consumption_id: int
    ) -> dict[str, Any] | None:
        for row in self._mfg_operation_consumptions:
            if (
                row["tenant_id"] == tenant_id
                and row["id"] == consumption_id
                and row.get("deleted_at") is None
            ):
                row["deleted_at"] = self._now()
                return dict(row)
        return None

    async def upsert_mfg_work_instruction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_work_instruction", self._mfg_work_instructions, tenant_id,
            {"instruction_key": data["instruction_key"]}, data,
            {"lifecycle_status": "draft", "revision": "A", "steps": [],
             "instruction_type": "text"},
        )

    async def get_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_work_instructions, tenant_id, instruction_id)

    async def get_mfg_work_instruction_by_key(
        self, tenant_id: int, instruction_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_work_instructions, tenant_id, {"instruction_key": instruction_key}
        )

    async def list_mfg_work_instructions(
        self, tenant_id: int, *, process_id: int | None, operation_id: int | None,
        query: str | None, lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_work_instructions, tenant_id,
            filters={
                "process_id": process_id,
                "operation_id": operation_id,
                "lifecycle_status": lifecycle_status,
            },
            query=query, query_fields=("instruction_key", "title"),
            limit=limit, offset=offset,
        )

    async def update_mfg_work_instruction(
        self, tenant_id: int, instruction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._mfg_work_instructions, tenant_id, instruction_id, fields
        )

    async def upsert_mfg_resource(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_resource", self._mfg_resources, tenant_id,
            {"resource_key": data["resource_key"]}, data,
            {"lifecycle_status": "active", "resource_kind": "tooling", "attributes": {}},
        )

    async def get_mfg_resource(
        self, tenant_id: int, resource_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._mfg_resources, tenant_id, resource_id)

    async def get_mfg_resource_by_key(
        self, tenant_id: int, resource_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_resources, tenant_id, {"resource_key": resource_key}
        )

    async def list_mfg_resources(
        self, tenant_id: int, *, resource_kind: str | None, plant_id: int | None,
        query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_resources, tenant_id,
            filters={"resource_kind": resource_kind, "plant_id": plant_id},
            query=query, query_fields=("resource_key", "name"),
            limit=limit, offset=offset,
        )

    async def update_mfg_resource(
        self, tenant_id: int, resource_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._mfg_resources, tenant_id, resource_id, fields)

    async def upsert_mfg_production_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "mfg_production_version", self._mfg_production_versions, tenant_id,
            {"item_id": data["item_id"], "version_key": data["version_key"]}, data,
            {"lifecycle_status": "draft", "configuration": {}},
        )

    async def get_mfg_production_version(
        self, tenant_id: int, production_version_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(
            self._mfg_production_versions, tenant_id, production_version_id
        )

    async def get_mfg_production_version_by_key(
        self, tenant_id: int, item_id: int, version_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._mfg_production_versions, tenant_id,
            {"item_id": item_id, "version_key": version_key},
        )

    async def list_mfg_production_versions(
        self, tenant_id: int, *, item_id: int | None, process_id: int | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._mfg_production_versions, tenant_id,
            filters={
                "item_id": item_id,
                "process_id": process_id,
                "lifecycle_status": lifecycle_status,
            },
            limit=limit, offset=offset,
        )

    async def update_mfg_production_version(
        self, tenant_id: int, production_version_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._mfg_production_versions, tenant_id, production_version_id, fields
        )

    async def upsert_quality_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "quality_issue", self._quality_issues, tenant_id,
            {"issue_key": data["issue_key"]}, data,
            {"status": "open", "severity": "medium", "issue_type": "nonconformance",
             "disposition": "none", "root_cause_status": "not_investigated",
             "attributes": {}},
        )

    async def get_quality_issue(
        self, tenant_id: int, issue_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._quality_issues, tenant_id, issue_id)

    async def get_quality_issue_by_key(
        self, tenant_id: int, issue_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(self._quality_issues, tenant_id, {"issue_key": issue_key})

    async def list_quality_issues(
        self, tenant_id: int, *, status: str | None, severity: str | None,
        issue_type: str | None, component_item_id: int | None,
        product_item_id: int | None, supplier_ref: str | None, plant_id: int | None,
        operation_id: int | None, query: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._quality_issues, tenant_id,
            filters={
                "status": status,
                "severity": severity,
                "issue_type": issue_type,
                "component_item_id": component_item_id,
                "product_item_id": product_item_id,
                "supplier_ref": supplier_ref,
                "plant_id": plant_id,
                "operation_id": operation_id,
            },
            query=query, query_fields=("issue_key", "title", "failure_code"),
            limit=limit, offset=offset,
        )

    async def update_quality_issue(
        self, tenant_id: int, issue_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._quality_issues, tenant_id, issue_id, fields)

    async def upsert_quality_inspection(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "quality_inspection", self._quality_inspections, tenant_id,
            {"inspection_key": data["inspection_key"]}, data,
            {"status": "planned", "inspection_type": "incoming",
             "result": {}, "attributes": {}},
        )

    async def get_quality_inspection(
        self, tenant_id: int, inspection_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._quality_inspections, tenant_id, inspection_id)

    async def get_quality_inspection_by_key(
        self, tenant_id: int, inspection_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._quality_inspections, tenant_id, {"inspection_key": inspection_key}
        )

    async def list_quality_inspections(
        self, tenant_id: int, *, status: str | None, inspection_type: str | None,
        quality_issue_id: int | None, operation_id: int | None, query: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._quality_inspections, tenant_id,
            filters={
                "status": status,
                "inspection_type": inspection_type,
                "quality_issue_id": quality_issue_id,
                "operation_id": operation_id,
            },
            query=query, query_fields=("inspection_key", "title"),
            limit=limit, offset=offset,
        )

    async def update_quality_inspection(
        self, tenant_id: int, inspection_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._quality_inspections, tenant_id, inspection_id, fields
        )

    async def add_quality_inspection_result(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("quality_inspection_result"),
            "tenant_id": tenant_id,
            "inspection_id": data["inspection_id"],
            "characteristic": data["characteristic"],
            "measured_value": data.get("measured_value"),
            "result": data.get("result", "unknown"),
            "defect_code": data.get("defect_code"),
            "defect_category": data.get("defect_category"),
            "notes": data.get("notes"),
            "created_by": data.get("created_by"),
            "created_at": self._now(),
        }
        self._quality_inspection_results.append(record)
        return dict(record)

    async def list_quality_inspection_results(
        self, tenant_id: int, *, inspection_id: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._quality_inspection_results
            if row["tenant_id"] == tenant_id
            and row["inspection_id"] == inspection_id
        ]
        rows.sort(key=lambda row: row["id"])
        return rows[:limit]

    async def add_quality_root_cause(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "id": self._next_id("quality_root_cause"),
            "tenant_id": tenant_id,
            "quality_issue_id": data["quality_issue_id"],
            "classification": data.get("classification", "other"),
            "description": data.get("description", ""),
            "is_hypothesis": data.get("is_hypothesis", True),
            "confirmed": data.get("confirmed", False),
            "confidence": data.get("confidence"),
            "evidence": list(data.get("evidence", [])),
            "created_by": data.get("created_by"),
            "updated_by": data.get("updated_by") or data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._quality_root_causes.append(record)
        return dict(record)

    async def get_quality_root_cause(
        self, tenant_id: int, root_cause_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._quality_root_causes, tenant_id, root_cause_id)

    async def list_quality_root_causes(
        self, tenant_id: int, *, quality_issue_id: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._quality_root_causes
            if row["tenant_id"] == tenant_id
            and row["quality_issue_id"] == quality_issue_id
            and row.get("deleted_at") is None
        ]
        return rows[:limit]

    async def update_quality_root_cause(
        self, tenant_id: int, root_cause_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._quality_root_causes, tenant_id, root_cause_id, fields
        )

    async def upsert_quality_action(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "quality_action", self._quality_actions, tenant_id,
            {"action_key": data["action_key"]}, data,
            {"status": "open", "action_type": "corrective",
             "effectiveness": "pending", "evidence": []},
        )

    async def get_quality_action(
        self, tenant_id: int, action_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._quality_actions, tenant_id, action_id)

    async def get_quality_action_by_key(
        self, tenant_id: int, action_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(self._quality_actions, tenant_id, {"action_key": action_key})

    async def list_quality_actions(
        self, tenant_id: int, *, quality_issue_id: int | None, status: str | None,
        action_type: str | None, owner_user: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._quality_actions, tenant_id,
            filters={
                "quality_issue_id": quality_issue_id,
                "status": status,
                "action_type": action_type,
                "owner_user": owner_user,
            },
            limit=limit, offset=offset,
        )

    async def update_quality_action(
        self, tenant_id: int, action_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._quality_actions, tenant_id, action_id, fields)

    async def add_quality_supplier_issue(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        now = self._now()
        record = {
            "id": self._next_id("quality_supplier_issue"),
            "tenant_id": tenant_id,
            "quality_issue_id": data["quality_issue_id"],
            "supplier_ref": data["supplier_ref"],
            "supplier_name": data.get("supplier_name"),
            "component_item_id": data.get("component_item_id"),
            "defect_category": data.get("defect_category"),
            "quantity_affected": data.get("quantity_affected"),
            "containment_ref": data.get("containment_ref"),
            "created_by": data.get("created_by"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._quality_supplier_issues.append(record)
        return dict(record)

    async def list_quality_supplier_issues(
        self, tenant_id: int, *, supplier_ref: str | None, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._quality_supplier_issues
            if row["tenant_id"] == tenant_id and row.get("deleted_at") is None
        ]
        if supplier_ref is not None:
            rows = [row for row in rows if row["supplier_ref"] == supplier_ref]
        rows.sort(key=lambda row: row["id"], reverse=True)
        return rows[:limit]

    # --- Predictive intelligence (Stage 10) ---------------------------
    async def upsert_predictive_feature_definition(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_feature_definition", self._predictive_feature_definitions,
            tenant_id, {"feature_key": data["feature_key"]}, data,
            {"entity_type": "any", "data_type": "number",
             "freshness_ttl_hours": 168, "lifecycle_status": "active"},
        )

    async def get_predictive_feature_definition(
        self, tenant_id: int, feature_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._predictive_feature_definitions, tenant_id, feature_id)

    async def get_predictive_feature_definition_by_key(
        self, tenant_id: int, feature_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_feature_definitions, tenant_id, {"feature_key": feature_key}
        )

    async def list_predictive_feature_definitions(
        self, tenant_id: int, *, entity_type: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_feature_definitions, tenant_id,
            filters={"entity_type": entity_type, "lifecycle_status": lifecycle_status},
            query_fields=("feature_key", "name"), limit=limit, offset=offset,
        )

    async def update_predictive_feature_definition(
        self, tenant_id: int, feature_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._predictive_feature_definitions, tenant_id, feature_id, fields
        )

    async def upsert_predictive_feature_value(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_feature_value", self._predictive_feature_values, tenant_id,
            {
                "feature_key": data["feature_key"],
                "entity_type": data["entity_type"],
                "entity_id": data["entity_id"],
            },
            data,
            {"lineage": []},
        )

    async def list_predictive_feature_values(
        self, tenant_id: int, *, feature_key: str | None, entity_type: str | None,
        entity_id: int | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_feature_values, tenant_id,
            filters={
                "feature_key": feature_key,
                "entity_type": entity_type,
                "entity_id": entity_id,
            },
            limit=limit, offset=offset,
        )

    async def upsert_predictive_dataset(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_dataset", self._predictive_datasets, tenant_id,
            {"dataset_key": data["dataset_key"]}, data,
            {"lifecycle_status": "draft", "feature_keys": []},
        )

    async def get_predictive_dataset(
        self, tenant_id: int, dataset_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._predictive_datasets, tenant_id, dataset_id)

    async def get_predictive_dataset_by_key(
        self, tenant_id: int, dataset_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_datasets, tenant_id, {"dataset_key": dataset_key}
        )

    async def list_predictive_datasets(
        self, tenant_id: int, *, lifecycle_status: str | None,
        limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_datasets, tenant_id,
            filters={"lifecycle_status": lifecycle_status},
            query_fields=("dataset_key", "name"), limit=limit, offset=offset,
        )

    async def update_predictive_dataset(
        self, tenant_id: int, dataset_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._predictive_datasets, tenant_id, dataset_id, fields)

    async def upsert_predictive_dataset_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_dataset_version", self._predictive_dataset_versions,
            tenant_id,
            {
                "dataset_id": data["dataset_id"],
                "version": data["version"],
                "split": data.get("split", "train"),
            },
            data,
            {"row_count": 0, "lifecycle_status": "draft"},
            optimistic_version=False,
        )

    async def list_predictive_dataset_versions(
        self, tenant_id: int, *, dataset_id: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._predictive_dataset_versions
            if row["tenant_id"] == tenant_id
            and row.get("deleted_at") is None
            and row["dataset_id"] == dataset_id
        ]
        rows.sort(key=lambda row: (row.get("version", 0), row["id"]), reverse=True)
        return rows[:limit]

    async def upsert_predictive_model(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_model", self._predictive_models, tenant_id,
            {"model_key": data["model_key"]}, data,
            {"method": "rule_based", "lifecycle_status": "draft"},
        )

    async def get_predictive_model(
        self, tenant_id: int, model_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._predictive_models, tenant_id, model_id)

    async def get_predictive_model_by_key(
        self, tenant_id: int, model_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_models, tenant_id, {"model_key": model_key}
        )

    async def list_predictive_models(
        self, tenant_id: int, *, prediction_type: str | None,
        lifecycle_status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_models, tenant_id,
            filters={
                "prediction_type": prediction_type,
                "lifecycle_status": lifecycle_status,
            },
            query_fields=("model_key", "name"), limit=limit, offset=offset,
        )

    async def update_predictive_model(
        self, tenant_id: int, model_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(self._predictive_models, tenant_id, model_id, fields)

    async def upsert_predictive_model_version(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_model_version", self._predictive_model_versions, tenant_id,
            {"model_id": data["model_id"], "version": data["version"]}, data,
            {"method": "rule_based", "lifecycle_status": "draft"},
            optimistic_version=False,
        )

    async def list_predictive_model_versions(
        self, tenant_id: int, *, model_id: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._predictive_model_versions
            if row["tenant_id"] == tenant_id
            and row.get("deleted_at") is None
            and row["model_id"] == model_id
        ]
        rows.sort(key=lambda row: row["id"], reverse=True)
        return rows[:limit]

    async def upsert_predictive_prediction(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_prediction", self._predictive_predictions, tenant_id,
            {"prediction_key": data["prediction_key"]}, data,
            {"method": "rule_based", "risk_category": "unknown",
             "severity": "unknown", "status": "active"},
        )

    async def get_predictive_prediction(
        self, tenant_id: int, prediction_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._predictive_predictions, tenant_id, prediction_id)

    async def get_predictive_prediction_by_key(
        self, tenant_id: int, prediction_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_predictions, tenant_id, {"prediction_key": prediction_key}
        )

    async def find_predictive_prediction_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_predictions, tenant_id,
            {"idempotency_key": idempotency_key},
        )

    async def list_predictive_predictions(
        self, tenant_id: int, *, prediction_type: str | None,
        subject_type: str | None, subject_id: int | None,
        risk_category: str | None, status: str | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_predictions, tenant_id,
            filters={
                "prediction_type": prediction_type,
                "subject_type": subject_type,
                "subject_id": subject_id,
                "risk_category": risk_category,
                "status": status,
            },
            query_fields=("prediction_key", "subject_key"),
            limit=limit, offset=offset, sort_key="generated_at",
        )

    async def update_predictive_prediction(
        self, tenant_id: int, prediction_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._predictive_predictions, tenant_id, prediction_id, fields
        )

    async def upsert_predictive_recommendation(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_recommendation", self._predictive_recommendations,
            tenant_id, {"recommendation_key": data["recommendation_key"]}, data,
            {"status": "new", "severity": "medium", "priority": "medium"},
        )

    async def get_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(
            self._predictive_recommendations, tenant_id, recommendation_id
        )

    async def get_predictive_recommendation_by_key(
        self, tenant_id: int, recommendation_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_recommendations, tenant_id,
            {"recommendation_key": recommendation_key},
        )

    async def find_predictive_recommendation_by_idempotency(
        self, tenant_id: int, idempotency_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_recommendations, tenant_id,
            {"idempotency_key": idempotency_key},
        )

    async def list_predictive_recommendations(
        self, tenant_id: int, *, status: str | None, severity: str | None,
        priority: str | None, prediction_id: int | None,
        owner_role: str | None, overdue_only: bool, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        rows, total = self._mq_list(
            self._predictive_recommendations, tenant_id,
            filters={
                "status": status,
                "severity": severity,
                "priority": priority,
                "prediction_id": prediction_id,
                "owner_role": owner_role,
            },
            query_fields=("recommendation_key", "title"),
            limit=limit, offset=offset,
        )
        if not overdue_only:
            return rows, total
        now = self._now()
        overdue = [
            row for row in rows
            if row.get("due_at") is not None
            and str(row["due_at"]) < str(now)
            and row.get("status") in {"new", "under_review", "accepted", "deferred"}
        ]
        return overdue, len(overdue)

    async def update_predictive_recommendation(
        self, tenant_id: int, recommendation_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._predictive_recommendations, tenant_id, recommendation_id, fields
        )

    async def add_predictive_recommendation_feedback(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        record = {
            "id": self._next_id("predictive_recommendation_feedback"),
            "tenant_id": tenant_id,
            "recommendation_id": data["recommendation_id"],
            "reviewer": data.get("reviewer"),
            "decision": data.get("decision", "comment"),
            "comment": data.get("comment", ""),
            "outcome": data.get("outcome"),
            "risk_before": data.get("risk_before"),
            "risk_after": data.get("risk_after"),
            "created_at": self._now(),
        }
        self._predictive_recommendation_feedback.append(record)
        return dict(record)

    async def list_predictive_recommendation_feedback(
        self, tenant_id: int, *, recommendation_id: int, limit: int
    ) -> list[dict[str, Any]]:
        rows = [
            dict(row)
            for row in self._predictive_recommendation_feedback
            if row["tenant_id"] == tenant_id
            and row["recommendation_id"] == recommendation_id
        ]
        rows.sort(key=lambda row: row["created_at"], reverse=True)
        return rows[:limit]

    async def upsert_predictive_schedule(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        return self._mq_upsert(
            "predictive_schedule", self._predictive_schedules, tenant_id,
            {"schedule_key": data["schedule_key"]}, data,
            {"interval_seconds": 86400, "enabled": True},
        )

    async def get_predictive_schedule(
        self, tenant_id: int, schedule_id: int
    ) -> dict[str, Any] | None:
        return self._mq_get(self._predictive_schedules, tenant_id, schedule_id)

    async def get_predictive_schedule_by_key(
        self, tenant_id: int, schedule_key: str
    ) -> dict[str, Any] | None:
        return self._mq_get_by(
            self._predictive_schedules, tenant_id, {"schedule_key": schedule_key}
        )

    async def list_predictive_schedules(
        self, tenant_id: int, *, enabled: bool | None, limit: int, offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        return self._mq_list(
            self._predictive_schedules, tenant_id,
            filters={"enabled": enabled},
            query_fields=("schedule_key",),
            limit=limit, offset=offset,
        )

    async def update_predictive_schedule(
        self, tenant_id: int, schedule_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        return self._mq_update(
            self._predictive_schedules, tenant_id, schedule_id, fields
        )

    async def list_due_predictive_schedules(
        self, *, limit: int
    ) -> list[dict[str, Any]]:
        now = self._now()
        rows = [
            dict(row)
            for row in self._predictive_schedules
            if row.get("deleted_at") is None
            and row.get("enabled")
            and row.get("next_run_at") is not None
            and str(row["next_run_at"]) <= str(now)
        ]
        rows.sort(key=lambda row: str(row["next_run_at"]))
        return rows[:limit]


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=False))
    norm_left = math.sqrt(sum(a * a for a in left)) or 1.0
    norm_right = math.sqrt(sum(b * b for b in right)) or 1.0
    return dot / (norm_left * norm_right)

