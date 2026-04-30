-- Up Migration

BEGIN;

CREATE INDEX IF NOT EXISTS idx_ledger_events_continuity_kind
  ON ledger_events(conversation_id, ((metadata ->> 'continuityKind')))
  WHERE metadata ->> 'kind' = 'continuity_record';

CREATE INDEX IF NOT EXISTS idx_ledger_events_continuity_record_id
  ON ledger_events(conversation_id, ((metadata ->> 'recordId')))
  WHERE metadata ->> 'kind' = 'continuity_record';

CREATE INDEX IF NOT EXISTS idx_ledger_events_metadata_gin
  ON ledger_events USING GIN (metadata);

COMMIT;

-- Down Migration

BEGIN;

DROP INDEX IF EXISTS idx_ledger_events_metadata_gin;
DROP INDEX IF EXISTS idx_ledger_events_continuity_record_id;
DROP INDEX IF EXISTS idx_ledger_events_continuity_kind;

COMMIT;
