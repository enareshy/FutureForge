-- 0001_init.sql — AI platform bootstrap.
--
-- Creates the dedicated `ai` schema and enables pgvector. Real AI tables are
-- added by later migrations (Phase 3). Idempotent: safe to re-run.

CREATE SCHEMA IF NOT EXISTS ai;

-- Vector storage for embeddings. Requires the pgvector extension compiled
-- into the PostgreSQL instance (see docs/installation.md).
CREATE EXTENSION IF NOT EXISTS vector;

COMMENT ON SCHEMA ai IS 'Enterprise AI Platform — configuration, knowledge, RAG, agents, usage and evaluation metadata.';
