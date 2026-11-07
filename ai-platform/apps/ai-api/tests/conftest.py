from __future__ import annotations

import os

os.environ.setdefault("AI_REPOSITORY", "memory")
os.environ.setdefault("EVENT_BUS_PROVIDER", "database")
os.environ.setdefault("AI_API_LOG_LEVEL", "warning")
os.environ["AI_METRICS_AUTH_TOKEN"] = "test-metrics-token"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from ai_api.main import create_app  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture()
def metrics_headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-metrics-token"}
