-- Phase 5: optimistic concurrency for knowledge-source security updates.
-- Existing rows start at version 1; every ACL/classification update increments it.
ALTER TABLE ai.knowledge_sources
  ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;

ALTER TABLE ai.knowledge_sources
  DROP CONSTRAINT IF EXISTS knowledge_sources_version_chk;
ALTER TABLE ai.knowledge_sources
  ADD CONSTRAINT knowledge_sources_version_chk CHECK (version >= 1);
