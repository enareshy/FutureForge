# Import & Export Framework — Design

The Import & Export Framework (`data-exchange`) is the platform's centralized data
movement layer. It moves data between the platform and external systems (Excel,
CSV, JSON, XML, REST, databases, legacy PLM, ERP, CAD, MES) without any business
module re-implementing parsing, transport, mapping, validation or reconciliation.

Source of truth: `server/services/data-exchange/`. Tables: `ie_*` (25 tables) in
`server/schema.sql`, migration marker `031_import_export_framework`.

## Architectural rules

- **Centralized service.** Business modules declare *what* moves and *how*
  (definitions, mappings, transformations, validations). The framework owns
  transport, parsing, orchestration, duplicate handling, reconciliation, history
  and reconciliation.
- **No copy of business data.** Records flow straight through to the owning
  module via the object framework; the framework stores only results, errors,
  checkpoints and generated export artifacts.
- **No raw credentials.** Connector credentials are referenced by an opaque
  `secret_ref`; the framework never persists external secrets.
- **Pluggable connectors.** A provider registry keyed by connector type; adding a
  format or endpoint is a registration, not an engine change.
- **Safe evaluation.** Expressions and templates use a safe evaluator (no `eval`,
  no `Function`).

## Layering

| Layer | Files | Responsibility |
| --- | --- | --- |
| Contracts | `constants.js`, `errors.js`, `refs.js`, `validation.js` | Vocabulary, standardized errors `{error, code?, details?}`, refs, input guards |
| Persistence | `repository.js`, `configuration.js`, `history.js` | Public row shapes, tenant config, unified history |
| Connectors | `connectors/{registry,codecs,builtins,index}.js` | Provider registry, dependency-free codecs, 12 built-in connectors |
| Engines | `engines/{transform,mapping,validation,lookup,duplicate,schema,index}.js` | Declarative mapping / transformation / validation / duplicate / schema engines |
| Definitions | `import-definitions.js`, `export-definitions.js`, `templates.js` | Versioned, immutable-once-active definitions and children |
| Execution | `importer.js`, `exporter.js` | Job ledger, batching, checkpoints, reconciliation, artifact generation |
| Jobs & metrics | `jobs.js`, `metrics.js`, `foundation.js` | Background handlers, health, bootstrap |
| Integrations | `lifecycle.js`, `quality.js`, `catalog.js`, `search.js`, `seed.js` | Reuse of Lifecycle, Data Quality, Catalog and Search |
| HTTP | `router-data-exchange.js` | REST surface mounted at `/api/data-exchange` and `/api/v1/data-exchange` |

## Connectors

12 built-in connector types: `CSV`, `EXCEL`, `JSON`, `XML`, `REST`, `DATABASE`,
`FILE`, `CLOUD_STORAGE`, `LEGACY_PLM`, `ERP`, `CAD`, `MES`. Each declares
directions, capabilities (`READ`, `WRITE`, `SCHEMA_DISCOVERY`, ...) and formats.
Codecs are dependency-free (CSV, JSON/NDJSON, XML, SpreadsheetML 2003).

## Definitions & versioning

Definitions are versioned. A `DRAFT` definition is editable; once `ACTIVE` it is
edited by creating a new version, which snapshots the current state and bumps the
definition back to a new draft. Mapping/transformation/validation/filter/field
selections are child resources.

## Import lifecycle

1. `PREVIEW` / `VALIDATE_ONLY` — parse, map, transform, validate, security, no write.
2. `IMPORT` — batch loop with checkpoints, per-record results, structured errors,
   duplicate strategies (`REJECT`, `SKIP`, `UPDATE`, `UPSERT`, `CREATE_NEW`, `MERGE`),
   security (`authorizeRecord`, `enforceRecordFields`), lifecycle guard and
   reconciliation (count / key / checksum).
3. Idempotency: a repeated request carrying the same `Idempotency-Key` returns the
   original job instead of re-running.

## Export lifecycle

Collect (object framework + filters + sort) → lifecycle filter → field/row
security and masking → field selection → transformations → serialize (CSV/JSON/
XML/Excel/…) → destination (DOWNLOAD / FILE_STORAGE / OBJECT_STORAGE / DATABASE /
REST_API / EXTERNAL_SYSTEM) → artifact in `ie_blobs` with expiry and checksum.

## Security

- Route-level IAM permission resources `iam.data_exchange.*`.
- Field-level, row-level, classification and masking enforced on both import and
  export via P0 Data Security; unauthorized downloads are rejected.
- `authorizeRecord` falls back to platform IAM (`iam.objects.instances`) when no
  explicit object policy exists, so tenant admins can move data without authoring
  a policy first; explicit policies and field rules still take precedence.

## Integrations

- **Lifecycle & Archival** (`lifecycle.js`): imports refuse to write into a state
  whose `update` capability is off (ARCHIVED / COLD_STORAGE / PURGED) unless an
  explicit recovery override is supplied; exports drop records whose state
  disallows `export`.
- **Data Governance & Quality** (`quality.js`): after import, created/updated
  objects are evaluated by the shared Data Quality service; the aggregate score is
  recorded on the job summary and the optional quality gate fails a run below the
  configured minimum.
- **Data Catalog** (`catalog.js`): definitions carry a `catalog_refs` block
  (domain, object, attributes, business terms, source, consumer, classification)
  resolved against the shared catalog.
- **Search** (`search.js`): import definitions, export definitions and jobs are
  indexed as read-only search object types.
- **Events, Jobs, Audit, Notifications:** exchange events are published as domain
  events; work runs through the shared job scheduler; every mutation is audited.

## Configuration

Tenant-scoped, validated on write (`CONFIG_DEFAULTS` + `CONFIG_BOUNDS`):
batch sizes, duplicate/error/transaction strategies, preview and export limits,
artifact expiry, quality gate, lifecycle guard, masking, storage provider and REST
throttles.
