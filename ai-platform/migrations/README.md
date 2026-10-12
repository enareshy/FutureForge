# Database migrations

Versioned, forward-only SQL applied in filename order by
`scripts/migrate.sh` / `make migrate`.

- Target: the shared enterprise PostgreSQL (with the `pgvector` extension).
- Schema: `ai`.
- Tracking table: `ai.schema_migrations(version, applied_at, checksum,
  description)`, created automatically by the migration runner.
- Each migration is applied inside a single transaction
  (`psql --single-transaction`), so a failed migration rolls back atomically.
- Migrations are idempotent (`IF NOT EXISTS` / guarded DDL) so a partial run
  can be safely repeated.

Naming: `NNNN_short_description.sql`, e.g. `0002_ai_config.sql`.

Applied history for this repository:

| Version | File | Purpose |
|---|---|---|
| 0001 | `0001_init.sql` | `ai` schema + pgvector extension |
| 0002 | `0002_ai_config.sql` | Configuration, providers/models, prompts, agents |
| 0003 | `0003_ai_knowledge.sql` | Knowledge sources, documents, chunks, embeddings |
| 0004 | `0004_ai_runtime.sql` | Executions, usage/cost, evaluations, feedback, audit, jobs |
| 0005 | `0005_ai_governance.sql` | Configurable per-tenant usage/retention/feature policies |
| 0006 | `0006_ai_events.sql` | Durable event log, per-consumer deliveries, dead letters |

See `docs/database.md` for the data model and rollback guidance.
