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
| 0007 | `0007_ai_ml.sql` | Experiments, experiment runs, classical-ML model registry and versions (evaluation tables reused from 0004) |
| 0008 | `0008_stage3_assistant.sql` | Assistant conversations/messages/citation snapshots; document search state; chunk page/section; job stage/lease/retry; feedback message link |
| 0009 | `0009_stage4_search.sql` | Saved searches and per-user search history (tenant- and actor-scoped; stores the request, never a frozen result set) |
| 0010 | `0010_stage4_duplicates.sql` | Advisory duplicate/conflict findings between documents (tenant-scoped canonical pair key; document FK cascades; never merges content) |
| 0011 | `0011_stage5_copilot.sql` | Copilot message metadata (`task_type`, `generation_status`, `prompt_version`, `parent_message_id`, `cancelled_at`), typed context references and derived conversation summaries; feedback categories |
| 0012 | `0012_stage6_agent_platform.sql` | Agent/tool lifecycle, immutable version triggers, version-tool snapshots, durable execution state (steps, invocations, checkpoints), AI-native approvals and platform-owned draft artifacts |
| 0013 | `0013_stage6_execution_governance.sql` | Execution lease fencing, single-use approval consumption, tool governance fields |
| 0014 | `0014_source_security_version.sql` | Knowledge-source security version for optimistic concurrency on ACL/classification updates (`version`, check constraint) |
| 0015 | `0015_reliability_backoff.sql` | Persisted retry scheduling (`next_attempt_at`) for index jobs and event deliveries |
| 0016 | `0016_citation_validation.sql` | Citation diagnostics on assistant messages (`warnings`, `citations_required`, `citation_status`) and the `citation_warning` answer status |
| 0017 | `0017_backup_runs.sql` | Backup and restore-drill run metadata for operational metrics and alerts (no payloads or secrets) |
| 0018 | `0018_tenant_row_level_security.sql` | Tenant context helpers, `FORCE ROW LEVEL SECURITY`, and direct/indirect ownership policies for all 43 protected tables; global `schema_migrations` and `backup_runs` are documented exceptions |
| 0019 | `0019_system_access_role_gate.sql` | Require membership in the `ai_system_access` marker role (in addition to the transaction-local GUC) for system scope; fail closed if the provisioning roles are absent |
| 0020 | `0020_document_versions.sql` | Per-document monotonic `version`, expression indexes for `metadata->product/part_number/revision`, and metadata-only `ai.document_versions` history (RLS forced; never stores chunk text) |
| 0021 | `0021_copilot_tools_actions.sql` | Copilot tool-invocation trace (read-only, bounded summaries) and controlled enterprise actions (`proposed/approved/rejected/expired/executed/failed`), with a per-tenant unique operation hash for replay prevention (RLS forced) |
| 0022 | `0022_stage6_agent_platform_completion.sql` | Agent lifecycle completion (`suspended/active/inactive`, duplication provenance, soft delete, working config), reusable templates, tenant-scoped execution/agent memory, one-time and recurring schedules with a per-instant unique run key, and multi-agent delegation records (RLS forced; cross-tenant FK integrity checked) |
| 0023 | `0023_stage7_knowledge_graph.sql` | Enterprise knowledge graph and digital thread: tenant-scoped entity/relationship type registries, graph entities de-duplicated by `(tenant_id, entity_type, stable_key)`, lightweight entity/relationship version history, provenance/confidence/effective dates, a unique partial index for active edges, `touch_updated_at` triggers and forced RLS with a cross-tenant reference integrity check |
| 0024 | `0024_stage8_product_bom.sql` | Product & BOM intelligence: tenant-scoped product/part items, revisions, BOM headers/lines, and EBOM→MBOM transformation/reconciliation records; each row may reference a graph entity so the digital thread keeps working without a second graph model (RLS forced) |
| 0025 | `0025_stage9_manufacturing_quality.sql` | Manufacturing structure (plants, production lines, work centres, process plans/revisions, operations, dependencies, consumption, work instructions, resources, production versions) and quality records (issues/nonconformances, inspections/results, root causes, corrective/preventive actions, supplier quality); each row may reference a graph entity (RLS forced) |
| 0026 | `0026_stage10_predictive_intelligence.sql` | Predictive-intelligence foundation: feature definitions/values with lineage and freshness, datasets and versioned splits, prediction strategy/model registry, predictions, recommendations and review lifecycle, and prediction schedules reusing the existing worker/job cadence (RLS forced) |

`0019` has a deployment prerequisite: run
`infrastructure/db/roles/provision_roles.sql` as a superuser first. The
migration deliberately errors rather than silently preserving the GUC-only
system scope. See `infrastructure/db/roles/README.md` and
`docs/tenant-isolation.md`.

See `docs/database.md` for the data model and rollback guidance.
