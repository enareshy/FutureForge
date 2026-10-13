from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _discover_env_file() -> str:
    cwd = Path.cwd()
    for candidate in (cwd / ".env", cwd.parent / ".env", cwd.parent.parent / ".env"):
        if candidate.is_file():
            return str(candidate)
    return ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_discover_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    ai_env: str = "development"

    enterprise_api_base_url: str = "http://127.0.0.1:3001"
    enterprise_api_timeout_seconds: float = 10.0

    postgres_host: str = "127.0.0.1"
    postgres_port: int = 5432
    postgres_db: str = "helix"
    postgres_user: str = "helix"
    postgres_password: SecretStr = SecretStr("")
    ai_db_schema: str = "ai"

    redis_url: str = "redis://127.0.0.1:6379/0"

    s3_endpoint: str = "http://127.0.0.1:8333"
    s3_region: str = "us-east-1"
    s3_bucket: str = "ai-knowledge"
    s3_access_key_id: SecretStr = SecretStr("")
    s3_secret_access_key: SecretStr = SecretStr("")
    s3_force_path_style: bool = True

    llm_provider: str = "mock"
    llm_api_key: SecretStr = SecretStr("")
    llm_base_url: str = ""
    llm_chat_model: str = ""
    llm_embedding_model: str = ""
    llm_embedding_dimensions: int = 1536

    # Provider gateway reliability and safety bounds.
    llm_request_timeout_seconds: float = Field(default=30.0, gt=0)
    llm_max_retries: int = Field(default=3, ge=1, le=10)
    llm_retry_base_delay_seconds: float = Field(default=0.25, gt=0)
    llm_retry_max_delay_seconds: float = Field(default=2.0, gt=0)
    llm_circuit_breaker_threshold: int = Field(default=5, ge=1)
    llm_circuit_breaker_reset_seconds: float = Field(default=30.0, gt=0)
    llm_requests_per_minute: int = Field(default=120, ge=1)
    llm_max_embedding_batch: int = Field(default=64, ge=1)
    # Optional cost metadata (USD per 1K tokens); left unset when the provider
    # does not expose pricing. Never inferred from provider secrets.
    llm_input_cost_per_1k: float | None = None
    llm_output_cost_per_1k: float | None = None

    # Knowledge ingestion and retrieval (Phase 7).
    ai_chunk_size: int = Field(default=800, ge=100, le=8000)
    ai_chunk_overlap: int = Field(default=120, ge=0, le=2000)
    ai_ingest_max_documents: int = Field(default=100, ge=1, le=1000)
    ai_rag_min_score: float = Field(default=0.2, ge=-1.0, le=1.0)
    ai_rag_max_context_chars: int = Field(default=6000, ge=500, le=60000)
    ai_rag_default_limit: int = Field(default=5, ge=1, le=20)
    ai_search_default_limit: int = Field(default=10, ge=1, le=50)
    # Process queued indexing jobs inline in the API process (dev convenience).
    ai_ingest_inline: bool = True
    # Background indexer worker (python -m ai_api.workers.indexer).
    ai_worker_batch_size: int = Field(default=10, ge=1, le=1000)
    ai_worker_poll_seconds: float = Field(default=5.0, gt=0)

    # Agent framework (Phase 9).
    ai_agent_default_code: str = "knowledge-assistant"
    ai_agent_default_version: int = Field(default=1, ge=1)
    ai_agent_timeout_seconds: float = Field(default=30.0, gt=0)
    ai_agent_max_iterations: int = Field(default=6, ge=1, le=50)
    ai_agent_max_tool_calls: int = Field(default=6, ge=1, le=50)
    ai_agent_trace_max_events: int = Field(default=40, ge=1, le=500)
    # When true, every tool marked `requires_approval` needs an explicit
    # approval token before it may run (human-in-the-loop checkpoint). Read-only
    # V1 tools never require approval; the control exists for future tools.
    ai_agent_require_approval: bool = False

    search_provider: str = "postgres"
    opensearch_url: str = "http://127.0.0.1:9200"
    opensearch_username: str = ""
    opensearch_password: SecretStr = SecretStr("")
    opensearch_insecure: bool = False

    event_bus_provider: str = "database"
    kafka_bootstrap_servers: str = "127.0.0.1:9092"
    ai_event_topic: str = "ai.platform.events"
    ai_event_consumer_group: str = "ai-api-events"
    ai_event_max_attempts: int = Field(default=5, ge=1, le=100)
    ai_event_batch_size: int = Field(default=20, ge=1, le=1000)
    ai_event_poll_seconds: float = Field(default=5.0, gt=0)
    # Replay safety: refuse to replay events older than this many days.
    ai_event_replay_max_age_days: int = Field(default=7, ge=1, le=365)

    mlflow_tracking_uri: str = "http://127.0.0.1:5000"

    # Experiment tracking and classical-ML model registry (Phase 11).
    # Backend for tracking runs: "auto" (mlflow if configured, else local),
    # "mlflow" (require the MLflow tracking server), or "local" (the platform
    # records metadata only; no external tracking/artifacts).
    ml_tracking_backend: str = "auto"
    # Register model versions with the MLflow model registry when the tracking
    # backend is MLflow and the registry is available.
    ml_enable_registration: bool = True
    ml_request_timeout_seconds: float = Field(default=10.0, gt=0)
    # Default framework label recorded for models when the caller omits one.
    ml_default_framework: str = "scikit-learn"
    ml_sample_seed: int = Field(default=1729, ge=0)

    otel_enabled: bool = False
    otel_exporter_otlp_endpoint: str = "http://127.0.0.1:4317"
    otel_service_name: str = "ai-api"
    langfuse_host: str = ""
    langfuse_public_key: SecretStr = SecretStr("")
    langfuse_secret_key: SecretStr = SecretStr("")

    ai_api_host: str = "0.0.0.0"
    ai_api_port: int = 8000
    ai_api_log_level: str = "info"
    ai_rate_limit_per_minute: int = Field(default=60, ge=1)
    ai_max_request_bytes: int = Field(default=1048576, ge=1024)

    # Persistence backend for the ai schema: "postgres" (default) or "memory".
    ai_repository: str = "postgres"
    ai_default_page_limit: int = Field(default=50, ge=1, le=200)
    ai_max_page_limit: int = Field(default=200, ge=1, le=1000)

    # Identity: "auto" (enterprise in production, development otherwise),
    # "enterprise" (verify against the enterprise IAM), or "development".
    identity_provider: str = "auto"
    identity_cache_ttl_seconds: int = Field(default=30, ge=0, le=3600)
    # JSON object overriding the AI capability -> enterprise permission map.
    ai_permission_map: str = ""
    # Enterprise permission(s) that grant unrestricted AI access (e.g. the
    # platform-admin permission). Comma-separated. Empty disables the bypass.
    ai_admin_permissions: str = "iam.platform:read"

    # Development identity (used only when a real identity provider is absent
    # and AI_ENV is not "production"; see security/identity.py).
    ai_dev_tenant_id: int = 1
    ai_dev_permissions: str = "*:*"

    @property
    def database_dsn(self) -> str:
        password = self.postgres_password.get_secret_value()
        return (
            f"postgresql://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def is_production(self) -> bool:
        return self.ai_env.lower() == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
