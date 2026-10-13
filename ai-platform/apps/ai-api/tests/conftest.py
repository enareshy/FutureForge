from __future__ import annotations

import os

os.environ.setdefault("AI_REPOSITORY", "memory")
os.environ.setdefault("EVENT_BUS_PROVIDER", "database")
os.environ.setdefault("AI_API_LOG_LEVEL", "warning")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from ai_api.main import create_app  # noqa: E402


@pytest.fixture()
def client() -> TestClient:
    return TestClient(create_app())
