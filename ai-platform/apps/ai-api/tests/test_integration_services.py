"""Integration tests against external backing services (Phase 13).

These tests are **opt-in**: each backing service is exercised only when the
operator explicitly enables it via an ``AI_TEST_*`` environment variable (and, for
network services, only when the endpoint is reachable). This keeps the default
suite hermetic and fast while still providing real integration coverage - notably
PostgreSQL + pgvector, which is part of the platform's mandatory stack.

Enable examples:

    AI_TEST_POSTGRES=1 pytest -m integration tests/test_integration_services.py
    AI_TEST_REDIS=1 AI_TEST_KAFKA=1 pytest -m integration

The optional live LLM provider test is separate from the mock-based suites and
must be explicitly opted into (`AI_TEST_LIVE_LLM=1`) with real provider config.
"""

from __future__ import annotations

import asyncio
import os
import socket
from urllib.parse import urlparse

import httpx
import pytest

from ai_api.config.settings import get_settings

pytestmark = pytest.mark.integration


def _enabled(name: str) -> bool:
    return os.environ.get(f"AI_TEST_{name.upper()}", "") == "1"


def _tcp_reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def _requires(name: str) -> None:
    if not _enabled(name):
        pytest.skip(f"set AI_TEST_{name.upper()}=1 to run this integration test")


def test_postgres_pgvector_roundtrip() -> None:
    _requires("postgres")
    settings = get_settings()
    if not _tcp_reachable(settings.postgres_host, settings.postgres_port):
        pytest.skip("PostgreSQL is not reachable")

    from ai_api.infrastructure.db import PostgresDatabase

    async def scenario() -> None:
        db = PostgresDatabase(settings)
        await db.connect()
        try:
            await db.execute(
                "CREATE TEMP TABLE ai_pgvector_probe (id int, embedding vector(3))"
            )
            for row_id, vector in ((1, "[1,0,0]"), (2, "[0,1,0]"), (3, "[0,0,1]")):
                await db.execute(
                    "INSERT INTO ai_pgvector_probe (id, embedding) VALUES ($1, $2::vector)",
                    row_id,
                    vector,
                )
            rows = await db.fetch(
                "SELECT id, embedding <=> $1::vector AS distance "
                "FROM ai_pgvector_probe ORDER BY distance LIMIT 2",
                "[0.9,0.1,0.0]",
            )
            assert [row["id"] for row in rows] == [1, 2]
            assert rows[0]["distance"] < rows[1]["distance"]
        finally:
            await db.close()

    try:
        asyncio.run(scenario())
    except Exception as exc:  # noqa: BLE001
        message = str(exc).lower()
        if "vector" in message and ("type" in message or "extension" in message):
            pytest.skip("pgvector extension is not available on this database")
        raise


def test_redis_reachable() -> None:
    _requires("redis")
    parsed = urlparse(get_settings().redis_url)
    assert _tcp_reachable(parsed.hostname or "127.0.0.1", parsed.port or 6379)


def test_kafka_reachable() -> None:
    _requires("kafka")
    host, _, port = get_settings().kafka_bootstrap_servers.partition(":")
    assert _tcp_reachable(host, int(port or "9092")), "Kafka broker is not reachable"


def test_opensearch_reachable() -> None:
    _requires("opensearch")
    settings = get_settings()
    response = httpx.get(settings.opensearch_url, timeout=5.0)
    assert response.status_code in (200, 401)


def test_object_storage_reachable() -> None:
    _requires("objectstorage")
    response = httpx.get(get_settings().s3_endpoint, timeout=5.0)
    assert response.status_code < 500


def test_mlflow_reachable() -> None:
    _requires("mlflow")
    from ai_api.infrastructure.ml import build_tracking_backend

    backend = build_tracking_backend(get_settings())
    status = asyncio.run(backend.status())
    assert status["available"] is True


def test_observability_otlp_endpoint_reachable() -> None:
    _requires("otel")
    parsed = urlparse(get_settings().otel_exporter_otlp_endpoint)
    assert _tcp_reachable(parsed.hostname or "127.0.0.1", parsed.port or 4317)


def test_live_llm_provider_chat() -> None:
    _requires("live_llm")
    settings = get_settings()
    if settings.llm_provider.strip().lower() in ("", "mock"):
        pytest.skip("a non-mock LLM provider must be configured for the live test")

    from ai_api.application.services.model_gateway import ModelGateway
    from ai_api.domain.models.provider import ChatRequest, Message, Role
    from ai_api.infrastructure.providers.registry import (
        build_default_registry,
        default_chat_model,
    )

    gateway = ModelGateway(registry=build_default_registry(settings), settings=settings)

    async def scenario() -> None:
        response = await gateway.chat(
            ChatRequest(
                messages=(Message(role=Role.user, content="Reply with the word: pong"),),
                model=default_chat_model(settings),
                max_output_tokens=16,
            )
        )
        assert response.content
        assert response.is_mock is False

    asyncio.run(scenario())
