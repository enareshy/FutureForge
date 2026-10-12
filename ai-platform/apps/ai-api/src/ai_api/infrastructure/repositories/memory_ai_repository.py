"""In-memory AiRepository for tests and local development without a database."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from itertools import count
from typing import Any


class InMemoryAiRepository:
    def __init__(self) -> None:
        self._sources: list[dict[str, Any]] = []
        self._jobs: list[dict[str, Any]] = []
        self._executions: list[dict[str, Any]] = []
        self._usage: list[dict[str, Any]] = []
        self._audit: list[dict[str, Any]] = []
        self._agents: list[dict[str, Any]] = []
        self._governance: dict[int, dict[str, Any]] = {}
        self._documents: list[dict[str, Any]] = []
        self._chunks: list[dict[str, Any]] = []
        self._embeddings: list[dict[str, Any]] = []
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
            "payload": data.get("payload", {}),
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
            "checksum": data.get("checksum"),
            "size_bytes": data.get("size_bytes"),
            "classification": data.get("classification", "internal"),
            "acl": data.get("acl", {}),
            "metadata": data.get("metadata", {}),
            "status": "indexed",
            "indexed_at": self._now(),
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
                "chunk_index": c["chunk_index"],
                "content": c["content"],
                "classification": c.get("classification", "internal"),
                "acl": c.get("acl", {}),
                "metadata": c.get("metadata", {}),
            }
            for c in self._chunks
            if c["tenant_id"] == tenant_id and c["document_id"] in document_ids
        ]
        rows.sort(key=lambda r: (r["document_id"], r["chunk_index"]))
        return rows

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


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=False))
    norm_left = math.sqrt(sum(a * a for a in left)) or 1.0
    norm_right = math.sqrt(sum(b * b for b in right)) or 1.0
    return dot / (norm_left * norm_right)
