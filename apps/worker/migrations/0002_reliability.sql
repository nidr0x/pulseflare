ALTER TABLE services ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE service_status ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0);
ALTER TABLE service_status ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0);

CREATE TABLE IF NOT EXISTS check_results (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up', 'down')),
  reason TEXT NOT NULL,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  location_label TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('incident_opened', 'incident_resolved')),
  incident_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  services_checked INTEGER NOT NULL DEFAULT 0 CHECK (services_checked >= 0),
  up_count INTEGER NOT NULL DEFAULT 0 CHECK (up_count >= 0),
  down_count INTEGER NOT NULL DEFAULT 0 CHECK (down_count >= 0),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS check_results_service_recorded_idx ON check_results(service_id, recorded_at);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS scheduler_runs_started_idx ON scheduler_runs(started_at);
