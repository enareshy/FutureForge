from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import (
    get_ai_repository,
    get_model_gateway,
    get_object_storage,
    get_principal,
)
from ai_api.application.services.citation_validation import (
    ANSWER_STATUS_ANSWERED,
    ANSWER_STATUS_CITATION_WARNING,
    ANSWER_STATUS_INSUFFICIENT,
    validate_extraction_citations,
    validate_inline_citations,
)
from ai_api.application.services.model_gateway import ModelGateway
from ai_api.config.settings import Settings
from ai_api.domain.errors import ProviderError
from ai_api.domain.models.provider import (
    ChatRequest,
    ChatResponse,
    ModelCapability,
    ModelSpec,
    ProviderKind,
    TokenUsage,
)
from ai_api.infrastructure.providers.registry import build_default_registry
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import InMemoryObjectStorage
from ai_api.main import create_app
from ai_api.security.policies import Principal

TENANT = 1
POWER_USER = frozenset({"*:*"})
MODEL = "rec-chat"


def _principal(username: str = "tester", tenant_id: int = TENANT) -> Principal:
    return Principal(
        user_id=username,
        username=username,
        tenant_id=tenant_id,
        actor_id=1,
        permissions=POWER_USER,
    )


class _StaticLLMProvider:
    code = "rec"

    def __init__(
        self,
        content: str,
        *,
        chunks: list[str] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.content = content
        self.chunks = chunks or [content]
        self.error = error
        self.requests: list[ChatRequest] = []

    async def generate(self, spec: ModelSpec, request: ChatRequest) -> ChatResponse:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return ChatResponse(
            content=self.content,
            model=spec.code,
            provider=self.code,
            usage=TokenUsage.create(10, 5),
            finish_reason="stop",
            is_mock=True,
        )

    async def stream(
        self, spec: ModelSpec, request: ChatRequest
    ) -> AsyncIterator[str]:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        for chunk in self.chunks:
            yield chunk

    async def health(self) -> bool:
        return True


def _gateway(provider: _StaticLLMProvider) -> ModelGateway:
    settings = Settings()
    registry = build_default_registry(settings)
    registry.register_llm(provider.code, provider)
    registry.register_model(
        ModelSpec(
            code=MODEL,
            provider_code=provider.code,
            capability=ModelCapability(
                kind=ProviderKind.llm,
                supports_streaming=True,
                supports_json_mode=True,
            ),
            is_mock=True,
        )
    )
    return ModelGateway(registry=registry, settings=settings)


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    provider: _StaticLLMProvider,
    *,
    principal: Principal | None = None,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    storage = InMemoryObjectStorage()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: principal or _principal()
    app.dependency_overrides[get_model_gateway] = lambda: _gateway(provider)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture()
def repository() -> InMemoryAiRepository:
    return InMemoryAiRepository()


def _ingest(client: TestClient, code: str, text: str) -> None:
    source = client.post(
        "/api/v1/ai/knowledge/sources",
        json={"code": code, "name": code, "kind": "manual"},
    )
    assert source.status_code == 201, source.text
    response = client.post(
        f"/api/v1/ai/knowledge/sources/{source.json()['id']}/ingest",
        json={
            "documents": [
                {
                    "external_id": f"{code}-doc",
                    "title": code,
                    "text": text,
                }
            ]
        },
    )
    assert response.status_code == 202, response.text
    assert response.json()["job"]["status"] == "succeeded"


def _conversation(client: TestClient) -> int:
    response = client.post(
        "/api/v1/ai/assistant/conversations", json={"title": "Citations"}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _citation(rank: int, *, document_id: int | None = None) -> dict[str, Any]:
    return {
        "rank": rank,
        "source_id": 1,
        "document_id": document_id or 10 + rank,
        "chunk_id": 100 + rank,
        "source_code": "knowledge",
        "chunk_index": rank - 1,
    }


def test_validator_distinguishes_missing_and_invalid_citations() -> None:
    citations = [_citation(1), _citation(2)]

    valid = validate_inline_citations("Uses [1] and [2].", citations, required=True)
    assert valid.status == "valid"
    assert valid.answer_status() == ANSWER_STATUS_ANSWERED

    missing = validate_inline_citations("No marker here.", citations, required=True)
    assert missing.status == "missing"
    assert missing.warnings == ("no_citation_markers",)
    assert missing.answer_status() == ANSWER_STATUS_CITATION_WARNING

    invalid = validate_inline_citations("Uses [3].", citations, required=True)
    assert invalid.status == "invalid"
    assert invalid.warnings == ("invalid_citation_references",)
    assert invalid.answer_status() == ANSWER_STATUS_CITATION_WARNING

    malformed = validate_inline_citations("Uses [cite: 1].", citations, required=True)
    assert malformed.status == "invalid"
    assert "malformed_citation_markers" in malformed.warnings

    none_folder = validate_inline_citations("Answer.", [], required=True)
    assert none_folder.status == "missing"
    assert none_folder.warnings == ("no_citations_available",)


def test_validator_reports_metadata_duplicates_and_unmatched_evidence() -> None:
    citations = [
        _citation(1, document_id=10),
        {**_citation(2, document_id=10), "chunk_id": 101},
    ]
    citations[0]["document_id"] = 10
    citations[0]["chunk_id"] = 100
    citations[1]["chunk_id"] = 100

    duplicate = validate_inline_citations("Uses [1] [2].", citations, required=True)
    assert duplicate.status == "invalid"
    assert "duplicate_citation_references" in duplicate.warnings

    unmatched = validate_inline_citations(
        "Uses [1].",
        citations[:1],
        required=True,
        evidence=[{"document_id": 99, "chunk_id": 999}],
    )
    assert unmatched.status == "invalid"
    assert "unmatched_citation_evidence" in unmatched.warnings

    incomplete = validate_inline_citations(
        "Uses [1].", [{"rank": 1}], required=True
    )
    assert incomplete.status == "invalid"
    assert "invalid_citation_metadata" in incomplete.warnings


def test_validator_optional_and_insufficient_precedence() -> None:
    optional = validate_inline_citations("No evidence contract.", [], required=False)
    assert optional.status == "not_required"
    assert optional.answer_status() == ANSWER_STATUS_ANSWERED

    failed = validate_inline_citations("No marker.", [_citation(1)], required=True)
    assert failed.answer_status(insufficient=True) == ANSWER_STATUS_INSUFFICIENT


def test_extraction_validator_marks_missing_and_invalid_field_evidence() -> None:
    fields = [{"name": "owner", "type": "string"}, {"name": "interval", "type": "string"}]

    valid = validate_extraction_citations(
        {
            "fields": {"owner": "Facilities", "interval": "90 days"},
            "evidence": {"owner": [1], "interval": [2]},
        },
        fields=fields,
    )
    assert valid.status == "valid"

    missing = validate_extraction_citations(
        {"fields": {"owner": "Facilities", "interval": "90 days"}, "evidence": {}},
        fields=fields,
    )
    assert missing.status == "missing"
    assert missing.warnings == ("missing_extraction_citation",)

    invalid = validate_extraction_citations(
        {
            "fields": {"owner": "Facilities", "interval": "90 days"},
            "evidence": {"owner": [0], "interval": ["one"]},
        },
        fields=fields,
    )
    assert invalid.status == "invalid"
    assert invalid.warnings == ("invalid_extraction_citation",)

    absent = validate_extraction_citations(None, fields=fields)
    assert absent.status == "invalid"
    assert absent.warnings == ("invalid_extraction_output",)


def test_rag_response_and_audit_expose_citation_warnings(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider("The pump needs lubrication [9].")
    with _client(repository, provider) as client:
        _ingest(client, "maintenance", "The pump requires quarterly lubrication.")
        response = client.post(
            "/api/v1/ai/rag/query",
            json={"query": "How often does the pump need lubrication?", "model": MODEL},
        )
        audit = client.get("/api/v1/ai/audit")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["answer_status"] == ANSWER_STATUS_CITATION_WARNING
    assert body["citations_required"] is True
    assert body["citation_status"] == "invalid"
    assert "invalid_citation_references" in body["warnings"]
    entry = next(
        item for item in audit.json()["items"] if item["action"] == "ai.rag.query"
    )
    assert entry["detail"]["citation_status"] == "invalid"
    assert entry["detail"]["answer_status"] == ANSWER_STATUS_CITATION_WARNING


def test_copilot_non_stream_persists_citation_warnings(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider("The pump needs lubrication [9].")
    with _client(repository, provider) as client:
        _ingest(client, "maintenance", "The pump requires quarterly lubrication.")
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={"content": "How often does the pump need lubrication?", "model": MODEL},
        )
        assert response.status_code == 201, response.text
        message = response.json()
        assert message["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert message["citation_status"] == "invalid"
        assert message["citations_required"] is True
        assert "invalid_citation_references" in message["warnings"]

        messages = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        ).json()
        persisted = next(item for item in messages["items"] if item["id"] == message["id"])
        assert persisted["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert persisted["warnings"] == message["warnings"]
        assert persisted["citation_status"] == "invalid"


def test_copilot_stream_and_non_stream_status_parity(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider(
        "The pump needs lubrication [9].",
        chunks=["The pump needs ", "lubrication [9]."],
    )
    with _client(repository, provider) as client:
        _ingest(client, "maintenance", "The pump requires quarterly lubrication.")
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages/stream",
            json={"content": "How often does the pump need lubrication?", "model": MODEL},
        )
        assert response.status_code == 200, response.text
        frames = [
            json.loads(line[len("data: ") :])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]
        done = frames[-1]
        assert done["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert done["citation_status"] == "invalid"
        assert "invalid_citation_references" in done["warnings"]

        messages = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        ).json()
        persisted = next(item for item in messages["items"] if item["role"] == "assistant")
        assert persisted["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert persisted["citation_status"] == "invalid"


def test_copilot_extraction_persists_missing_citation_status(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider(
        json.dumps({"fields": {"owner": "Facilities"}, "missing": [], "evidence": {}})
    )
    with _client(repository, provider) as client:
        _ingest(client, "spec", "Owner: Facilities.")
        document_id = client.get(
            "/api/v1/ai/knowledge/sources/1/documents"
        ).json()["items"][0]["id"]
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={
                "content": "Extract the owner",
                "task": "extract",
                "model": MODEL,
                "context": [{"type": "knowledge_document", "id": str(document_id)}],
                "fields": [{"name": "owner", "type": "string"}],
            },
        )
        assert response.status_code == 201, response.text
        message = response.json()
        assert message["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert message["citation_status"] == "missing"
        assert "missing_extraction_citation" in message["warnings"]


def test_agent_execute_exposes_and_persists_citation_status(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider("The pump needs lubrication [9].")
    with _client(repository, provider) as client:
        _ingest(client, "maintenance", "The pump requires quarterly lubrication.")
        agent = next(
            item
            for item in client.get("/api/v1/ai/agents").json()
            if item["code"] == "knowledge-assistant"
        )
        response = client.post(
            f"/api/v1/ai/agents/{agent['id']}/execute",
            json={"input": "How often does the pump need lubrication?", "model": MODEL},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert body["citation_status"] == "invalid"
        assert "invalid_citation_references" in body["warnings"]

        result = client.get(
            f"/api/v1/ai/agent-executions/{body['execution_id']}/result"
        )
        assert result.status_code == 200, result.text
        output = result.json()["output"]
        assert output["answer_status"] == ANSWER_STATUS_CITATION_WARNING
        assert output["citation_status"] == "invalid"
        assert "invalid_citation_references" in output["warnings"]


def test_agent_insufficient_evidence_uses_canonical_status(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider("unused")
    with _client(repository, provider) as client:
        agent = next(
            item
            for item in client.get("/api/v1/ai/agents").json()
            if item["code"] == "knowledge-assistant"
        )
        response = client.post(
            f"/api/v1/ai/agents/{agent['id']}/execute",
            json={"input": "What is the vacation policy?", "model": MODEL},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["insufficient_evidence"] is True
    assert body["answer_status"] == ANSWER_STATUS_INSUFFICIENT
    assert body["citation_status"] == "not_required"
    assert body["warnings"] == ["insufficient_authorized_evidence"]


def test_generation_failure_is_persisted_as_error_not_answered(
    repository: InMemoryAiRepository,
) -> None:
    provider = _StaticLLMProvider("", error=ProviderError("provider down"))
    with _client(repository, provider) as client:
        _ingest(client, "maintenance", "The pump requires quarterly lubrication.")
        conversation_id = _conversation(client)
        response = client.post(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages",
            json={"content": "How often does the pump need lubrication?", "model": MODEL},
        )
        assert response.status_code >= 500, response.text
        messages = client.get(
            f"/api/v1/ai/assistant/conversations/{conversation_id}/messages"
        ).json()

    persisted = next(item for item in messages["items"] if item["role"] == "assistant")
    assert persisted["generation_status"] == "failed"
    assert persisted["answer_status"] == "error"
    assert persisted["warnings"] == ["generation_failed"]


def test_validation_warnings_do_not_leak_evidence_metadata() -> None:
    citations = [_citation(1)]
    citations[0]["document_id"] = 4242
    citations[0]["source_code"] = "secret-source-code"
    result = validate_inline_citations(
        "No marker.",
        citations,
        required=True,
        evidence=[
            {
                "document_id": 4242,
                "chunk_id": 101,
                "source_code": "secret-source-code",
                "content": "confidential body text",
            }
        ],
    )
    rendered = " ".join(result.warnings)
    assert "secret-source-code" not in rendered
    assert "confidential" not in rendered
    assert "4242" not in rendered

