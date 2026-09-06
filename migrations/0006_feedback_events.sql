PRAGMA foreign_keys = ON;

ALTER TABLE feedback_events ADD COLUMN surface TEXT;
ALTER TABLE feedback_events ADD COLUMN feed_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE feedback_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE feedback_events ADD COLUMN received_at TEXT;

CREATE TABLE IF NOT EXISTS feedback_event_feeds (
  event_id TEXT NOT NULL REFERENCES feedback_events(id) ON DELETE CASCADE,
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, feed_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_events_type_event_at
  ON feedback_events(event_type, event_at);

CREATE INDEX IF NOT EXISTS idx_feedback_event_feeds_feed_id_event_id
  ON feedback_event_feeds(feed_id, event_id);
