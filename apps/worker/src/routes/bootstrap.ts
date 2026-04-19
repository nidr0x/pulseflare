import defaultStatusConfig from '../../../../config/pulse.config.ts'
import { parseStatusConfig, type StatusConfig } from '@pulseflare/schema'

import { getBootstrapToken, getWorkerConfig, getWorkerDatabase } from '../config'

const BOOTSTRAP_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_group TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)
);

CREATE TABLE IF NOT EXISTS service_status (
  service_id TEXT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  current_status TEXT NOT NULL CHECK (current_status IN ('up', 'down')),
  latest_reason TEXT,
  checked_at TEXT NOT NULL
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
`

type CountRow = {
  service_count: number | string | null
}

function getRuntimeConfig(env: unknown): StatusConfig {
  return parseStatusConfig(getWorkerConfig(env) ?? defaultStatusConfig)
}

async function countServices(database: D1Database): Promise<number> {
  const row = await database
    .prepare('SELECT COUNT(*) AS service_count FROM services')
    .first<CountRow>()

  return Number(row?.service_count ?? 0)
}

async function seedServices(database: D1Database, config: StatusConfig): Promise<void> {
  for (const [index, service] of config.services.entries()) {
    await database
      .prepare(
        `
          INSERT OR IGNORE INTO services (id, name, service_group, sort_order)
          VALUES (?, ?, ?, ?)
        `
      )
      .bind(service.id, service.name, service.group ?? null, index)
      .run()
  }
}

export async function handleBootstrapInstall(request: Request, env: unknown): Promise<Response> {
  const expectedToken = getBootstrapToken(env)
  const providedToken = new URL(request.url).searchParams.get('token')

  if (!expectedToken || providedToken !== expectedToken) {
    return Response.json({ error: 'Unauthorized bootstrap request' }, { status: 401 })
  }

  const database = getWorkerDatabase(env)

  if (!database) {
    return Response.json({ error: 'Missing PULSEFLARE_D1 binding' }, { status: 500 })
  }

  const config = getRuntimeConfig(env)

  await database.exec(BOOTSTRAP_SCHEMA_SQL)

  const initialCount = await countServices(database)

  if (initialCount > 0) {
    return Response.json({
      created: false,
      seededServices: 0,
      totalServices: initialCount,
    })
  }

  await seedServices(database, config)

  const totalServices = await countServices(database)

  return Response.json({
    created: true,
    seededServices: totalServices - initialCount,
    totalServices,
  })
}
