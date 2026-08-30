import defaultStatusConfig from '../../../config/pulse.config.ts'
import { parseStatusConfig, type StatusConfig } from '@pulseflare/schema'

import { getWorkerConfig } from './config'

export const BOOTSTRAP_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_group TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS service_status (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  current_status TEXT NOT NULL CHECK (current_status IN ('up', 'down')),
  latest_reason TEXT,
  checked_at TEXT NOT NULL,
  failing_since TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  latest_reason TEXT,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR status = 'resolved')
);

CREATE TABLE IF NOT EXISTS latency_points (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  location_label TEXT NOT NULL
);

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
  delivered_at TEXT,
  claimed_by TEXT,
  claimed_until TEXT
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
  locked_until TEXT NOT NULL,
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS check_results_service_recorded_idx ON check_results(service_id, recorded_at);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS scheduler_runs_started_idx ON scheduler_runs(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_service_idx
  ON incidents(service_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_delivery_idx
  ON notification_outbox(incident_id, provider_id, event);
`

type CountRow = {
  service_count: number | string | null
}

export function getRuntimeConfig(env: unknown): StatusConfig {
  return parseStatusConfig(getWorkerConfig(env) ?? defaultStatusConfig)
}

export async function ensureBootstrapSchema(database: D1Database): Promise<void> {
  await database.exec(BOOTSTRAP_SCHEMA_SQL)
}

export async function countServices(database: D1Database): Promise<number> {
  const row = await database
    .prepare('SELECT COUNT(*) AS service_count FROM services WHERE is_active = 1')
    .first<CountRow>()

  return Number(row?.service_count ?? 0)
}

export async function syncServices(database: D1Database, config: StatusConfig): Promise<void> {
  const statements = [database.prepare('UPDATE services SET is_active = 0').bind()]

  for (const [index, service] of config.services.entries()) {
    statements.push(
      database
        .prepare(
          `
            INSERT INTO services (id, name, service_group, sort_order, is_active)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              service_group = excluded.service_group,
              sort_order = excluded.sort_order,
              is_active = 1
          `
        )
        .bind(service.id, service.name, service.group ?? null, index)
    )
  }

  await database.batch(statements)
}
