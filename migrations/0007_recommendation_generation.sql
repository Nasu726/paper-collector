CREATE TABLE IF NOT EXISTS recommendation_builds (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL UNIQUE,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recommendation_builds_model_generation
ON recommendation_builds(model_version, generation DESC);

CREATE TABLE IF NOT EXISTS recommendation_model_state (
  model_version TEXT PRIMARY KEY,
  live_generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
