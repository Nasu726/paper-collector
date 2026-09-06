ALTER TABLE recommendation_snapshots
ADD COLUMN score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_model_score
ON recommendation_snapshots(model_version, score DESC, scored_at DESC);
