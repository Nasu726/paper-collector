PRAGMA foreign_keys = ON;

ALTER TABLE papers ADD COLUMN accepted_at TEXT;

CREATE TABLE IF NOT EXISTS paper_field_evidence (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_record_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  value_json TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, field_name, provider, provider_record_id, source_field)
);

CREATE INDEX IF NOT EXISTS idx_paper_field_evidence_paper_field
  ON paper_field_evidence(paper_id, field_name, observed_at);

CREATE TABLE IF NOT EXISTS paper_field_sources (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_record_id TEXT NOT NULL,
  source_field TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paper_id, field_name)
);

CREATE TABLE IF NOT EXISTS crossref_enrichment_state (
  paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  doi TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'not_found', 'error')),
  last_attempt_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_crossref_enrichment_state_status_attempt
  ON crossref_enrichment_state(status, last_attempt_at);
