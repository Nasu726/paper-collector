PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intent TEXT NOT NULL,
  exclusions TEXT,
  source_policy TEXT NOT NULL CHECK (source_policy IN ('published_only', 'accepted_when_verifiable', 'include_preprints')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL,
  authors_json TEXT NOT NULL,
  published_at TEXT,
  venue TEXT,
  publication_status TEXT NOT NULL CHECK (publication_status IN ('published', 'accepted', 'preprint', 'unknown')),
  source_url TEXT NOT NULL,
  pdf_url TEXT,
  identifiers_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_feeds (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, feed_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  paper_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('saved', 'rejected')),
  decided_at TEXT NOT NULL,
  feed_ids_json TEXT NOT NULL,
  recommendation_bucket TEXT CHECK (recommendation_bucket IN ('very_high', 'high', 'medium', 'low', 'very_low')),
  model_version TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendation_snapshots (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  feed_id TEXT,
  bucket TEXT NOT NULL CHECK (bucket IN ('very_high', 'high', 'medium', 'low', 'very_low')),
  reasons_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  UNIQUE (paper_id, feed_id, model_version)
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  feed_id TEXT,
  event_type TEXT NOT NULL,
  event_at TEXT NOT NULL,
  weight REAL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_paper_feeds_feed_id ON paper_feeds(feed_id);
CREATE INDEX IF NOT EXISTS idx_decisions_state ON decisions(state);
CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_paper_id ON recommendation_snapshots(paper_id);
CREATE INDEX IF NOT EXISTS idx_feedback_events_paper_id_event_at ON feedback_events(paper_id, event_at);
