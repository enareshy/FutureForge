from __future__ import annotations

import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from ai_api.config.settings import Settings
from ai_api.domain.errors import ConfigurationError
from ai_api.main import create_app
from ai_api.telemetry.otel import configure_telemetry


def _production(**overrides) -> Settings:
    values = {
        "ai_env": "production",
        "llm_provider": "openai",
        "llm_api_key": SecretStr("test-key"),
        "otel_enabled": True,
        "otel_exporter_otlp_endpoint": "http://otel-collector.observability:4317",
        "ai_metrics_auth_token": SecretStr("m" * 32),
        "ai_repository": "memory",
    }
    values.update(overrides)
    return Settings(**values)


def test_production_rejects_mock_provider() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(llm_provider="mock")
    message = str(excinfo.value)
    assert "LLM_PROVIDER=mock" in message
    assert "AI_ENV=production" in message


def test_production_rejects_disabled_telemetry() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(otel_enabled=False)
    assert "OTEL_ENABLED must be true" in str(excinfo.value)


def test_production_rejects_invalid_telemetry_endpoint() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(otel_exporter_otlp_endpoint="collector:4317")
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" in str(excinfo.value)


def test_production_rejects_unconfigured_provider_credentials() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(llm_api_key=SecretStr(""), llm_base_url="")
    assert "LLM_API_KEY or LLM_BASE_URL" in str(excinfo.value)


def test_production_rejects_missing_or_weak_metrics_token() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(ai_metrics_auth_token=SecretStr(""))
    assert "AI_METRICS_AUTH_TOKEN" in str(excinfo.value)

    with pytest.raises(ValidationError) as excinfo:
        _production(ai_metrics_auth_token=SecretStr("too-short"))
    assert "at least 32 characters" in str(excinfo.value)


def test_production_rejects_disabled_prompt_injection_blocking() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(ai_prompt_injection_blocking=False)
    assert "AI_PROMPT_INJECTION_BLOCKING" in str(excinfo.value)


def _production_client(monkeypatch, **overrides) -> TestClient:
    settings = _production(**overrides)
    monkeypatch.setattr("ai_api.main.get_settings", lambda: settings)
    # The docs/schema test must not start a real OTLP exporter.
    monkeypatch.setattr("ai_api.main.configure_telemetry", lambda *_args, **_kwargs: None)
    return TestClient(create_app())


def test_production_disables_docs_and_schema(monkeypatch) -> None:
    client = _production_client(monkeypatch)
    assert client.get("/api/v1/ai/docs").status_code == 404
    assert client.get("/api/v1/ai/openapi.json").status_code == 404
    assert client.get("/healthz").status_code == 200
    assert client.get("/api/v1/ai/health").status_code == 200


def test_production_docs_require_an_explicit_override(monkeypatch) -> None:
    client = _production_client(monkeypatch, ai_docs_enabled=True)
    docs = client.get("/api/v1/ai/docs")
    assert docs.status_code == 200
    assert "swagger-ui" in docs.text
    assert client.get("/api/v1/ai/openapi.json").status_code == 200


def test_production_accepts_valid_configuration() -> None:
    settings = _production(llm_base_url="https://llm.internal.example/v1")
    assert settings.is_production is True
    assert settings.is_deployed is True


def test_staging_is_validated_like_production() -> None:
    with pytest.raises(ValidationError):
        _production(ai_env="staging", llm_provider="mock")
    valid = _production(ai_env="staging")
    assert valid.is_deployed is True


def test_production_postgres_requires_least_privilege_role_profile() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(ai_repository="postgres")
    assert "AI_DB_ROLE_PROFILE" in str(excinfo.value)

    with pytest.raises(ValidationError) as excinfo:
        _production(ai_repository="postgres", ai_db_role_profile="api")
    assert "AI_DB_EXPECTED_ROLE" in str(excinfo.value)

    valid = _production(
        ai_repository="postgres",
        ai_db_role_profile="api",
        ai_db_expected_role="ai_api",
    )
    assert valid.ai_db_expected_role == "ai_api"


def test_development_and_testing_allow_mock() -> None:
    development = Settings(ai_env="development", llm_provider="mock", otel_enabled=False)
    testing = Settings(ai_env="testing", llm_provider="mock", otel_enabled=False)
    assert development.is_deployed is False
    assert testing.is_deployed is False
    assert development.is_production is False


def test_validation_error_does_not_leak_secrets() -> None:
    with pytest.raises(ValidationError) as excinfo:
        _production(llm_api_key=SecretStr("super-secret-value"), otel_enabled=False)
    assert "super-secret-value" not in str(excinfo.value)


def test_telemetry_import_failure_fails_closed_in_deployed_env(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "opentelemetry", None)
    with pytest.raises(ConfigurationError):
        configure_telemetry(FastAPI(), _production())


def test_telemetry_import_failure_is_tolerated_in_development(monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "opentelemetry", None)
    settings = Settings(ai_env="development", otel_enabled=True)
    configure_telemetry(FastAPI(), settings)


def test_module_entrypoint_passes_app_object_not_import_string(monkeypatch) -> None:
    """``python -m ai_api.main`` must not re-import the module.

    Under ``-m`` this module runs as ``__main__``, so an import-string target
    would import ``ai_api.main`` a second time and build a second app. That
    duplicated telemetry setup (the OTEL SDK rejects a second TracerProvider)
    and ran ``create_app`` twice on every container start.
    """
    import uvicorn

    from ai_api import main as main_module

    captured: dict[str, object] = {}

    def _fake_run(target, **kwargs):
        captured["target"] = target
        captured["kwargs"] = kwargs

    monkeypatch.setattr(uvicorn, "run", _fake_run)
    main_module.main()

    assert captured["target"] is main_module.app
    assert not isinstance(captured["target"], str)
