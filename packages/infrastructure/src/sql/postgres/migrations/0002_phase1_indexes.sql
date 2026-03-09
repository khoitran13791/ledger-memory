-- Up Migration

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ledger_events_conv_seq
  ON ledger_events(conversation_id, seq);

CREATE INDEX IF NOT EXISTS idx_ledger_events_tsv
  ON ledger_events USING GIN(content_tsv);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_conv
  ON summary_nodes(conversation_id);

CREATE INDEX IF NOT EXISTS idx_summary_nodes_tsv
  ON summary_nodes USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_context_items_conv
  ON context_items(conversation_id, position);

CREATE INDEX IF NOT EXISTS idx_artifacts_conv
  ON artifacts(conversation_id);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_artifacts_conv;
DROP INDEX IF EXISTS idx_context_items_conv;
DROP INDEX IF EXISTS idx_summary_nodes_tsv;
DROP INDEX IF EXISTS idx_summary_nodes_conv;
DROP INDEX IF EXISTS idx_ledger_events_tsv;
DROP INDEX IF EXISTS idx_ledger_events_conv_seq;

COMMIT;
