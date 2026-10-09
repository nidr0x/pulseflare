ALTER TABLE incidents
  ADD COLUMN impact TEXT NOT NULL DEFAULT 'minor' CHECK (impact IN ('minor', 'major'));

ALTER TABLE scheduler_lease
  ADD COLUMN last_pruned_at TEXT;

CREATE TABLE daily_check_rollups (
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  location_label TEXT NOT NULL,
  up_count INTEGER NOT NULL DEFAULT 0 CHECK (up_count >= 0),
  down_count INTEGER NOT NULL DEFAULT 0 CHECK (down_count >= 0),
  last_latency_ms INTEGER CHECK (last_latency_ms IS NULL OR last_latency_ms >= 0),
  last_latency_at TEXT,
  PRIMARY KEY (service_id, day, location_label)
);

WITH daily_counts AS (
  SELECT
    service_id,
    substr(recorded_at, 1, 10) AS day,
    COALESCE(location_label, 'default') AS location_label,
    SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
    SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_count
  FROM check_results
  GROUP BY service_id, substr(recorded_at, 1, 10), COALESCE(location_label, 'default')
), latest_latency AS (
  SELECT
    service_id,
    substr(recorded_at, 1, 10) AS day,
    COALESCE(location_label, 'default') AS location_label,
    latency_ms,
    recorded_at,
    ROW_NUMBER() OVER (
      PARTITION BY service_id, substr(recorded_at, 1, 10), COALESCE(location_label, 'default')
      ORDER BY recorded_at DESC, id DESC
    ) AS row_number
  FROM check_results
  WHERE latency_ms IS NOT NULL
)
INSERT INTO daily_check_rollups (
  service_id, day, location_label, up_count, down_count, last_latency_ms, last_latency_at
)
SELECT
  daily_counts.service_id,
  daily_counts.day,
  daily_counts.location_label,
  daily_counts.up_count,
  daily_counts.down_count,
  latest_latency.latency_ms,
  latest_latency.recorded_at
FROM daily_counts
LEFT JOIN latest_latency
  ON latest_latency.service_id = daily_counts.service_id
  AND latest_latency.day = daily_counts.day
  AND latest_latency.location_label = daily_counts.location_label
  AND latest_latency.row_number = 1;

CREATE INDEX check_results_recorded_idx ON check_results(recorded_at);
CREATE INDEX latency_points_recorded_idx ON latency_points(recorded_at);
CREATE INDEX notification_outbox_created_status_idx ON notification_outbox(status, created_at);
CREATE INDEX daily_check_rollups_day_idx ON daily_check_rollups(day);
