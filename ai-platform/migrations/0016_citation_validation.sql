-- 0016_citation_validation.sql — SEC-12: persist citation diagnostics.
--
-- `answer_status` gains an explicit citation-failure state so an answer is not
-- reported as fully supported when required inline citations are missing or
-- invalid. `warnings` stores only opaque warning codes (never prompts or source
-- content), and `citation_status` records the shared validator outcome.
--
-- Existing rows are unchanged: warnings default to [], citation validation was
-- not recorded historically, and their existing answer_status is preserved.

ALTER TABLE ai.assistant_messages
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ai.assistant_messages
  ADD COLUMN IF NOT EXISTS citations_required boolean NOT NULL DEFAULT false;
ALTER TABLE ai.assistant_messages
  ADD COLUMN IF NOT EXISTS citation_status text;

ALTER TABLE ai.assistant_messages
  DROP CONSTRAINT IF EXISTS assistant_messages_answer_status_chk;
ALTER TABLE ai.assistant_messages
  ADD CONSTRAINT assistant_messages_answer_status_chk
    CHECK (answer_status IS NULL
           OR answer_status IN ('answered', 'insufficient_evidence',
                                'citation_warning', 'error', 'cancelled'));

ALTER TABLE ai.assistant_messages
  DROP CONSTRAINT IF EXISTS assistant_messages_citation_status_chk;
ALTER TABLE ai.assistant_messages
  ADD CONSTRAINT assistant_messages_citation_status_chk
    CHECK (citation_status IS NULL
           OR citation_status IN ('not_required', 'valid', 'missing', 'invalid'));
