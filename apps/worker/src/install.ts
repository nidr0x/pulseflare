import defaultStatusConfig from '../../../config/pulse.config.ts'
import { parseStatusConfig, type StatusConfig } from '@pulseflare/schema'

import { getWorkerConfig } from './config'
import { BASE_SCHEMA_SQL } from './schema'

type CountRow = {
  service_count: number | string | null
}

export function getRuntimeConfig(env: unknown): StatusConfig {
  return parseStatusConfig(getWorkerConfig(env) ?? defaultStatusConfig)
}

export async function ensureBootstrapSchema(database: D1Database): Promise<void> {
  await database.exec(BASE_SCHEMA_SQL)
}

export async function countServices(database: D1Database): Promise<number> {
  const row = await database
    .prepare('SELECT COUNT(*) AS service_count FROM services')
    .first<CountRow>()

  return Number(row?.service_count ?? 0)
}

export async function syncServices(database: D1Database, config: StatusConfig): Promise<void> {
  for (const [index, service] of config.services.entries()) {
    await database
      .prepare(
        `
          INSERT INTO services (id, name, service_group, sort_order)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            service_group = excluded.service_group,
            sort_order = excluded.sort_order
        `
      )
      .bind(service.id, service.name, service.group ?? null, index)
      .run()
  }
}
