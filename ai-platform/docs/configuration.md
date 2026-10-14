# Configuration

All configuration is supplied through environment variables. Copy
`.env.example` to `.env` (`make env`) and adjust. `.env` is git-ignored;
never commit real secrets. Deployed environments use a secret manager and
store only references in source control.

## Variables

### Deployment
| Variable | Default | Description |
|---|---|---|
| `AI_ENV` | `development` | `development` / `testing` / `staging` / `production` |

### Enterprise backend (authoritative IAM)
| Variable | Default | Description |
|---|---|---|
| `ENTERPRISE_API_BASE_URL` | `http://127.0.0.1:3001` | Node/Express backend the AI API authorizes against |
| `ENTERPRISE_API_TIMEOUT_SECONDS` | `10` | outbound timeout |

### PostgreSQL (shared, with pgvector)
| Variable | Default | Description |
|---|---|---|
| `POSTGRES_HOST` | `127.0.0.1` | |
| `POSTGRES_PORT` | `5432` | |
| `POSTGRES_DB` | `helix` | |
| `POSTGRES_USER` | `helix` | database owner |
| `POSTGRES_PASSWORD` | `change-me` | secret |
| `AI_DB_SCHEMA` | `ai` | schema holding AI metadata |

### Cache
| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | cache/state only, never authoritative |

### Object storage (S3-compatible)
| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | `http://127.0.0.1:8333` | SeaweedFS in local dev |
| `S3_REGION` | `us-east-1` | |
| `S3_BUCKET` | `ai-knowledge` | |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | empty | secrets |
| `S3_FORCE_PATH_STYLE` | `true` | required for most S3-compatible stores |

### LLM gateway
| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `mock` when no credentials are present |
| `LLM_API_KEY` | empty | secret, never sent to the browser |
| `LLM_BASE_URL` / `LLM_CHAT_MODEL` / `LLM_EMBEDDING_MODEL` | empty | provider config |
| `LLM_EMBEDDING_DIMENSIONS` | `1536` | must match the embedding model and the vector column |

### Search
| Variable | Default | Description |
|---|---|---|
| `SEARCH_PROVIDER` | `postgres` | `postgres` (default) or `opensearch` |
| `OPENSEARCH_URL` | `http://127.0.0.1:9200` | |
| `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` | empty | secrets |
| `OPENSEARCH_INSECURE` | `false` | disable TLS verification (dev only) |

### Events
| Variable | Default | Description |
|---|---|---|
| `EVENT_BUS_PROVIDER` | `database` | `database` (enterprise outbox) / `kafka` / `memory` |
| `KAFKA_BOOTSTRAP_SERVERS` | `127.0.0.1:9092` | |
| `AI_EVENT_TOPIC` | `ai.platform.events` | |
| `AI_EVENT_CONSUMER_GROUP` | `ai-api-events` | |
| `AI_EVENT_MAX_ATTEMPTS` | `5` | retries before dead-lettering |
| `AI_EVENT_BATCH_SIZE` | `20` | events per consumer poll |
| `AI_EVENT_POLL_SECONDS` | `5` | consumer poll interval |
| `AI_EVENT_REPLAY_MAX_AGE_DAYS` | `7` | replay window |

### Agents (Phase 9)
| Variable | Default | Description |
|---|---|---|
| `AI_AGENT_DEFAULT_CODE` | `knowledge-assistant` | built-in agent code |
| `AI_AGENT_DEFAULT_VERSION` | `1` | active definition version |
| `AI_AGENT_TIMEOUT_SECONDS` | `30` | wall-clock execution timeout |
| `AI_AGENT_MAX_ITERATIONS` | `6` | bounded graph iteration |
| `AI_AGENT_MAX_TOOL_CALLS` | `6` | tool-call budget per run |
| `AI_AGENT_TRACE_MAX_EVENTS` | `40` | max trace events retained |
| `AI_AGENT_REQUIRE_APPROVAL` | `false` | require approval for all tools |

### Knowledge assistant (Stage 3)
| Variable | Default | Description |
|---|---|---|
| `AI_UPLOAD_MAX_BYTES` | `26214400` | Max upload size (25 MiB) |
| `AI_UPLOAD_REQUIRE_SIGNATURE` | `true` | Enforce content-signature sniffing on upload |
| `AI_MAX_JOB_ATTEMPTS` | `5` | Retries before an indexing job fails |
| `AI_JOB_TIMEOUT_SECONDS` | `120` | Per-attempt indexing timeout |
| `AI_JOB_LEASE_SECONDS` | `300` | Advisory lease for a processing job |
| `AI_HYBRID_SEARCH_ENABLED` | `true` | Fuse vector + lexical candidates (RRF) |
| `AI_RRF_K` | `60` | Reciprocal rank fusion constant |
| `AI_RETRIEVAL_CANDIDATE_MULTIPLIER` | `4` | Per-list candidate oversampling |

File uploads require the object-storage settings (`S3_*`) above; when external
search is selected, `SEARCH_PROVIDER=opensearch` uses the `OPENSEARCH_*` settings
and falls back to PostgreSQL FTS if the index is unavailable.

### Model lifecycle (Phase 11)
| Variable | Default | Description |
|---|---|---|
| `MLFLOW_TRACKING_URI` | `http://127.0.0.1:5000` | External MLflow tracking server |
| `ML_TRACKING_BACKEND` | `auto` | `auto` \| `mlflow` \| `local` |
| `ML_ENABLE_REGISTRATION` | `true` | Register versions with the MLflow model registry |
| `ML_REQUEST_TIMEOUT_SECONDS` | `10` | Per-request timeout for MLflow calls |
| `ML_DEFAULT_FRAMEWORK` | `scikit-learn` | Default framework label |
| `ML_SAMPLE_SEED` | `1729` | Seed for the reference pipeline |

### Observability
| Variable | Default | Description |
|---|---|---|
| `OTEL_ENABLED` | `false` | Export OpenTelemetry traces to the collector |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://127.0.0.1:4317` | collector |
| `OTEL_SERVICE_NAME` | `ai-api` | |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | empty | LLM tracing; off unless host and both keys are set |
| `PROMETHEUS_URL` / `GRAFANA_URL` | — | dashboards |

Prometheus metrics are always exposed at `GET /metrics`; no configuration is
required. See `docs/PHASE12_OBSERVABILITY.md`.

### AI API
| Variable | Default | Description |
|---|---|---|
| `AI_API_HOST` | `0.0.0.0` | |
| `AI_API_PORT` | `8000` | |
| `AI_API_LOG_LEVEL` | `info` | |
| `AI_RATE_LIMIT_PER_MINUTE` | `60` | |
| `AI_MAX_REQUEST_BYTES` | `1048576` | bounded request size |

## Secret-handling rules

- Provider keys, database passwords and JWT/session secrets are never
  committed, logged, or returned to the browser.
- If no LLM credentials are configured the platform uses a clearly labelled
  mock provider and never presents mock output as real AI output.
- The AI service derives identity from the enterprise session token and
  re-validates authorization server-side; the browser is never trusted.
