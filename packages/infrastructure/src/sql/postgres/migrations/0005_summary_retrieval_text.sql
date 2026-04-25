-- Up Migration

BEGIN;

ALTER TABLE summary_nodes
  ADD COLUMN IF NOT EXISTS retrieval_text TEXT;

UPDATE summary_nodes
SET retrieval_text = content
WHERE retrieval_text IS NULL;

ALTER TABLE summary_nodes
  ALTER COLUMN retrieval_text SET NOT NULL;

ALTER TABLE summary_nodes
  ADD COLUMN IF NOT EXISTS retrieval_text_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', retrieval_text)) STORED;

DROP INDEX IF EXISTS idx_summary_nodes_tsv;

CREATE INDEX IF NOT EXISTS idx_summary_nodes_tsv
  ON summary_nodes USING GIN (retrieval_text_tsv);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_summary_nodes_tsv;

ALTER TABLE summary_nodes
  DROP COLUMN IF EXISTS retrieval_text_tsv;

ALTER TABLE summary_nodes
  DROP COLUMN IF EXISTS retrieval_text;

CREATE INDEX IF NOT EXISTS idx_summary_nodes_tsv
  ON summary_nodes USING GIN (to_tsvector('english', content));

COMMIT;
