PRAGMA foreign_keys = ON;

ALTER TABLE feeds ADD COLUMN provider_query TEXT;

CREATE TABLE IF NOT EXISTS paper_identifiers (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'provider')),
  value TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (kind, value, provider)
);

CREATE INDEX IF NOT EXISTS idx_paper_identifiers_paper_id
  ON paper_identifiers(paper_id);

CREATE TABLE IF NOT EXISTS ingestion_provenance (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_record_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  provider_updated_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, feed_id, provider, provider_record_id)
);

CREATE INDEX IF NOT EXISTS idx_ingestion_provenance_feed_provider
  ON ingestion_provenance(feed_id, provider, last_seen_at);
