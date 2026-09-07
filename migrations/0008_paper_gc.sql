PRAGMA foreign_keys = ON;

-- Compact learning representation retained after the canonical Paper row is hard-deleted.
-- This is deliberately not a Paper tombstone: it contains no original title,
-- abstract, authors, URLs, venue, or publication metadata.
CREATE TABLE IF NOT EXISTS purged_paper_learning (
  paper_id TEXT PRIMARY KEY,
  feature_version TEXT NOT NULL,
  title_terms TEXT NOT NULL,
  abstract_terms TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  estimated_source_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_purged_paper_learning_purged_at
  ON purged_paper_learning(purged_at);

-- Minimal identity keys prevent a previously rejected Paper from being
-- re-created solely because the full canonical row was physically removed.
CREATE TABLE IF NOT EXISTS seen_paper_identifiers (
  kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'provider')),
  value TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, value, provider)
);

-- Cross-application retention contract for the shared Paper Library.
-- book-reader or another consumer can register a reference before linking live
-- content. ON DELETE RESTRICT provides a second line of defense in addition to
-- the GC eligibility query.
CREATE TABLE IF NOT EXISTS paper_retention_refs (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
  owner TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_paper_retention_refs_paper_id
  ON paper_retention_refs(paper_id);
