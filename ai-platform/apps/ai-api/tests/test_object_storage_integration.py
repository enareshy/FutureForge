"""Opt-in S3-compatible object-storage integration for SEC-15.

    AI_TEST_OBJECTSTORAGE=1 pytest -o addopts="" -m integration \
        tests/test_object_storage_integration.py

The test uses an isolated high-numbered tenant namespace and removes only keys
under that prefix afterwards.
"""

from __future__ import annotations

import asyncio
import os
import random
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from ai_api.api import deps as deps_module
from ai_api.api.deps import get_ai_repository, get_object_storage, get_principal
from ai_api.config.settings import get_settings
from ai_api.infrastructure.repositories import InMemoryAiRepository
from ai_api.infrastructure.storage import S3ObjectStorage
from ai_api.main import create_app
from ai_api.security.policies import Principal

pytestmark = pytest.mark.integration

POWER_USER = frozenset({"*:*"})


def _enabled() -> bool:
    return os.environ.get("AI_TEST_OBJECTSTORAGE", "") == "1"


@contextmanager
def _client(
    repository: InMemoryAiRepository,
    storage: S3ObjectStorage,
    principal: Principal,
) -> Iterator[TestClient]:
    deps_module._rate_limiters.clear()
    app = create_app()
    app.dependency_overrides[get_ai_repository] = lambda: repository
    app.dependency_overrides[get_object_storage] = lambda: storage
    app.dependency_overrides[get_principal] = lambda: principal
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def _cleanup_prefix(tenant_id: int) -> None:
    settings = get_settings()
    storage = S3ObjectStorage(settings)
    client = storage._ensure_client()
    prefix = f"knowledge/{tenant_id}/"
    response = client.list_objects_v2(Bucket=settings.s3_bucket, Prefix=prefix)
    for item in response.get("Contents", []):
        client.delete_object(Bucket=settings.s3_bucket, Key=item["Key"])


def test_upload_download_delete_roundtrip_against_s3() -> None:
    if not _enabled():
        pytest.skip("set AI_TEST_OBJECTSTORAGE=1 to run this integration test")

    tenant_id = random.randint(700_000, 799_999)
    principal = Principal(
        user_id="s3-itest",
        username="s3-itest",
        tenant_id=tenant_id,
        permissions=POWER_USER,
    )
    repository = InMemoryAiRepository()
    storage = S3ObjectStorage(get_settings())
    content = f"SEC-15 integration {os.urandom(12).hex()}".encode()
    object_key: str | None = None

    try:
        with _client(repository, storage, principal) as client:
            source = client.post(
                "/api/v1/ai/knowledge/sources",
                json={"code": "s3-itest", "name": "s3-itest", "kind": "file"},
            )
            assert source.status_code == 201, source.text
            uploaded = client.post(
                f"/api/v1/ai/knowledge/sources/{source.json()['id']}/upload",
                files={"file": ("s3-itest.txt", content, "text/plain")},
            )
            assert uploaded.status_code == 202, uploaded.text
            document = client.get(
                f"/api/v1/ai/knowledge/sources/{source.json()['id']}/documents"
            ).json()["items"][0]
            object_key = next(
                row["object_key"]
                for row in repository._documents
                if row["id"] == document["id"]
            )
            assert object_key.startswith(f"knowledge/{tenant_id}/")
            assert f"knowledge/{tenant_id}/" not in uploaded.text

            async def read_back() -> bytes | None:
                return await storage.get(object_key or "")

            assert asyncio.run(read_back()) == content

            downloaded = client.get(
                f"/api/v1/ai/knowledge/documents/{document['id']}/download"
            )
            assert downloaded.status_code == 200
            assert downloaded.content == content

            deleted = client.delete(
                f"/api/v1/ai/knowledge/documents/{document['id']}"
            )
            assert deleted.status_code == 204

            async def exists_after_delete() -> bool:
                return await storage.exists(object_key or "")

            assert asyncio.run(exists_after_delete()) is False
    finally:
        _cleanup_prefix(tenant_id)
