"""In-memory AiRepository for tests and local development without a database."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from itertools import count
from typing import Any
from uuid import uuid4


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

    @staticmethod
    def _public_source(record: dict[str, Any]) -> dict[str, Any]:
        return {
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
                    "source_id": source["id"],
                    "source_code": source["code"],
                    "source_name": source["name"],
                }
            )
        return results

    async def create_or_replace_document(
        self, tenant_id: int, data: dict[str, Any]
    ) -> dict[str, Any]:
        doomed = [
            d
            for d in self._documents
            if d["tenant_id"] == tenant_id
            and d["source_id"] == data["source_id"]
            and d["external_id"] == data["external_id"]
        ]
        doomed_ids = {d["id"] for d in doomed}
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
            "source_id": data["source_id"],
            "external_id": data["external_id"],
        }
        self._documents.append(record)
        return dict(record)

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
        self, tenant_id: int, source_id: int, *, limit: int, offset: int
    ) -> tuple[list[dict[str, Any]], int]:
        items = [
            d
            for d in self._documents
            if d["tenant_id"] == tenant_id and d["source_id"] == source_id
        ]
        page = sorted(items, key=lambda d: d["created_at"], reverse=True)[offset : offset + limit]
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
            }
            for c in self._chunks
            if c["tenant_id"] == tenant_id and c["document_id"] in document_ids
        ]
        rows.sort(key=lambda r: (r["document_id"], r["chunk_index"]))
        return rows

    async def get_document(
        self, tenant_id: int, document_id: int
    ) -> dict[str, Any] | None:
        for document in self._documents:
            if document["tenant_id"] == tenant_id and document["id"] == document_id:
                return dict(document)
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
        self, tenant_id: int, job_id: int, fields: dict[str, Any]
    ) -> dict[str, Any] | None:
        for job in self._jobs:
            if job["tenant_id"] == tenant_id and job["id"] == job_id:
                job.update(fields)
                return dict(job)
        return None

    async def list_jobs_by_status(
        self, status: str, *, limit: int
    ) -> list[dict[str, Any]]:
        jobs = [dict(j) for j in self._jobs if j["status"] == status]
        jobs.sort(key=lambda j: j["id"])
        return jobs[:limit]

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
            "confidence": data.get("confidence"),
            "is_mock": data.get("is_mock"),
            "model_code": data.get("model_code"),
            "provider_code": data.get("provider_code"),
            "token_usage": data.get("token_usage", {}),
            "latency_ms": data.get("latency_ms"),
            "execution_id": data.get("execution_id"),
            "request_id": data.get("request_id"),
            "error": data.get("error"),
            "created_at": self._now(),
        }
        self._messages.append(record)
        return dict(record)

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


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=False))
    norm_left = math.sqrt(sum(a * a for a in left)) or 1.0
    norm_right = math.sqrt(sum(b * b for b in right)) or 1.0
    return dot / (norm_left * norm_right)
