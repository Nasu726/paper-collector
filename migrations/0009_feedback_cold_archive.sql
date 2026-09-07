PRAGMA foreign_keys = ON;

-- Bounded recommendation signal retained in hot D1 after raw feedback events
-- have been verified and archived to R2. metadata_json is normalized to an
-- empty string when the legacy/raw row used NULL; the recommendation parser
-- treats both forms as the same default context.
CREATE TABLE IF NOT EXISTS feedback_compact (
  paper_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '',
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, event_type, metadata_json)
);

CREATE INDEX IF NOT EXISTS idx_feedback_compact_paper_id
  ON feedback_compact(paper_id);

-- Manifest for verified cold objects. A row is inserted only in the same D1
-- transaction that compacts the represented signal and deletes the raw rows.
-- Therefore every completed row points at an R2 object that was verified first.
CREATE TABLE IF NOT EXISTS cold_archive_batches (
  batch_id TEXT PRIMARY KEY,
  archive_type TEXT NOT NULL CHECK (archive_type = 'feedback-v1'),
  object_key TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count > 0),
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  cutoff_at TEXT NOT NULL,
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  object_etag TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cold_archive_batches_completed_at
  ON cold_archive_batches(completed_at);

-- One short lease prevents overlapping archive requests with different cutoffs
-- or batch sizes from compacting the same raw event twice. A crashed Worker
-- cannot block archiving permanently because the lease expires automatically.
CREATE TABLE IF NOT EXISTS cold_archive_leases (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
