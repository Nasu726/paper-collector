ALTER TABLE recommendation_snapshots
ADD COLUMN score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_model_score
ON recommendation_snapshots(model_version, score DESC, scored_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_snapshot_staging (
  build_id TEXT NOT NULL,
  id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  feed_id TEXT,
  bucket TEXT NOT NULL CHECK (bucket IN ('very_high', 'high', 'medium', 'low', 'very_low')),
  reasons_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  scored_at TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (build_id, id)
);

CREATE INDEX IF NOT EXISTS idx_recommendation_snapshot_staging_build
ON recommendation_snapshot_staging(build_id);
