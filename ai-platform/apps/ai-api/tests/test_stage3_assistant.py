from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.application.services.retrieval_service import RetrievalService
from ai_api.config.settings import get_settings
from ai_api.domain.errors import ValidationError, classify_error
from ai_api.infrastructure.ingestion.validation import sniff_family, validate_upload
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import InMemoryObjectStorage
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})


@contextmanager
def _client(repository: InMemoryAiRepository) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    storage = InMemoryObjectStorage()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: _principal()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _principal(username: str = "tester") -> Principal:
    return Principal(
        user_id=username, username=username, tenant_id=TENANT, permissions=POWER_USER
    )


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _create_source(client: TestClient, code: str = "docs") -> int:
    response = client.post(
        "/api/v1/ai/knowledge/sources",
        json={"code": code, "name": code, "kind": "file"},
    )
    assert response.status_code == 201
    return response.json()["id"]


# --- Upload validation (unit) -------------------------------------------


def test_validate_upload_accepts_plain_text() -> None:
    assert (
        validate_upload(b"hello world", filename="a.txt", declared_mime="text/plain", max_bytes=100)
        == "text/plain"
    )


def test_validate_upload_accepts_pdf_signature() -> None:
    data = b"%PDF-1.7\n...\n%%EOF"
    assert (
        validate_upload(data, filename="a.pdf", declared_mime="application/pdf", max_bytes=1000)
        == "application/pdf"
    )


def test_validate_upload_rejects_text_declared_as_pdf() -> None:
    with pytest.raises(ValidationError):
        validate_upload(
            b"just text", filename="a.pdf", declared_mime="application/pdf", max_bytes=100
        )


def test_validate_upload_rejects_binary_payload() -> None:
    with pytest.raises(ValidationError):
        validate_upload(
            b"\x00\x01\x02binary", filename="a.txt", declared_mime="text/plain", max_bytes=100
        )


def test_validate_upload_rejects_oversize_and_empty() -> None:
    with pytest.raises(ValidationError):
        validate_upload(b"abc", filename="a.txt", declared_mime="text/plain", max_bytes=2)
    with pytest.raises(ValidationError):
        validate_upload(b"", filename="a.txt", declared_mime="text/plain", max_bytes=100)


def test_validate_upload_rejects_unsupported_format() -> None:
    with pytest.raises(ValidationError):
        validate_upload(b"data", filename="a.docx", declared_mime=None, max_bytes=100)


def test_sniff_family_detects_pdf_despite_extension() -> None:
    assert sniff_family(b"%PDF-1.7 something") == "pdf"


# --- Error classification -----------------------------------------------


def test_classify_error_maps_exceptions() -> None:
    assert classify_error(ValidationError("bad")) == "validation"
    assert classify_error(TimeoutError()) == "timeout"
    assert classify_error(ValueError("x")) == "internal"


# --- Reciprocal rank fusion (unit) --------------------------------------


def _retrieval_service() -> RetrievalService:
    return RetrievalService(
        repository=InMemoryAiRepository(),
        gateway=None,  # type: ignore[arg-type]
        governance=None,  # type: ignore[arg-type]
        audit=None,  # type: ignore[arg-type]
        access=None,  # type: ignore[arg-type]
        settings=get_settings(),
    )


def test_rrf_fusion_prefers_chunks_in_both_lists() -> None:
    service = _retrieval_service()
    vector = [{"chunk_id": 1, "score": 0.9}, {"chunk_id": 2, "score": 0.5}]
    lexical = [{"chunk_id": 2, "score": 3.0}, {"chunk_id": 3, "score": 2.0}]
    fused = service._fuse([vector, lexical])
    assert [item["chunk_id"] for item in fused][0] == 2
    assert all("score" in item for item in fused)


def test_single_list_preserves_similarity_scores() -> None:
    service = _retrieval_service()
    vector = [{"chunk_id": 1, "score": 0.9}]
    fused = service._fuse([vector])
    assert fused == vector


# --- Upload → index → ask (end to end) ----------------------------------


def test_upload_indexes_and_deduplicates(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "manuals")
        content = b"# Pump\n\nThe pump requires quarterly lubrication of its bearings."
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={"file": ("pump.md", content, "text/markdown")},
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["document"]["deduplicated"] is False
        assert body["document"]["mime_type"] == "text/markdown"
        assert body["job"]["status"] == "succeeded"

        documents = client.get(
            f"/api/v1/ai/knowledge/sources/{source_id}/documents"
        ).json()
        assert documents["meta"]["total"] == 1

        # Re-uploading identical content is detected by checksum.
        again = client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={"file": ("pump-copy.md", content, "text/markdown")},
        )
        assert again.status_code == 202
        assert again.json()["document"]["deduplicated"] is True
        assert again.json()["job"] is None


def test_upload_then_rag_returns_citation(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "maintenance")
        client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={
                "file": (
                    "pump.txt",
                    b"The pump requires quarterly lubrication of its bearings.",
                    "text/plain",
                )
            },
        )
        response = client.post(
            "/api/v1/ai/rag/query", json={"query": "What maintenance does the pump need?"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["insufficient_evidence"] is False
        assert body["citations"]
        assert body["citations"][0]["source_code"] == "maintenance"


def test_upload_rejects_over_policy_size(repository: InMemoryAiRepository, monkeypatch) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "small")
        settings = get_settings()
        monkeypatch.setattr(settings, "ai_upload_max_bytes", 8)
        response = client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={"file": ("big.txt", b"this content is far too large", "text/plain")},
        )
        assert response.status_code == 422


# --- Reindex and retry endpoints ----------------------------------------


def test_reindex_source_requeues_documents(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "handbook")
        client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={"file": ("h.txt", b"handbook body text", "text/plain")},
        )
        response = client.post(f"/api/v1/ai/knowledge/sources/{source_id}/reindex")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["source_id"] == source_id
        assert body["result"]["documents"] == 1


def test_retry_job_returns_404_for_unknown_job(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        response = client.post("/api/v1/ai/knowledge/jobs/999999/retry")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "not_found"


def test_retry_job_is_a_noop_for_succeeded_job(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "retryable")
        upload = client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={"file": ("r.txt", b"retryable body", "text/plain")},
        )
        job_id = upload.json()["job"]["id"]
        response = client.post(f"/api/v1/ai/knowledge/jobs/{job_id}/retry")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "succeeded"


# --- Assistant conversation lifecycle -----------------------------------


def test_assistant_conversation_lifecycle(repository: InMemoryAiRepository) -> None:
    with _client(repository) as client:
        source_id = _create_source(client, "wiki")
        client.post(
            f"/api/v1/ai/knowledge/sources/{source_id}/upload",
            files={
                "file": (
                    "vpn.txt",
                    b"Remote access requires the corporate VPN client.",
                    "text/plain",
                )
            },
        )
        conversation = client.post(
            "/api/v1/ai/assistant/conversations", json={"title": "Access"}
        ).json()
        assert conversation["message_count"] == 0

        reply = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation['id']}/messages",
            json={"content": "How do I get remote access?"},
        )
        assert reply.status_code == 201, reply.text
        message = reply.json()
        assert message["role"] == "assistant"
        assert message["answer_status"] == "answered"
        assert message["sources"]

        listing = client.get("/api/v1/ai/assistant/conversations").json()
        assert listing["meta"]["total"] == 1
        assert listing["items"][0]["message_count"] == 2

        detail = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation['id']}"
        ).json()
        assert len(detail["messages"]) == 2

        feedback = client.post(
            "/api/v1/ai/assistant/feedback",
            json={"message_id": message["id"], "rating": 1},
        )
        assert feedback.status_code == 201

        deleted = client.delete(
            f"/api/v1/ai/assistant/conversations/{conversation['id']}"
        )
        assert deleted.status_code == 204
        assert (
            client.get(f"/api/v1/ai/assistant/conversations/{conversation['id']}").status_code
            == 404
        )
