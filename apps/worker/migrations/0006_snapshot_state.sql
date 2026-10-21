-- Materialized public snapshot services payload.
-- The scheduler refreshes the first row after each completed run so the public
-- snapshot can serve it without rescanning 90 days of daily rollups per
-- request. Reads fall back to live computation while the row is missing.
CREATE TABLE snapshot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
