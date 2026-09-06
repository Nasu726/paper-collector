PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feed_ingestion_state (
  feed_id TEXT PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openalex',
  status TEXT NOT NULL DEFAULT 'never'
    CHECK (status IN ('never', 'success', 'error', 'truncated')),
  watermark_date TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_fetched INTEGER NOT NULL DEFAULT 0,
  last_pages INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feed_ingestion_state_status
  ON feed_ingestion_state(status, updated_at);
