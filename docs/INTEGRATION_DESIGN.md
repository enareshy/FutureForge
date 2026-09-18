# Integration & API Framework — Design

The Integration Hub is the platform's single control plane for connecting Helix to
external systems. It deliberately reuses existing foundations instead of
re-implementing them: identity and permissions come from IAM, configuration from the
scoped configuration service, asynchronous execution from the background job engine,
delivery/retry primitives from the delivery and notification frameworks, immutable
history from audit, secrets from `server/crypto.js`, and discovery metadata from the
search/object registries.

## Goals

- One registry for integrations, external systems, credentials and API endpoints.
- Provider-independent adapters (REST, SOAP, file, message, database, webhook, internal).
- A publish/subscribe event bus with idempotency, filtering and replay.
- Inbound and outbound webhooks with signature verification and replay protection.
- Durable message queues with retry policy, backoff and dead-letter recovery.
- Declarative transformation/mapping and object identity mapping.
- Import/export transfers driven by registered handlers.
- Scheduled integrations executed by the shared job engine.
- First-class monitoring: health checks, execution metrics, delivery metrics and dashboards.
- API governance: catalog, versioning, API clients with hashed keys and rate limiting.

## Architecture

```
                    ┌──────────────────────────── UI (React) ───────────────────────────┐
                    │  Integration hub: overview · integrations · systems · events …    │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │ /api/integration, /api/v1/integration
                    ┌───────────────────────────────▼───────────────────────────────────┐
                    │ Express router (server/app.js) — auth + can("iam.integration.*")   │
                    └───────────────────────────────┬───────────────────────────────────┘
                                                    │
        ┌───────────────┬───────────────┬───────────┼───────────┬───────────────┐
        ▼               ▼               ▼           ▼           ▼               ▼
   Definitions      Systems        Events       Webhooks     Messages       Transfers
   Executions       Credentials    Subscriptions Deliveries  Queues         Import/Export
        │               │               │           │           │               │
        └───────────────┴───────────────┴─────┬─────┴───────────┴───────────────┘
                                              ▼
                                   Adapters · Transform · Mappings
                                              │
                                              ▼
                          Job engine · Audit · Crypto · Search · Config · IAM
```

### Service layout

Integration services mirror the Search and Audit module conventions: a facade plus
granular files.

| File | Responsibility |
| --- | --- |
| `server/services/integration.js` | Facade re-exporting namespaces (`Definitions`, `Events`, `Webhooks`, …) |
| `validation.js` | Enums/vocabularies, retry policy/backoff, masking, signing, SSRF guard, templating |
| `repository.js` | DTO mappers (secrets never leave the service) and query helpers |
| `hooks.js` | Audit, structured logging, error classification, request correlation |
| `adapters.js` | Adapter registry and built-in adapters |
| `transform.js` | Transformation CRUD and the mapping/data-conversion engine |
| `systems.js` | External systems, credentials, connection tests and health |
| `endpoints.js` | API endpoint registry for integrations |
| `schedules.js` | Integration schedules delegated to the job engine |
| `definitions.js` | Integrations, version snapshots, executions and handler registry |
| `events.js` | Event types, subscriptions, publish/filter/replay, event deliveries |
| `webhooks.js` | Inbound receivers and outbound webhook dispatch |
| `messages.js` | Durable message queues and retry/backoff semantics |
| `deadletter.js` | Dead-letter queue operations |
| `mappings.js` | External↔internal object identity mapping with conflict detection |
| `transfers.js` | Import/export registries and transfer execution |
| `monitoring.js` | Health, execution/delivery metrics and dashboards |
| `apicatalog.js` | API catalog, API clients (hashed keys), usage metering, rate limiting |
| `jobs.js` | Worker handlers and periodic maintenance sweep |

## Data model

Migration `020_integration_framework` adds the following tables:

- **Registry** — `integration_definitions`, `integration_definition_versions`,
  `integration_endpoints`, `integration_schedules`, `integration_transfers`.
- **Connectivity** — `external_systems`, `integration_credentials`,
  `integration_health_checks`.
- **Data shaping** — `transformation_definitions`, `external_object_mappings`.
- **Events** — `integration_event_types`, `integration_event_subscriptions`,
  `integration_events`, `integration_event_deliveries`.
- **Webhooks** — `integration_webhook_endpoints`, `integration_webhook_receipts`,
  `integration_webhook_subscriptions`, `integration_webhook_deliveries`.
- **Queues** — `integration_messages`, `integration_dead_letters`.
- **Governance** — `integration_api_catalog`, `integration_api_clients`,
  `integration_api_usage`.

All business tables carry `tenant_id` and are scoped through the same tenant filters as
the rest of the platform. Codes are lowercase and unique.

## Integrations and execution

An integration definition captures `integration_type`, `direction`, `adapter_type`,
`protocol`, source/target system references, credential, transformation and retry
policy. Every write creates an immutable version snapshot in
`integration_definition_versions`; operators can diff and restore.

Executions record a header row plus an ordered step timeline
(`integration_execution_steps`). Each run:

1. resolves the adapter (with the credential secret and optional transformation),
2. invokes the external system,
3. classifies failures (`configuration`, `authentication`, `authorization`, `validation`,
   `external_system`, `network`, `timeout`, `rate_limit`, `technical`),
4. persists the result, publishes `IntegrationExecutionCompleted`, and
5. updates health/run state.

## Adapters

`adapters.js` exposes `registerAdapter`/`createAdapter`/`listAdapters`. Built-ins cover
REST, SOAP, webhook, file, message/broker, database, GraphQL, SFTP and `internal`.
Custom behaviour is referenced by name (`config.handler_code`) and resolved through the
integration handler registry (`registerIntegrationHandler`), so business modules plug in
without modifying the hub.

## Event bus

`ensureDefaultEventTypes` seeds a domain catalogue (13 event types). `publishEvent`
supports idempotency keys, filter-based fan-out and replay. Internal subscribers are
processed by `processDueDeliveries`; webhook subscribers are handled by the webhook
dispatcher. Delivery attempts, status and errors are stored per subscriber.

## Webhooks

- **Inbound** (`receiveInboundWebhook`): validates signature / API key / basic auth,
  enforces IP allow-lists and replay windows, deduplicates by signature and optionally
  republishes onto the internal event bus. The public receiver
  (`POST /api/v1/integration/webhooks/receive/:code`) is authenticated by the endpoint
  itself, not a session.
- **Outbound** (`processDueWebhookDeliveries`): signs payloads with HMAC-SHA256,
  enforces per-webhook timeouts, retries with backoff and auto-disables a webhook after
  its failure threshold.

## Messages and dead letters

`enqueueMessage` writes durable queue rows; the worker's `INTEGRATION_MESSAGE` handler
claims and processes them with `normalizeRetryPolicy`/`computeBackoffSeconds`. Exhausted
messages move to `integration_dead_letters`, where operators can inspect, retry or
resolve them.

## Transfers

`registerImporter`/`registerExporter` register resource handlers. `previewImport`
detects fields, `runImportTransfer` parses CSV/JSON/XML and invokes the handler, and
`runExportTransfer` serialises query results. Snapshots are downloadable through
`getTransferContent`.

## Monitoring

`runHealthChecks` probes every active external system and records
`integration_health_checks`. `monitoringOverview` aggregates definition status,
schedules, endpoints, webhooks, system health, execution metrics (success rate, p95
duration, errors by category, top failing integrations) and delivery metrics (event,
webhook, queue and dead-letter depth).

## API governance

The `integration_api_catalog` documents published APIs (group, version, auth, schemas,
docs URL, lifecycle). `integration_api_clients` issue hashed API keys (plaintext shown
once), support rotation/revocation and scope/allow-list restrictions.
`recordApiUsage`/`checkRateLimit` provide usage metering and a fixed-window limiter.

## Security

- Secrets are encrypted with `encryptSecret` (AES-256-GCM keyed by `HELIX_AUTH_SECRET`)
  and never returned in API responses (`has_secret` only).
- API keys are stored as hashes with a visible prefix.
- Configurable outbound URLs pass `assertSafeUrl` (SSRF guard) unless
  `INTEGRATION_ALLOW_PRIVATE_HOSTS=true`.
- Payloads are masked (`maskPayload`) before logging or external responses.
- Every mutation is written to the audit framework under `integration.*` actions.

## Permissions

The seed registers `iam.integration` and 12 child resources (`systems`, `endpoints`,
`transforms`, `mappings`, `schedules`, `events`, `webhooks`, `messages`, `deadletters`,
`transfers`, `monitoring`, `api`), each with create/read/update/delete (+ execute where
relevant). They are granted to the `platform` and `iamAdmin` roles by default.

## Frontend

`web/src/pages/IntegrationPage.jsx` is a tabbed console backed by
`web/src/components/integration/*`: overview/monitoring, definitions/executions/
schedules, systems & credentials, events, webhooks, messages & dead letters, data &
mappings, and API catalog/clients/usage. `web/src/api.js` exposes the `integration`
namespace for all 123 hub routes.
