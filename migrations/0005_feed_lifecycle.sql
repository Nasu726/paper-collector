PRAGMA foreign_keys = ON;

ALTER TABLE feeds ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS idx_feeds_archived_active
  ON feeds(archived_at, active, created_at);
