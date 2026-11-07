"""Real-PostgreSQL evidence for the SEC-19 row-level security backstop.

These tests need system scope and DML to seed multiple tenants. Use the
development owner/fixture role (`helix`) or, after role provisioning,
`ai_worker`; do not use `ai_api`, which has no system access. FORCE RLS keeps
even the table owner subject to policies. They deliberately omit
application tenant predicates and query tables directly.

Run with:
    AI_TEST_POSTGRES=1 pytest -o addopts="" tests/test_rls_tenant_isolation.py
"""

from __future__ import annotations

import asyncio
import os
import uuid
from types import SimpleNamespace

import asyncpg
import pytest

from ai_api.config.settings import get_settings
from ai_api.infrastructure.db import (
    PostgresDatabase,
    current_rls_context,
    current_tenant_id,
    system_scope,
    tenant_scope,
)
from ai_api.infrastructure.events.postgres_event_store import PostgresEventStore
from ai_api.infrastructure.repositories.postgres_ai_repository import (
    PostgresAiRepository,
)
from ai_api.security.policies import Principal

TENANT_A = 990119
TENANT_B = 990120

PROTECTED_TABLES = (
    "agent_approvals",
    "agent_artifacts",
    "agent_checkpoints",
    "agent_delegations",
    "agent_execution_steps",
    "agent_memory_entries",
    "agent_schedules",
    "agent_templates",
    "agent_tool_invocations",
    "agent_tool_versions",
    "agent_tools",
    "agent_version_tools",
    "agent_versions",
    "agents",
    "assistant_context_refs",
    "assistant_conversation_summaries",
    "assistant_conversations",
    "assistant_message_sources",
    "assistant_messages",
    "audit_events",
    "bom_headers",
    "bom_lines",
    "bom_reconciliations",
    "bom_transformation_entries",
    "bom_transformation_runs",
    "copilot_actions",
    "copilot_tool_invocations",
    "document_chunks",
    "document_versions",
    "documents",
    "embeddings",
    "evaluation_results",
    "evaluations",
    "event_dead_letters",
    "event_deliveries",
    "events",
    "executions",
    "experiment_runs",
    "experiments",
    "feedback",
    "governance_policies",
    "graph_entities",
    "graph_entity_types",
    "graph_entity_versions",
    "graph_relationship_types",
    "graph_relationship_versions",
    "graph_relationships",
    "jobs",
    "knowledge_sources",
    "ml_model_versions",
    "ml_models",
    "model_versions",
    "models",
    "platform_settings",
    "product_items",
    "product_revisions",
    "mfg_operation_consumptions",
    "mfg_operation_dependencies",
    "mfg_operations",
    "mfg_plants",
    "mfg_process_revisions",
    "mfg_processes",
    "mfg_production_lines",
    "mfg_production_versions",
    "mfg_resources",
    "mfg_work_centres",
    "mfg_work_instructions",
    "quality_actions",
    "quality_inspection_results",
    "quality_inspections",
    "quality_issues",
    "quality_root_causes",
    "quality_supplier_issues",
    "predictive_feature_definitions",
    "predictive_feature_values",
    "predictive_datasets",
    "predictive_dataset_versions",
    "predictive_models",
    "predictive_model_versions",
    "predictive_predictions",
    "predictive_recommendations",
    "predictive_recommendation_feedback",
    "predictive_schedules",
    "prompt_templates",
    "prompt_versions",
    "providers",
    "search_duplicate_findings",
    "search_history",
    "search_saved",
    "usage_records",
)

_DELETE_TENANT_TABLES = (
    "agent_approvals",
    "agent_artifacts",
    "agent_checkpoints",
    "agent_delegations",
    "agent_memory_entries",
    "agent_schedules",
    "agent_templates",
    "agent_tool_invocations",
    "agent_execution_steps",
    "agent_version_tools",
    "assistant_context_refs",
    "assistant_conversation_summaries",
    "assistant_message_sources",
    "copilot_actions",
    "copilot_tool_invocations",
    "feedback",
    "quality_supplier_issues",
    "quality_actions",
    "quality_root_causes",
    "quality_inspection_results",
    "quality_inspections",
    "quality_issues",
    "mfg_production_versions",
    "mfg_resources",
    "mfg_work_instructions",
    "mfg_operation_consumptions",
    "mfg_operation_dependencies",
    "mfg_operations",
    "mfg_process_revisions",
    "mfg_processes",
    "mfg_work_centres",
    "mfg_production_lines",
    "mfg_plants",
    "bom_reconciliations",
    "bom_transformation_entries",
    "bom_transformation_runs",
    "bom_lines",
    "bom_headers",
    "product_revisions",
    "product_items",
    "predictive_recommendation_feedback",
    "predictive_recommendations",
    "predictive_predictions",
    "predictive_model_versions",
    "predictive_models",
    "predictive_dataset_versions",
    "predictive_datasets",
    "predictive_feature_values",
    "predictive_feature_definitions",
    "predictive_schedules",
    "graph_relationship_versions",
    "graph_relationships",
    "graph_entity_versions",
    "graph_entities",
    "graph_relationship_types",
    "graph_entity_types",
    "usage_records",
    "audit_events",
    "executions",
    "assistant_messages",
    "assistant_conversations",
    "events",
    "search_duplicate_findings",
    "search_history",
    "search_saved",
    "jobs",
    "embeddings",
    "document_chunks",
    "document_versions",
    "documents",
    "knowledge_sources",
    "evaluations",
    "experiment_runs",
    "experiments",
    "ml_models",
    "models",
    "providers",
    "prompt_templates",
    "agent_tool_versions",
    "agent_tools",
    "agents",
    "platform_settings",
    "governance_policies",
)

_NO_TENANT_CHILD_DELETES = (
    "DELETE FROM ai.event_deliveries WHERE event_id IN "
    "(SELECT event_id FROM ai.events WHERE tenant_id = $1)",
    "DELETE FROM ai.event_dead_letters WHERE event_id IN "
    "(SELECT event_id FROM ai.events WHERE tenant_id = $1)",
    "DELETE FROM ai.evaluation_results WHERE evaluation_id IN "
    "(SELECT id FROM ai.evaluations WHERE tenant_id = $1)",
    "DELETE FROM ai.model_versions WHERE model_id IN "
    "(SELECT id FROM ai.models WHERE tenant_id = $1)",
    "DELETE FROM ai.prompt_versions WHERE template_id IN "
    "(SELECT id FROM ai.prompt_templates WHERE tenant_id = $1)",
    "DELETE FROM ai.agent_versions WHERE agent_id IN "
    "(SELECT id FROM ai.agents WHERE tenant_id = $1)",
    "DELETE FROM ai.ml_model_versions WHERE ml_model_id IN "
    "(SELECT id FROM ai.ml_models WHERE tenant_id = $1)",
)


def _requires_postgres() -> None:
    if os.environ.get("AI_TEST_POSTGRES", "") != "1":
        pytest.skip("set AI_TEST_POSTGRES=1 to run PostgreSQL RLS tests")
    settings = get_settings()
    try:
        import socket

        with socket.create_connection(
            (settings.postgres_host, settings.postgres_port), timeout=1
        ):
            pass
    except OSError:
        pytest.skip("PostgreSQL is not reachable")


async def _db() -> PostgresDatabase:
    db = PostgresDatabase(get_settings())
    await db.connect()
    return db


async def _cleanup(db: PostgresDatabase, tenant_id: int) -> None:
    with system_scope():
        for statement in _NO_TENANT_CHILD_DELETES:
            await db.execute(statement, tenant_id)
        for table in _DELETE_TENANT_TABLES:
            await db.execute(f"DELETE FROM ai.{table} WHERE tenant_id = $1", tenant_id)


async def _insert(db: PostgresDatabase, sql: str, *args):
    return await db.fetchrow(sql, *args)


async def _seed_tenant(db: PostgresDatabase, tenant_id: int) -> dict[str, int]:
    suffix = uuid.uuid4().hex[:10]
    embedding = "[" + ",".join(["0.1"] * 1536) + "]"
    event_a = str(uuid.uuid4())
    event_b = str(uuid.uuid4())
    with system_scope():
        provider = await _insert(
            db,
            "INSERT INTO ai.providers (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"prov-{suffix}",
            "Provider",
        )
        model = await _insert(
            db,
            "INSERT INTO ai.models (tenant_id, provider_id, code, name) "
            "VALUES ($1,$2,$3,$4) RETURNING id",
            tenant_id,
            provider["id"],
            f"model-{suffix}",
            "Model",
        )
        await _insert(
            db,
            "INSERT INTO ai.model_versions (model_id, version, config) VALUES ($1,1,'{}')",
            model["id"],
        )
        prompt = await _insert(
            db,
            "INSERT INTO ai.prompt_templates (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"prompt-{suffix}",
            "Prompt",
        )
        await _insert(
            db,
            "INSERT INTO ai.prompt_versions (template_id, version, body) "
            "VALUES ($1,1,'hello')",
            prompt["id"],
        )
        agent = await _insert(
            db,
            "INSERT INTO ai.agents (tenant_id, code, name, lifecycle_status) "
            "VALUES ($1,$2,$3,'published') RETURNING id",
            tenant_id,
            f"agent-{suffix}",
            "Agent",
        )
        agent_version = await _insert(
            db,
            "INSERT INTO ai.agent_versions (agent_id, version, definition, status) "
            "VALUES ($1,1,'{}','published') RETURNING id",
            agent["id"],
        )
        tool = await _insert(
            db,
            "INSERT INTO ai.agent_tools (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"tool-{suffix}",
            "Tool",
        )
        tool_version = await _insert(
            db,
            "INSERT INTO ai.agent_tool_versions (tool_id, tenant_id, version, definition) "
            "VALUES ($1,$2,1,'{}') RETURNING id",
            tool["id"],
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_version_tools "
            "(tenant_id, agent_version_id, tool_id, tool_version_id) "
            "VALUES ($1,$2,$3,$4)",
            tenant_id,
            agent_version["id"],
            tool["id"],
            tool_version["id"],
        )
        source = await _insert(
            db,
            "INSERT INTO ai.knowledge_sources (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"source-{suffix}",
            "Source",
        )
        document = await _insert(
            db,
            "INSERT INTO ai.documents (tenant_id, source_id, external_id, title, status) "
            "VALUES ($1,$2,$3,$4,'indexed') RETURNING id",
            tenant_id,
            source["id"],
            f"doc-{suffix}",
            "Document",
        )
        document_b = await _insert(
            db,
            "INSERT INTO ai.documents (tenant_id, source_id, external_id, title, status) "
            "VALUES ($1,$2,$3,$4,'indexed') RETURNING id",
            tenant_id,
            source["id"],
            f"doc-b-{suffix}",
            "Document B",
        )
        chunk = await _insert(
            db,
            "INSERT INTO ai.document_chunks (tenant_id, document_id, chunk_index, content) "
            "VALUES ($1,$2,0,'chunk') RETURNING id",
            tenant_id,
            document["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.document_versions "
            "(tenant_id, document_id, source_id, external_id, version, reason) "
            "VALUES ($1,$2,$3,$4,1,'deleted') RETURNING id",
            tenant_id,
            document["id"],
            source["id"],
            f"doc-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.embeddings (tenant_id, chunk_id, model_code, embedding) "
            "VALUES ($1,$2,$3,$4::vector)",
            tenant_id,
            chunk["id"],
            f"model-{suffix}",
            embedding,
        )
        execution = await _insert(
            db,
            "INSERT INTO ai.executions "
            "(tenant_id, operation, status, agent_id, agent_version_id, model_id) "
            "VALUES ($1,'agent','running',$2,$3,$4) RETURNING id",
            tenant_id,
            agent["id"],
            agent_version["id"],
            model["id"],
        )
        step = await _insert(
            db,
            "INSERT INTO ai.agent_execution_steps "
            "(tenant_id, execution_id, step_key, sequence, status) "
            "VALUES ($1,$2,'step-1',1,'pending') RETURNING id",
            tenant_id,
            execution["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_tool_invocations "
            "(tenant_id, execution_id, step_id, tool_code, tool_version_id) "
            "VALUES ($1,$2,$3,$4,$5)",
            tenant_id,
            execution["id"],
            step["id"],
            f"tool-{suffix}",
            tool_version["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_checkpoints (tenant_id, execution_id, sequence, state) "
            "VALUES ($1,$2,1,'{}')",
            tenant_id,
            execution["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_approvals "
            "(tenant_id, execution_id, step_id, step_key, tool_code, operation_hash, "
            "risk_class, expires_at) VALUES ($1,$2,$3,'step-1',$4,'hash','low',now())",
            tenant_id,
            execution["id"],
            step["id"],
            f"tool-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_artifacts "
            "(tenant_id, execution_id, artifact_type, title, content) "
            "VALUES ($1,$2,'text','Artifact','body')",
            tenant_id,
            execution["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_templates "
            "(tenant_id, code, name, definition) VALUES ($1,$2,'Template','{}')",
            tenant_id,
            f"template-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_memory_entries "
            "(tenant_id, agent_id, scope, memory_key, content, owner_actor_id) "
            "VALUES ($1,$2,'agent',$3,'remember',1)",
            tenant_id,
            agent["id"],
            f"mem-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_schedules "
            "(tenant_id, agent_id, name, schedule_kind, cron, next_run_at) "
            "VALUES ($1,$2,$3,'recurring','0 2 * * *', now() + interval '1 day')",
            tenant_id,
            agent["id"],
            f"schedule-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.agent_delegations "
            "(tenant_id, parent_execution_id, parent_agent_id, child_agent_id, "
            "step_key, mode, status, depth) "
            "VALUES ($1,$2,$3,$3,'delegate','sequential','completed',1)",
            tenant_id,
            execution["id"],
            agent["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.usage_records (tenant_id, execution_id, kind, quantity) "
            "VALUES ($1,$2,'input',10)",
            tenant_id,
            execution["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.audit_events (tenant_id, execution_id, action) "
            "VALUES ($1,$2,'test')",
            tenant_id,
            execution["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.jobs (tenant_id, type, status) VALUES ($1,'index','queued')",
            tenant_id,
        )
        evaluation = await _insert(
            db,
            "INSERT INTO ai.evaluations (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"eval-{suffix}",
            "Evaluation",
        )
        await _insert(
            db,
            "INSERT INTO ai.evaluation_results (evaluation_id, case_id) VALUES ($1,'case-1')",
            evaluation["id"],
        )
        experiment = await _insert(
            db,
            "INSERT INTO ai.experiments (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"exp-{suffix}",
            "Experiment",
        )
        run = await _insert(
            db,
            "INSERT INTO ai.experiment_runs (tenant_id, experiment_id) "
            "VALUES ($1,$2) RETURNING id",
            tenant_id,
            experiment["id"],
        )
        ml_model = await _insert(
            db,
            "INSERT INTO ai.ml_models (tenant_id, code, name) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"ml-{suffix}",
            "ML model",
        )
        await _insert(
            db,
            "INSERT INTO ai.ml_model_versions (ml_model_id, version, run_id) "
            "VALUES ($1,1,$2)",
            ml_model["id"],
            run["id"],
        )
        conversation = await _insert(
            db,
            "INSERT INTO ai.assistant_conversations (tenant_id, actor_id, title) "
            "VALUES ($1,101,'Conversation') RETURNING id",
            tenant_id,
        )
        message = await _insert(
            db,
            "INSERT INTO ai.assistant_messages (tenant_id, conversation_id, role, content) "
            "VALUES ($1,$2,'user','hello') RETURNING id",
            tenant_id,
            conversation["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.assistant_message_sources "
            "(tenant_id, message_id, rank, document_id, chunk_id) "
            "VALUES ($1,$2,1,$3,$4)",
            tenant_id,
            message["id"],
            document["id"],
            chunk["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.assistant_context_refs "
            "(tenant_id, conversation_id, message_id, context_type, object_id) "
            "VALUES ($1,$2,$3,'document','ref-1')",
            tenant_id,
            conversation["id"],
            message["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.assistant_conversation_summaries "
            "(conversation_id, tenant_id, summary) VALUES ($1,$2,'summary')",
            conversation["id"],
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.feedback (tenant_id, execution_id, message_id, rating) "
            "VALUES ($1,$2,$3,5)",
            tenant_id,
            execution["id"],
            message["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.events (event_id, type, version, tenant_id) "
            "VALUES ($1,'rls.test',1,$2)",
            event_a,
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.events (event_id, type, version, tenant_id) "
            "VALUES ($1,'rls.test',1,$2)",
            event_b,
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.event_deliveries (event_id, consumer_group, status) "
            "VALUES ($1,'rls-test','pending')",
            event_a,
        )
        await _insert(
            db,
            "INSERT INTO ai.event_dead_letters (event_id, consumer_group, last_error) "
            "VALUES ($1,'rls-test','failed')",
            event_b,
        )
        await _insert(
            db,
            "INSERT INTO ai.search_history (tenant_id, actor_id, query) "
            "VALUES ($1,101,'query')",
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.search_saved (tenant_id, actor_id, name, query) "
            "VALUES ($1,101,'saved','query')",
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.search_duplicate_findings "
            "(tenant_id, dedupe_key, kind, match_type, confidence, document_a_id, document_b_id) "
            "VALUES ($1,$2,'duplicate','checksum',0.9,$3,$4)",
            tenant_id,
            f"dup-{suffix}",
            document["id"],
            document_b["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.platform_settings (tenant_id, key, value) "
            "VALUES ($1,'feature','{}')",
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.governance_policies (tenant_id, policy) VALUES ($1,'{}')",
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.copilot_actions "
            "(tenant_id, action_type, summary, operation_hash, status) "
            "VALUES ($1,'update','summary','hash','proposed')",
            tenant_id,
        )
        await _insert(
            db,
            "INSERT INTO ai.copilot_tool_invocations "
            "(tenant_id, tool_code, status) VALUES ($1,'knowledge.search','succeeded')",
            tenant_id,
        )
        graph_entity = await _insert(
            db,
            "INSERT INTO ai.graph_entities "
            "(tenant_id, entity_type, stable_key, name) "
            "VALUES ($1,'part',$2,'Graph part') RETURNING id",
            tenant_id,
            f"graph-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.graph_entity_versions "
            "(tenant_id, entity_id, version, snapshot) VALUES ($1,$2,1,'{}')",
            tenant_id,
            graph_entity["id"],
        )
        graph_entity_b = await _insert(
            db,
            "INSERT INTO ai.graph_entities "
            "(tenant_id, entity_type, stable_key, name) "
            "VALUES ($1,'product',$2,'Graph product') RETURNING id",
            tenant_id,
            f"graph-prod-{suffix}",
        )
        graph_relationship = await _insert(
            db,
            "INSERT INTO ai.graph_relationships "
            "(tenant_id, relationship_type, source_entity_id, target_entity_id) "
            "VALUES ($1,'contains',$2,$3) RETURNING id",
            tenant_id,
            graph_entity_b["id"],
            graph_entity["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.graph_relationship_versions "
            "(tenant_id, relationship_id, version, snapshot) VALUES ($1,$2,1,'{}')",
            tenant_id,
            graph_relationship["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.graph_entity_types (tenant_id, code, name) "
            "VALUES ($1,$2,'Tenant entity type')",
            tenant_id,
            f"tenant-type-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.graph_relationship_types "
            "(tenant_id, code, name, source_types, target_types) "
            "VALUES ($1,$2,'Tenant rel type','[]','[]')",
            tenant_id,
            f"tenant-rel-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_feature_definitions "
            "(tenant_id, feature_key, data_type) "
            "VALUES ($1,$2,'number') RETURNING id",
            tenant_id,
            f"feature-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_feature_values "
            "(tenant_id, feature_key, entity_type, entity_id, value) "
            "VALUES ($1,$2,'product_item',1,'1.0'::jsonb)",
            tenant_id,
            f"feature-{suffix}",
        )
        dataset = await _insert(
            db,
            "INSERT INTO ai.predictive_datasets "
            "(tenant_id, dataset_key) VALUES ($1,$2) RETURNING id",
            tenant_id,
            f"dataset-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_dataset_versions "
            "(tenant_id, dataset_id, version, split) VALUES ($1,$2,1,'train')",
            tenant_id,
            dataset["id"],
        )
        model = await _insert(
            db,
            "INSERT INTO ai.predictive_models "
            "(tenant_id, model_key, prediction_type) "
            "VALUES ($1,$2,'defect_risk') RETURNING id",
            tenant_id,
            f"model-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_model_versions "
            "(tenant_id, model_id, version) VALUES ($1,$2,'1.0.0')",
            tenant_id,
            model["id"],
        )
        prediction = await _insert(
            db,
            "INSERT INTO ai.predictive_predictions "
            "(tenant_id, prediction_key, prediction_type, subject_type) "
            "VALUES ($1,$2,'defect_risk','product_item') RETURNING id",
            tenant_id,
            f"prediction-{suffix}",
        )
        recommendation = await _insert(
            db,
            "INSERT INTO ai.predictive_recommendations "
            "(tenant_id, recommendation_key, prediction_id) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            f"recommendation-{suffix}",
            prediction["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_recommendation_feedback "
            "(tenant_id, recommendation_id, reviewer, decision) "
            "VALUES ($1,$2,'rls','comment')",
            tenant_id,
            recommendation["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.predictive_schedules "
            "(tenant_id, schedule_key, prediction_type, subject_type) "
            "VALUES ($1,$2,'defect_risk','product_item')",
            tenant_id,
            f"schedule-{suffix}",
        )
        # Stage 8/9 domain tables. The cross-tenant read test asserts every
        # protected table is non-empty for its own tenant, so the seed must
        # cover all of them rather than depending on rows left by earlier
        # test modules (that made a clean database fail).
        parent_item = await _insert(
            db,
            "INSERT INTO ai.product_items (tenant_id, item_type, item_key, name) "
            "VALUES ($1,'assembly',$2,'Parent') RETURNING id",
            tenant_id,
            f"parent-{suffix}",
        )
        child_item = await _insert(
            db,
            "INSERT INTO ai.product_items (tenant_id, item_type, item_key, name) "
            "VALUES ($1,'part',$2,'Child') RETURNING id",
            tenant_id,
            f"child-{suffix}",
        )
        parent_revision = await _insert(
            db,
            "INSERT INTO ai.product_revisions (tenant_id, item_id, revision) "
            "VALUES ($1,$2,'A') RETURNING id",
            tenant_id,
            parent_item["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.product_revisions (tenant_id, item_id, revision) "
            "VALUES ($1,$2,'A') RETURNING id",
            tenant_id,
            child_item["id"],
        )
        bom_header = await _insert(
            db,
            "INSERT INTO ai.bom_headers "
            "(tenant_id, bom_type, bom_key, root_item_id, root_revision_id) "
            "VALUES ($1,'EBOM',$2,$3,$4) RETURNING id",
            tenant_id,
            f"bom-{suffix}",
            parent_item["id"],
            parent_revision["id"],
        )
        bom_line = await _insert(
            db,
            "INSERT INTO ai.bom_lines "
            "(tenant_id, bom_header_id, parent_revision_id, child_item_id, line_key) "
            "VALUES ($1,$2,$3,$4,'line-1') RETURNING id",
            tenant_id,
            bom_header["id"],
            parent_revision["id"],
            child_item["id"],
        )
        transform_run = await _insert(
            db,
            "INSERT INTO ai.bom_transformation_runs (tenant_id, source_header_id) "
            "VALUES ($1,$2) RETURNING id",
            tenant_id,
            bom_header["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.bom_transformation_entries "
            "(tenant_id, run_id, source_line_id) VALUES ($1,$2,$3)",
            tenant_id,
            transform_run["id"],
            bom_line["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.bom_reconciliations (tenant_id, source_header_id, run_id) "
            "VALUES ($1,$2,$3)",
            tenant_id,
            bom_header["id"],
            transform_run["id"],
        )
        plant = await _insert(
            db,
            "INSERT INTO ai.mfg_plants (tenant_id, plant_key) VALUES ($1,$2) RETURNING id",
            tenant_id,
            f"plant-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_production_lines (tenant_id, plant_id, line_key) "
            "VALUES ($1,$2,$3)",
            tenant_id,
            plant["id"],
            f"line-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_work_centres (tenant_id, plant_id, work_centre_key) "
            "VALUES ($1,$2,$3)",
            tenant_id,
            plant["id"],
            f"wc-{suffix}",
        )
        process = await _insert(
            db,
            "INSERT INTO ai.mfg_processes (tenant_id, process_key) VALUES ($1,$2) RETURNING id",
            tenant_id,
            f"process-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_process_revisions (tenant_id, process_id, revision) "
            "VALUES ($1,$2,'A')",
            tenant_id,
            process["id"],
        )
        operation = await _insert(
            db,
            "INSERT INTO ai.mfg_operations (tenant_id, process_id, operation_key) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            process["id"],
            f"op-{suffix}",
        )
        depends_on = await _insert(
            db,
            "INSERT INTO ai.mfg_operations (tenant_id, process_id, operation_key) "
            "VALUES ($1,$2,$3) RETURNING id",
            tenant_id,
            process["id"],
            f"op-dep-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_operation_dependencies "
            "(tenant_id, process_id, operation_id, depends_on_operation_id) "
            "VALUES ($1,$2,$3,$4)",
            tenant_id,
            process["id"],
            operation["id"],
            depends_on["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_operation_consumptions "
            "(tenant_id, operation_id, child_item_id, bom_line_id) "
            "VALUES ($1,$2,$3,$4)",
            tenant_id,
            operation["id"],
            child_item["id"],
            bom_line["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_work_instructions (tenant_id, process_id, instruction_key) "
            "VALUES ($1,$2,$3)",
            tenant_id,
            process["id"],
            f"wi-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_resources (tenant_id, resource_key) VALUES ($1,$2)",
            tenant_id,
            f"resource-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.mfg_production_versions "
            "(tenant_id, item_id, version_key, plant_id, process_id, mbom_header_id) "
            "VALUES ($1,$2,$3,$4,$5,$6)",
            tenant_id,
            parent_item["id"],
            f"pv-{suffix}",
            plant["id"],
            process["id"],
            bom_header["id"],
        )
        quality_issue = await _insert(
            db,
            "INSERT INTO ai.quality_issues (tenant_id, issue_key) VALUES ($1,$2) RETURNING id",
            tenant_id,
            f"issue-{suffix}",
        )
        inspection = await _insert(
            db,
            "INSERT INTO ai.quality_inspections (tenant_id, inspection_key) "
            "VALUES ($1,$2) RETURNING id",
            tenant_id,
            f"inspection-{suffix}",
        )
        await _insert(
            db,
            "INSERT INTO ai.quality_inspection_results "
            "(tenant_id, inspection_id, characteristic) VALUES ($1,$2,'diameter')",
            tenant_id,
            inspection["id"],
        )
        root_cause = await _insert(
            db,
            "INSERT INTO ai.quality_root_causes (tenant_id, quality_issue_id) "
            "VALUES ($1,$2) RETURNING id",
            tenant_id,
            quality_issue["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.quality_actions "
            "(tenant_id, quality_issue_id, action_key, root_cause_id) "
            "VALUES ($1,$2,$3,$4)",
            tenant_id,
            quality_issue["id"],
            f"action-{suffix}",
            root_cause["id"],
        )
        await _insert(
            db,
            "INSERT INTO ai.quality_supplier_issues "
            "(tenant_id, quality_issue_id, supplier_ref, component_item_id) "
            "VALUES ($1,$2,$3,$4)",
            tenant_id,
            quality_issue["id"],
            f"supplier-{suffix}",
            child_item["id"],
        )
    return {
        "document": int(document["id"]),
        "event_a": event_a,
        "event_b": event_b,
    }


async def _table_count(db: PostgresDatabase, table: str) -> int:
    value = await db.fetchval(f"SELECT count(*) FROM ai.{table}")
    return int(value or 0)


async def _with_db(scenario) -> None:
    _requires_postgres()
    db = await _db()
    try:
        await _cleanup(db, TENANT_A)
        await _cleanup(db, TENANT_B)
        await scenario(db)
    finally:
        await _cleanup(db, TENANT_A)
        await _cleanup(db, TENANT_B)
        await db.close()


def test_rls_catalog_uses_force_and_normal_role_cannot_bypass() -> None:
    async def scenario(db: PostgresDatabase) -> None:
        row = await db.fetchrow(
            "SELECT current_user AS role, r.rolsuper, r.rolbypassrls "
            "FROM pg_roles r WHERE r.rolname = current_user"
        )
        assert row is not None
        assert row["rolsuper"] is False
        assert row["rolbypassrls"] is False

        rows = await db.fetch(
            """
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                   pg_get_userbyid(c.relowner) AS owner
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='ai' AND c.relkind='r'
              AND c.relname NOT IN ('schema_migrations','backup_runs')
            ORDER BY c.relname
            """
        )
        assert {r["relname"] for r in rows} == set(PROTECTED_TABLES)
        for row in rows:
            assert row["relrowsecurity"] is True, row["relname"]
            assert row["relforcerowsecurity"] is True, row["relname"]

        policies = await db.fetch(
            "SELECT tablename FROM pg_policies "
            "WHERE schemaname='ai' AND policyname='tenant_isolation'"
        )
        assert {p["tablename"] for p in policies} == set(PROTECTED_TABLES)

        global_rows = await db.fetch(
            """
            SELECT c.relname, c.relrowsecurity
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='ai' AND c.relkind='r'
              AND c.relname IN ('schema_migrations','backup_runs')
            ORDER BY c.relname
            """
        )
        assert [r["relname"] for r in global_rows] == [
            "backup_runs",
            "schema_migrations",
        ]
        assert all(r["relrowsecurity"] is False for r in global_rows)

    asyncio.run(_with_db(scenario))


def test_cross_tenant_reads_are_blocked_for_every_protected_table() -> None:
    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)

        with tenant_scope(TENANT_A):
            for table in PROTECTED_TABLES:
                assert await _table_count(db, table) > 0, table

        with tenant_scope(TENANT_B):
            for table in PROTECTED_TABLES:
                assert await _table_count(db, table) == 0, table

        with system_scope():
            for table in PROTECTED_TABLES:
                assert await _table_count(db, table) > 0, table

        with tenant_scope(None):
            for table in PROTECTED_TABLES:
                assert await _table_count(db, table) == 0, table

    asyncio.run(_with_db(scenario))


def test_cross_tenant_write_update_delete_and_invalid_context_fail_closed() -> None:
    async def scenario(db: PostgresDatabase) -> None:
        seeded = await _seed_tenant(db, TENANT_A)
        await _seed_tenant(db, TENANT_B)
        document_a = seeded["document"]

        with tenant_scope(TENANT_A):
            rows = await db.fetch("SELECT id, tenant_id FROM ai.documents")
            assert rows and all(r["tenant_id"] == TENANT_A for r in rows)

            updated = await db.execute(
                "UPDATE ai.documents SET title='hijacked' WHERE tenant_id = $1",
                TENANT_B,
            )
            assert updated.endswith("0")
            deleted = await db.execute(
                "DELETE FROM ai.documents WHERE tenant_id = $1", TENANT_B
            )
            assert deleted.endswith("0")

            with pytest.raises(asyncpg.PostgresError) as mismatch:
                await db.execute(
                    "INSERT INTO ai.documents "
                    "(tenant_id, source_id, external_id) "
                    "SELECT $1, id, 'cross-tenant' FROM ai.knowledge_sources LIMIT 1",
                    TENANT_B,
                )
            assert mismatch.value.sqlstate == "42501"

            with pytest.raises(asyncpg.PostgresError) as moved:
                await db.execute(
                    "UPDATE ai.documents SET tenant_id = $1 WHERE id = $2",
                    TENANT_B,
                    document_a,
                )
            assert moved.value.sqlstate == "42501"

        with pytest.raises(asyncpg.PostgresError):
            async with db.transaction() as tx:
                await tx.execute("SELECT set_config('ai.tenant_id','not-a-number',true)")
                await tx.fetchval("SELECT count(*) FROM ai.documents")

        with tenant_scope(None):
            assert await _table_count(db, "documents") == 0

        with tenant_scope(TENANT_B):
            rows = await db.fetch(
                "SELECT id, title FROM ai.documents WHERE id = $1", document_a
            )
            assert rows == []
            await db.fetchval("SELECT count(*) FROM ai.documents")

        with system_scope():
            row = await db.fetchrow(
                "SELECT title, tenant_id FROM ai.documents WHERE id = $1", document_a
            )
            assert row is not None
            assert row["title"] == "Document"
            assert row["tenant_id"] == TENANT_A

    asyncio.run(_with_db(scenario))


def test_context_is_transaction_local_and_does_not_leak_after_failure() -> None:
    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        await _seed_tenant(db, TENANT_B)

        for index in range(30):
            tenant = TENANT_A if index % 2 == 0 else TENANT_B
            with tenant_scope(tenant):
                rows = await db.fetch("SELECT tenant_id FROM ai.documents")
                assert rows
                assert {r["tenant_id"] for r in rows} == {tenant}

        with tenant_scope(TENANT_A):
            try:
                async with db.transaction() as tx:
                    await tx.execute(
                        "INSERT INTO ai.platform_settings (tenant_id, key, value) "
                        "VALUES ($1,'rollback-probe','{}')",
                        TENANT_A,
                    )
                    raise RuntimeError("force rollback")
            except RuntimeError:
                pass

        with tenant_scope(None):
            value = await db.fetchval("SELECT current_setting('ai.tenant_id', true)")
            assert value in (None, "")
            assert await _table_count(db, "platform_settings") == 0

        with tenant_scope(TENANT_A):
            assert (
                await db.fetchval(
                    "SELECT count(*) FROM ai.platform_settings "
                    "WHERE key='rollback-probe'"
                )
                == 0
            )

    asyncio.run(_with_db(scenario))


def test_event_consumer_sets_system_then_per_tenant_context() -> None:
    async def scenario(db: PostgresDatabase) -> None:
        # Isolate this consumer group from events that predate the test, then
        # seed fresh undelivered events for both tenants.
        with system_scope():
            await db.execute(
                "INSERT INTO ai.event_deliveries (event_id, consumer_group, status) "
                "SELECT event_id, 'rls-integration', 'delivered' FROM ai.events "
                "ON CONFLICT (event_id, consumer_group) DO NOTHING"
            )
        seed_a = await _seed_tenant(db, TENANT_A)
        seed_b = await _seed_tenant(db, TENANT_B)
        store = PostgresEventStore(db)
        observed: list[tuple[int | None, int]] = []

        async def handler(envelope) -> None:
            observed.append(
                (current_tenant_id(), await _table_count(db, "documents"))
            )

        from ai_api.application.services.event_service import EventConsumer

        consumer = EventConsumer(
            store=store,
            consumer_group="rls-integration",
            handlers={"rls.test": handler},
            batch_size=10,
        )
        await consumer.process_batch()
        assert sorted(t for t, _ in observed) == [TENANT_A, TENANT_A, TENANT_B, TENANT_B]
        assert all(count > 0 for _, count in observed)

        event_ids = [
            seed_a["event_a"],
            seed_a["event_b"],
            seed_b["event_a"],
            seed_b["event_b"],
        ]
        with system_scope():
            deliveries = await db.fetchval(
                "SELECT count(*) FROM ai.event_deliveries "
                "WHERE consumer_group='rls-integration' "
                "AND event_id = ANY($1::uuid[]) AND status='delivered'",
                event_ids,
            )
            assert int(deliveries) == 4
            await db.execute(
                "DELETE FROM ai.event_deliveries WHERE consumer_group='rls-integration'"
            )

    asyncio.run(_with_db(scenario))


def test_indexing_worker_uses_system_discovery_and_tenant_processing(
    monkeypatch,
) -> None:
    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        await _seed_tenant(db, TENANT_B)
        repository = PostgresAiRepository(db)
        from ai_api.application.services.indexing_service import IndexingService

        service = IndexingService(
            repository=repository,
            ingestion=None,  # type: ignore[arg-type]
            settings=get_settings(),
        )
        observed: list[tuple[int | None, bool]] = []

        async def fake_process(self, tenant_id: int, job_id: int):
            observed.append(
                (current_tenant_id(), current_rls_context().system)
            )
            return None

        monkeypatch.setattr(type(service), "process_job", fake_process)
        await service.process_queued(limit=1000)
        assert {TENANT_A, TENANT_B} <= {
            t for t, system in observed if not system
        }
        assert all(system is False for _, system in observed)

    asyncio.run(_with_db(scenario))


def test_get_principal_establishes_request_scope() -> None:
    from ai_api.api.deps import get_principal

    class Provider:
        async def resolve(self, token: str) -> Principal:
            assert token == "token"
            return Principal(
                user_id="u1",
                username="user",
                tenant_id=TENANT_A,
                auth_source="test",
            )

    request = SimpleNamespace(headers={"authorization": "Bearer token"})

    async def scenario() -> None:
        generator = get_principal(request, Provider())  # type: ignore[arg-type]
        principal = await anext(generator)
        assert principal.tenant_id == TENANT_A
        assert current_tenant_id() == TENANT_A
        await generator.aclose()
        assert current_tenant_id() is None

    asyncio.run(scenario())


def test_reconciler_enumerates_system_then_processes_each_tenant(
    monkeypatch,
) -> None:
    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        await _seed_tenant(db, TENANT_B)
        from ai_api.application.services.knowledge_service import KnowledgeService

        service = KnowledgeService(
            repository=PostgresAiRepository(db),
            audit=None,  # type: ignore[arg-type]
            settings=get_settings(),
            access=None,  # type: ignore[arg-type]
            governance=None,  # type: ignore[arg-type]
        )
        observed: list[tuple[int, int | None]] = []

        async def fake_reconcile(self, tenant_id: int, **kwargs):
            observed.append((tenant_id, current_tenant_id()))
            assert current_rls_context().system is False
            return {
                "sources_candidates": 0,
                "sources_queued": 0,
                "sources_would_queue": 0,
                "disabled_sources_skipped": 0,
                "orphans_detected": 0,
                "orphans_deleted": 0,
            }

        monkeypatch.setattr(type(service), "_reconcile_tenant", fake_reconcile)
        report = await service.reconcile_all_tenants(
            limit=10, dry_run=False, max_tenants=200
        )
        assert {tenant for tenant, _ in observed} >= {TENANT_A, TENANT_B}
        assert all(tenant == context for tenant, context in observed)
        assert report["tenants"] == len(observed)

    asyncio.run(_with_db(scenario))


def test_agent_worker_claims_in_system_scope_and_runs_in_tenant_scope() -> None:
    from ai_api.workers.agent import _drain

    class Repository:
        def __init__(self) -> None:
            self.calls = 0

        async def claim_agent_execution(self, *, worker_id: str, lease_seconds: int):
            assert current_rls_context().system is True
            self.calls += 1
            if self.calls > 1:
                return None
            return {"id": 123, "tenant_id": TENANT_A, "status": "running"}

    repository = Repository()

    class Service:
        def __init__(self) -> None:
            self.repository = repository
            self.seen: list[int | None] = []

        async def run_claimed(self, execution) -> None:
            self.seen.append(current_tenant_id())
            assert current_rls_context().system is False

    service = Service()
    settings = SimpleNamespace(
        ai_agent_worker_batch_size=3,
        ai_agent_execution_lease_seconds=60,
    )

    async def scenario() -> None:
        processed = await _drain(service, settings, "worker-test")  # type: ignore[arg-type]
        assert processed == 1
        assert service.seen == [TENANT_A]

    asyncio.run(scenario())


def test_claim_job_is_atomic_against_real_postgres() -> None:
    """Prove the SQL claim, not just the in-memory mirror.

    Two concurrent claims must partition one queued job: exactly one gets the
    row. A live lease is not reclaimable; an expired lease is.
    """

    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        repository = PostgresAiRepository(db)

        with system_scope():
            job = await db.fetchrow(
                "INSERT INTO ai.jobs (tenant_id, type, status) "
                "VALUES ($1,'index','queued') RETURNING id",
                TENANT_A,
            )
        job_id = int(job["id"])

        with tenant_scope(TENANT_A):
            first, second = await asyncio.gather(
                repository.claim_job(
                    TENANT_A, job_id, lease_seconds=300.0, due_only=False
                ),
                repository.claim_job(
                    TENANT_A, job_id, lease_seconds=300.0, due_only=False
                ),
            )
        winners = [row for row in (first, second) if row is not None]
        assert len(winners) == 1
        assert winners[0]["status"] == "running"
        assert int(winners[0]["attempts"]) == 1

        # The live lease blocks a third claimant.
        with tenant_scope(TENANT_A):
            assert (
                await repository.claim_job(
                    TENANT_A, job_id, lease_seconds=300.0, due_only=False
                )
                is None
            )

        # Expiring the lease makes the job reclaimable again.
        with tenant_scope(TENANT_A):
            await db.execute(
                "UPDATE ai.jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE tenant_id = $1 AND id = $2",
                TENANT_A,
                job_id,
            )
            reclaimed = await repository.claim_job(
                TENANT_A, job_id, lease_seconds=300.0, due_only=False
            )
        assert reclaimed is not None
        assert int(reclaimed["attempts"]) == 2

    asyncio.run(_with_db(scenario))


def test_update_job_fence_rejects_a_stale_worker_in_real_postgres() -> None:
    """The claim fence must hold in SQL, not just in the in-memory mirror."""

    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        repository = PostgresAiRepository(db)

        with system_scope():
            job = await db.fetchrow(
                "INSERT INTO ai.jobs (tenant_id, type, status) "
                "VALUES ($1,'index','queued') RETURNING id",
                TENANT_A,
            )
        job_id = int(job["id"])

        with tenant_scope(TENANT_A):
            first = await repository.claim_job(
                TENANT_A, job_id, lease_seconds=300.0, due_only=False
            )
            assert first is not None

            await db.execute(
                "UPDATE ai.jobs SET lease_expires_at = now() - interval '1 second' "
                "WHERE tenant_id = $1 AND id = $2",
                TENANT_A,
                job_id,
            )
            second = await repository.claim_job(
                TENANT_A, job_id, lease_seconds=300.0, due_only=False
            )
            assert second is not None
            assert int(second["attempts"]) == int(first["attempts"]) + 1

            stale = await repository.update_job(
                TENANT_A,
                job_id,
                {"status": "succeeded", "result": {"stale": True}},
                expected_attempts=int(first["attempts"]),
            )
            assert stale is None

            current = await repository.get_job(TENANT_A, job_id)
            assert current is not None
            assert current["status"] == "running"
            assert int(current["attempts"]) == int(second["attempts"])
            assert current.get("result") is None

            owner = await repository.update_job(
                TENANT_A,
                job_id,
                {"status": "succeeded"},
                expected_attempts=int(second["attempts"]),
            )
            assert owner is not None
            assert owner["status"] == "succeeded"

    asyncio.run(_with_db(scenario))


def test_update_job_clears_explicit_none_in_real_postgres() -> None:
    """Postgres must clear columns passed as explicit ``None``.

    The ``COALESCE($n, column)`` update form retained the old value, so a
    succeeded job kept a previous attempt's ``error``/``error_class`` and a
    requeued job kept a stale ``started_at``/``lease_expires_at``. The memory
    repository cleared them, so the two backends disagreed on the same call.
    """

    async def scenario(db: PostgresDatabase) -> None:
        await _seed_tenant(db, TENANT_A)
        repository = PostgresAiRepository(db)

        with system_scope():
            job = await db.fetchrow(
                "INSERT INTO ai.jobs (tenant_id, type, status) "
                "VALUES ($1,'index','running') RETURNING id",
                TENANT_A,
            )
        job_id = int(job["id"])

        with tenant_scope(TENANT_A):
            await db.execute(
                "UPDATE ai.jobs SET attempts = 1, error = $3::jsonb, "
                "error_class = 'timeout', lease_expires_at = now() + interval '1 hour', "
                "next_attempt_at = now() + interval '1 hour', started_at = now() "
                "WHERE tenant_id = $1 AND id = $2",
                TENANT_A,
                job_id,
                '{"message": "old"}',
            )

            cleared = await repository.update_job(
                TENANT_A,
                job_id,
                {
                    "status": "succeeded",
                    "error": None,
                    "error_class": None,
                    "lease_expires_at": None,
                    "next_attempt_at": None,
                    "started_at": None,
                },
                expected_attempts=1,
            )
            assert cleared is not None
            assert cleared["status"] == "succeeded"
            assert cleared["error"] is None
            assert cleared["error_class"] is None
            assert cleared["lease_expires_at"] is None
            assert cleared["next_attempt_at"] is None
            assert cleared["started_at"] is None
            # Omitted keys are left untouched.
            assert int(cleared["attempts"]) == 1

            current = await repository.get_job(TENANT_A, job_id)
            assert current is not None
            assert current["error"] is None
            assert current["error_class"] is None

    asyncio.run(_with_db(scenario))
