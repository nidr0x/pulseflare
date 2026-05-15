PRAGMA foreign_keys = ON;

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_group TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

CREATE TABLE service_status (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  current_status TEXT NOT NULL CHECK (current_status IN ('up', 'down')),
  latest_reason TEXT,
  checked_at TEXT NOT NULL,
  failing_since TEXT
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  latest_reason TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR status = 'resolved')
);

CREATE TABLE latency_points (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  location_label TEXT NOT NULL
);
