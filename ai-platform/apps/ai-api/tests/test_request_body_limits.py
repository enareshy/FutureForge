from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.middleware.body_limit import RequestBodyLimitMiddleware
from starlette.requests import Request
from starlette.responses import Response

from ai_api.config.settings import Settings, get_settings
from ai_api.main import create_app


@pytest.fixture()
def limited_client(monkeypatch) -> TestClient:
    # The transport cap cannot be lower than the upload cap by construction.
    monkeypatch.setenv("AI_MAX_REQUEST_BYTES", "1024")
    monkeypatch.setenv("AI_UPLOAD_MAX_BYTES", "1024")
    get_settings.cache_clear()
    try:
        yield TestClient(create_app())
    finally:
        get_settings.cache_clear()


def _find_body_limit_middleware(app: FastAPI) -> RequestBodyLimitMiddleware:
    for middleware in app.user_middleware:
        if middleware.cls is RequestBodyLimitMiddleware:
            return middleware
    raise AssertionError("RequestBodyLimitMiddleware is not registered")


def _middleware_limit(app: FastAPI) -> int:
    middleware = _find_body_limit_middleware(app)
    return middleware.kwargs["max_body_size"]


def test_transport_cap_is_wired_from_settings(limited_client: TestClient) -> None:
    assert _middleware_limit(limited_client.app) == 1024


def test_oversized_content_length_is_rejected_before_routing(
    limited_client: TestClient,
) -> None:
    response = limited_client.post("/healthz", content=b"x" * 2048)

    assert response.status_code == 413
    assert "Content Too Large" in response.text


def test_request_within_limit_is_not_rejected(limited_client: TestClient) -> None:
    # /healthz only supports GET; reaching the router proves the body limit did
    # not intercept a request that is within the configured cap.
    response = limited_client.post("/healthz", content=b"x" * 16)

    assert response.status_code == 405


async def _echo_app(scope, receive, send) -> None:
    request = Request(scope, receive)
    body = await request.body()
    await Response(body)(scope, receive, send)


def _base_scope(headers: list[tuple[bytes, bytes]]) -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/echo",
        "raw_path": b"/echo",
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "server": ("testserver", 80),
        "client": ("testclient", 50000),
    }


async def _invoke(app, *, headers: list[tuple[bytes, bytes]], chunks: list[bytes]):
    sent: list[dict] = []
    pending = list(chunks)
    receives = 0

    async def receive() -> dict:
        nonlocal receives
        receives += 1
        if pending:
            body = pending.pop(0)
            return {
                "type": "http.request",
                "body": body,
                "more_body": bool(pending),
            }
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    await app(_base_scope(headers), receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body, receives


def test_streamed_body_over_limit_is_rejected_without_content_length() -> None:
    app = RequestBodyLimitMiddleware(_echo_app, max_body_size=1024)

    status, body, _ = asyncio.run(
        _invoke(app, headers=[], chunks=[b"a" * 800, b"b" * 800])
    )

    assert status == 413
    assert b"Content Too Large" in body


def test_streamed_body_at_limit_passes() -> None:
    app = RequestBodyLimitMiddleware(_echo_app, max_body_size=1024)

    status, body, _ = asyncio.run(
        _invoke(app, headers=[], chunks=[b"a" * 512, b"b" * 512])
    )

    assert status == 200
    assert body == b"a" * 512 + b"b" * 512


def test_oversized_content_length_is_rejected_without_reading_body() -> None:
    app = RequestBodyLimitMiddleware(_echo_app, max_body_size=1024)

    status, body, receives = asyncio.run(
        _invoke(
            app,
            headers=[(b"content-length", b"2048")],
            chunks=[b"a" * 2048],
        )
    )

    assert status == 413
    assert b"Content Too Large" in body
    # The ASGI receive callable was never consumed before the rejection.
    assert receives == 0


def test_settings_reject_transport_cap_below_upload_limit() -> None:
    with pytest.raises(ValidationError) as excinfo:
        Settings(ai_max_request_bytes=1024, ai_upload_max_bytes=2048)

    assert "AI_MAX_REQUEST_BYTES" in str(excinfo.value)


def test_default_transport_cap_covers_upload_limit() -> None:
    transport_default = Settings.model_fields["ai_max_request_bytes"].default
    upload_default = Settings.model_fields["ai_upload_max_bytes"].default

    assert transport_default == 33_554_432
    assert transport_default >= upload_default
