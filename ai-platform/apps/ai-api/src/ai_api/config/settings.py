from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
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
    # Fail startup when the RLS migration is absent or a protected table lost
    # its policy. Disable only for a documented, temporary migration window.
    ai_rls_verify: bool = True
    # Least-privilege role assertion. Set to "api" or "worker" in every deployed
    # process. The startup check rejects superuser/BYPASSRLS/owner roles and
    # enforces the system-access boundary for the selected profile.
    ai_db_role_profile: Literal["", "api", "worker", "backup", "migrate"] = ""
    # Exact expected current_user. Required with a non-empty profile.
    ai_db_expected_role: str = ""

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
    # Bounded exponential retry backoff for index jobs. Attempts are persisted
    # with a `next_attempt_at` timestamp so restarts keep the delay.
    ai_job_retry_base_seconds: float = Field(default=5.0, gt=0)
    ai_job_retry_max_seconds: float = Field(default=300.0, gt=0)
    ai_job_retry_jitter: float = Field(default=0.1, ge=0, le=1)

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
    ai_agent_worker_batch_size: int = Field(default=5, ge=1, le=100)
    ai_agent_execution_lease_seconds: int = Field(default=120, ge=10, le=3600)

    # Document upload and indexing hardening (Stage 3).
    ai_upload_max_bytes: int = Field(default=26_214_400, ge=1024)  # 25 MiB
    # When true, reject uploads whose bytes do not match the declared/allowed
    # format signature (magic bytes), not just the extension/MIME string.
    ai_upload_require_signature: bool = True
    # Bounded retries and per-job processing timeout.
    ai_max_job_attempts: int = Field(default=5, ge=1, le=50)
    ai_job_timeout_seconds: float = Field(default=120.0, gt=0)
    # Lease duration so a crashed worker's job can be reclaimed by another.
    ai_job_lease_seconds: float = Field(default=300.0, gt=0)

    # Retrieval search: lexical provider ("postgres" full-text, or "opensearch")
    # and hybrid fusion (combine vector + lexical with reciprocal rank fusion).
    search_provider: str = "postgres"
    ai_hybrid_search_enabled: bool = True
    # Reciprocal Rank Fusion constant (Cormack et al., 2009). Larger -> flatter
    # contribution across ranks.
    ai_rrf_k: int = Field(default=60, ge=1, le=1000)
    # Candidates pulled from each path before fusion.
    ai_retrieval_candidate_multiplier: int = Field(default=4, ge=1, le=20)

    # Stage 5 Copilot: bounded multi-turn history, authorized context and
    # grounded task limits. All are hard server-side bounds; clients cannot
    # raise them per request.
    ai_copilot_history_max_messages: int = Field(default=12, ge=0, le=100)
    ai_copilot_history_max_chars: int = Field(default=12000, ge=0, le=200000)
    ai_copilot_summary_max_chars: int = Field(default=2000, ge=200, le=20000)
    # Summarize older turns into derived context only when the transcript is at
    # least this large; below it, the bounded window is used directly.
    ai_copilot_summary_threshold_messages: int = Field(default=20, ge=1, le=500)
    ai_copilot_context_max_items: int = Field(default=8, ge=0, le=25)
    ai_copilot_context_max_chars: int = Field(default=16000, ge=500, le=120000)
    ai_copilot_context_chunk_limit: int = Field(default=6, ge=1, le=50)
    ai_copilot_compare_max_items: int = Field(default=5, ge=2, le=10)
    ai_copilot_extract_max_items: int = Field(default=5, ge=1, le=10)
    ai_copilot_max_fields: int = Field(default=25, ge=1, le=100)
    # Hard bound on the user question/instruction and JSON output.
    ai_copilot_max_question_chars: int = Field(default=8000, ge=1, le=50000)
    ai_copilot_task_timeout_seconds: float = Field(default=60.0, gt=0)
    ai_copilot_stream_enabled: bool = True
    # Conversation summary generation is a background quality feature; failures
    # must never block answering.
    ai_copilot_summary_enabled: bool = True

    # Stage 5 Copilot tool orchestration. Tools forward the caller's own session
    # token to the existing enterprise services, so authorization is evaluated
    # by those services exactly as it would be for a direct API call.
    ai_copilot_tools_enabled: bool = True
    ai_copilot_tool_timeout_seconds: float = Field(default=8.0, gt=0)
    # Maximum tools invoked for a single question, and the maximum number of
    # bounded result rows kept per tool. Prevents runaway or repeated calls.
    ai_copilot_max_tool_calls: int = Field(default=3, ge=0, le=10)
    ai_copilot_tool_result_limit: int = Field(default=5, ge=1, le=50)
    # Controlled actions: proposals are inert until an authorized reviewer
    # approves them, then executed once by an authorized operator.
    ai_copilot_actions_enabled: bool = True
    ai_copilot_action_ttl_seconds: int = Field(default=86400, ge=60, le=604800)

    # Stage 4 search ranking (explainable, additive score components). Weights are
    # multipliers applied on top of the fused relevance score; 0 disables a rule.
    # Consolidate chunk matches into document-level results for the search UI
    # (RAG/agent retrieval keeps chunk-level results for citations).
    ai_search_consolidate_documents: bool = True
    # Boost when a query token appears verbatim in the document identifier/title.
    ai_search_exact_boost: float = Field(default=0.5, ge=0.0, le=5.0)
    # Boost when the whole query appears as a phrase in the content/title.
    ai_search_phrase_boost: float = Field(default=0.3, ge=0.0, le=5.0)
    # Extra weight for a title match (field weighting).
    ai_search_title_boost: float = Field(default=0.2, ge=0.0, le=5.0)
    # Freshness: recency bonus half-life in days (0 disables the freshness term).
    ai_search_freshness_half_life_days: float = Field(default=0.0, ge=0.0, le=3650.0)
    ai_search_freshness_weight: float = Field(default=0.0, ge=0.0, le=5.0)
    # Duplicate/conflict review: maximum documents compared in one scan. Detection
    # only surfaces findings for human review; it never merges or deletes content.
    ai_dedup_scan_limit: int = Field(default=5000, ge=1, le=50000)
    opensearch_url: str = "http://127.0.0.1:9200"
    opensearch_username: str = ""
    opensearch_password: SecretStr = SecretStr("")
    opensearch_insecure: bool = False
    opensearch_index_prefix: str = "ai-knowledge"
    opensearch_timeout_seconds: float = Field(default=10.0, gt=0)

    event_bus_provider: str = "database"
    kafka_bootstrap_servers: str = "127.0.0.1:9092"
    ai_event_topic: str = "ai.platform.events"
    ai_event_consumer_group: str = "ai-api-events"
    ai_event_max_attempts: int = Field(default=5, ge=1, le=100)
    ai_event_batch_size: int = Field(default=20, ge=1, le=1000)
    ai_event_poll_seconds: float = Field(default=5.0, gt=0)
    ai_event_retry_base_seconds: float = Field(default=2.0, gt=0)
    ai_event_retry_max_seconds: float = Field(default=60.0, gt=0)
    ai_event_retry_jitter: float = Field(default=0.1, ge=0, le=1)
    # In-flight claim lease for the event consumer. A claimed event is invisible
    # to other replicas of the same group until delivery or lease expiry, so this
    # must exceed the slowest expected handler. Expiry makes a crashed worker's
    # events claimable again rather than stranded.
    ai_event_claim_lease_seconds: float = Field(default=300.0, gt=0)
    # Replay safety: refuse to replay events older than this many days.
    ai_event_replay_max_age_days: int = Field(default=7, ge=1, le=365)

    # Automated, bounded knowledge/index reconciliation worker.
    ai_reconcile_enabled: bool = True
    ai_reconcile_interval_seconds: float = Field(default=300.0, gt=0)
    ai_reconcile_max_tenants: int = Field(default=50, ge=1, le=1000)
    ai_reconcile_limit: int = Field(default=100, ge=1, le=1000)
    ai_reconcile_scan_orphans: bool = True
    ai_reconcile_purge_orphans: bool = False
    ai_reconcile_dry_run: bool = False
    # Security refresh work older than this is surfaced as lagging.
    ai_security_refresh_stale_seconds: float = Field(default=900.0, gt=0)

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

    # Prompt-injection screening is enabled by default and is a hard floor for
    # deployed environments. Detection-only mode is reserved for development
    # and testing; tenant policy can still opt out explicitly.
    ai_prompt_injection_blocking: bool = True

    # Prometheus scrapes must present `Authorization: Bearer <token>`. An empty
    # value makes `/metrics` fail closed (503) on the API and workers. Deployed
    # environments must configure a strong token; see `_validate_deployed_posture`.
    ai_metrics_auth_token: SecretStr = SecretStr("")
    # Interactive docs and the OpenAPI schema are disabled in production by
    # default. Set AI_DOCS_ENABLED=true only for a documented, temporary need.
    ai_docs_enabled: bool = False

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
    # Hard transport cap enforced by ASGI middleware before routing, parsing,
    # or authentication. It must be large enough to carry a maximum-size
    # upload plus multipart framing; the per-domain 25 MiB check in the upload
    # handler remains the authoritative document limit. Keep the ingress and
    # web-proxy body limits at or above this value.
    ai_max_request_bytes: int = Field(default=33_554_432, ge=1024)  # 32 MiB

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
    ai_dev_actor_id: int = Field(default=1, ge=1)
    ai_dev_permissions: str = "*:*"

    @model_validator(mode="after")
    def _validate_retry_windows(self) -> Settings:
        if self.ai_job_retry_base_seconds > self.ai_job_retry_max_seconds:
            raise ValueError("AI_JOB_RETRY_BASE_SECONDS must not exceed AI_JOB_RETRY_MAX_SECONDS")
        if self.ai_event_retry_base_seconds > self.ai_event_retry_max_seconds:
            raise ValueError(
                "AI_EVENT_RETRY_BASE_SECONDS must not exceed AI_EVENT_RETRY_MAX_SECONDS"
            )
        return self

    @model_validator(mode="after")
    def _validate_request_body_limit(self) -> Settings:
        """Keep the transport cap above the domain upload limit.

        The body-limit middleware rejects a request before the upload handler
        can apply its own size check. If the transport cap were smaller than
        the upload limit, uploads the application claims to accept would be
        rejected at the edge with a misleading 413.
        """
        if self.ai_max_request_bytes < self.ai_upload_max_bytes:
            raise ValueError(
                "AI_MAX_REQUEST_BYTES must be greater than or equal to "
                "AI_UPLOAD_MAX_BYTES so the transport cap does not reject "
                "uploads the application accepts"
            )
        return self

    @model_validator(mode="after")
    def _validate_deployed_posture(self) -> Settings:
        """Fail closed on unsafe production/staging configuration.

        Development and test environments intentionally keep the mock provider
        and tracing opt-in. Deployed environments must configure a real provider
        and telemetry explicitly; inheriting the base Kubernetes defaults is not
        allowed.
        """
        if not self.is_deployed:
            return self

        environment = self.ai_env.strip().lower()
        provider = self.llm_provider.strip().lower()
        if not provider:
            raise ValueError(
                f"LLM_PROVIDER must be set to a real provider when AI_ENV={environment}; "
                "the mock provider is not allowed in deployed environments"
            )
        if provider == "mock":
            raise ValueError(
                f"LLM_PROVIDER=mock is not allowed when AI_ENV={environment}; "
                "configure a real LiteLLM provider (for example openai) and its "
                "credentials via LLM_API_KEY or LLM_BASE_URL"
            )
        if not self.llm_api_key.get_secret_value().strip() and not self.llm_base_url.strip():
            raise ValueError(
                f"LLM_PROVIDER={provider} requires LLM_API_KEY or LLM_BASE_URL "
                f"when AI_ENV={environment}"
            )

        if not self.otel_enabled:
            raise ValueError(
                f"OTEL_ENABLED must be true when AI_ENV={environment}; "
                "export traces to an OTLP collector or disable the environment "
                "explicitly (development/testing)"
            )
        endpoint = self.otel_exporter_otlp_endpoint.strip()
        if not endpoint.startswith(("http://", "https://")):
            raise ValueError(
                f"OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL when "
                f"AI_ENV={environment}"
            )

        if not self.ai_prompt_injection_blocking:
            raise ValueError(
                f"AI_PROMPT_INJECTION_BLOCKING must be true when "
                f"AI_ENV={environment}; prompt-injection blocking cannot be "
                "disabled in deployed environments"
            )

        metrics_token = self.ai_metrics_auth_token.get_secret_value().strip()
        if len(metrics_token) < 32:
            raise ValueError(
                f"AI_METRICS_AUTH_TOKEN must be at least 32 characters when "
                f"AI_ENV={environment}; generate one with "
                "'openssl rand -hex 32' and provide it to the API, workers and "
                "the Prometheus scrape configuration"
            )

        if self.ai_repository != "postgres":
            return self
        profile = self.ai_db_role_profile.strip().lower()
        if profile not in {"api", "worker"}:
            raise ValueError(
                f"AI_DB_ROLE_PROFILE must be 'api' or 'worker' when "
                f"AI_ENV={environment}; deploy-time database access must not "
                "use the owner or an unclassified role"
            )
        if not self.ai_db_expected_role.strip():
            raise ValueError(
                f"AI_DB_EXPECTED_ROLE must name the non-owner database role "
                f"when AI_ENV={environment}"
            )
        return self

    @property
    def api_docs_enabled(self) -> bool:
        """Whether Swagger/OpenAPI routes are served.

        Development keeps the interactive docs for local work. Production
        disables both routes unless an operator explicitly opts in.
        """
        return self.ai_docs_enabled or not self.is_production

    @property
    def database_dsn(self) -> str:
        password = self.postgres_password.get_secret_value()
        return (
            f"postgresql://{self.postgres_user}:{password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def is_production(self) -> bool:
        return self.ai_env.strip().lower() in {"production", "prod"}

    @property
    def is_deployed(self) -> bool:
        """Environments that must not run with development-only defaults."""
        return self.ai_env.strip().lower() in {"production", "prod", "staging"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
