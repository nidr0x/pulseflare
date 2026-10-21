import { describe, expect, it } from 'vitest'
import type { StatusConfig } from '@pulseflare/schema'

import { runScheduledChecks } from './scheduler'
import { buildRuntimeServicesPayload } from '../routes/public'
import { createMigrationBackedD1Database } from '../testing/sqlite-d1'
import { getRuntimeConfig } from '../install'

const silentLogger = { info() {}, warn() {}, error() {} } as never

const downProbe = async () => new Response('down', { status: 503 })

function createEnv(database: D1Database, services: StatusConfig['services']) {
  return {
    PULSEFLARE_D1: database,
    STATUS_CONFIG: {
      site: { name: 'Pulseflare' },
      services,
      notifications: { providers: [] },
      maintenances: [],
    },
  } as never
}

function apiService(): StatusConfig['services'][number] {
  return {
    id: 'api',
    name: 'API',
    checks: [{ type: 'http', url: 'https://check.example.com/health' }],
  }
}

function readSnapshotRow(raw: import('node:sqlite').DatabaseSync): { updated_at: string; payload_json: string } {
  const row = raw.prepare('SELECT updated_at, payload_json FROM snapshot_state WHERE id = 1').get()

  if (!row || typeof row.updated_at !== 'string' || typeof row.payload_json !== 'string') {
    throw new Error('snapshot_state row is missing')
  }

  return row as { updated_at: string; payload_json: string }
}

// The scheduler lease release writes wall-clock time, so all checkedAt values
// must stay comfortably ahead of real time while preserving relative deltas.
describe('scheduler snapshot materialization (real migrations)', () => {
  const base = Date.now()

  it('stores the exact public services payload the route would compute live', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const checkedAt = new Date(base).toISOString()

    const summary = await runScheduledChecks(
      createEnv(database, [apiService()]),
      downProbe,
      checkedAt,
      downProbe,
      silentLogger
    )

    expect(summary.downCount).toBe(1)

    const row = readSnapshotRow(raw)
    const config = getRuntimeConfig(createEnv(database, [apiService()]))
    const livePayload = JSON.parse(JSON.stringify(await buildRuntimeServicesPayload(config, database, new Date(checkedAt))))

    expect(row.updated_at).toBe(checkedAt)
    expect(JSON.parse(row.payload_json)).toEqual(livePayload)
    expect(livePayload[0]).toMatchObject({ id: 'api', status: 'outage' })
  })

  it('keeps a run healthy when materialization fails', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const wrappedDatabase: D1Database = {
      ...database,
      prepare(query: string) {
        if (query.includes('snapshot_state')) {
          throw new Error('snapshot_state unavailable')
        }

        return database.prepare(query)
      },
    } as unknown as D1Database

    const summary = await runScheduledChecks(
      createEnv(wrappedDatabase, [apiService()]),
      downProbe,
      new Date(base).toISOString(),
      downProbe,
      silentLogger
    )

    expect(summary).toMatchObject({ servicesChecked: 1, downCount: 1 })
    expect(
      raw.prepare("SELECT status FROM scheduler_runs WHERE status = 'succeeded'").get()
    ).toBeTruthy()
    expect(raw.prepare('SELECT COUNT(*) AS count FROM snapshot_state').get()).toMatchObject({ count: 0 })
  })
})

describe('Public snapshot serving materialized data (real migrations)', () => {
  const base = Date.now()

  async function seedMaterializedRun(deleteRawRows = true) {
    const { database, raw } = createMigrationBackedD1Database()
    const checkedAt = new Date(base).toISOString()

    await runScheduledChecks(createEnv(database, [apiService()]), downProbe, checkedAt, downProbe, silentLogger)
    if (deleteRawRows) {
      // Remove the raw runtime rows so ONLY the materialized payload can serve
      // the outage state; a live fallback would report an unknown service.
      raw.exec('DELETE FROM daily_check_rollups; DELETE FROM service_status;')
    }
    return { database, raw, checkedAt }
  }

  async function fetchSnapshot(env: never) {
    const worker = (await import('../index')).default

    return worker.fetch(new Request('https://example.com/api/public/snapshot'), env, {} as ExecutionContext)
  }

  it('serves a fresh materialized snapshot without relying on runtime rows', async () => {
    const { database, checkedAt } = await seedMaterializedRun()

    const response = await fetchSnapshot(
      createEnv(database, [apiService()]) as never
    )
    const payload = (await response.json()) as { services: Array<{ id: string; status: string }> }

    expect(response.status).toBe(200)
    expect(payload.services[0]).toMatchObject({ id: 'api', status: 'outage' })
    expect(checkedAt.endsWith('Z')).toBe(true)
  })

  it('falls back to live computation when the materialized row is stale', async () => {
    const { database, raw } = await seedMaterializedRun()

    raw
      .prepare('UPDATE snapshot_state SET updated_at = ?')
      .run(new Date(base - 11 * 60_000).toISOString())

    const response = await fetchSnapshot(createEnv(database, [apiService()]) as never)
    const payload = (await response.json()) as { services: Array<{ id: string; status: string }> }

    expect(response.status).toBe(200)
    expect(payload.services[0]).toMatchObject({ id: 'api', status: 'unknown' })
  })

  it('drops materialized services that are no longer in the config', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const checkedAt = new Date(base).toISOString()

    await runScheduledChecks(createEnv(database, [apiService()]), downProbe, checkedAt, downProbe, silentLogger)

    const row = readSnapshotRow(raw)
    const materializedWithGhost = [...JSON.parse(row.payload_json), { id: 'ghost', name: 'Ghost', status: 'operational' }]
    raw.prepare('UPDATE snapshot_state SET payload_json = ? WHERE id = 1').run(JSON.stringify(materializedWithGhost))

    const response = await fetchSnapshot(createEnv(database, [apiService()]) as never)
    const payload = (await response.json()) as { services: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(payload.services.map((service) => service.id)).toEqual(['api'])
  })

  it('falls back to live computation when config services drift beyond the materialized payload', async () => {
    const { database, raw, checkedAt } = await seedMaterializedRun(false)
    const driftedServices: StatusConfig['services'] = [
      apiService(),
      { id: 'blog', name: 'Blog', checks: [{ type: 'http', url: 'https://blog.example.com' }] },
    ]

    const response = await fetchSnapshot(createEnv(database, driftedServices) as never)
    const payload = (await response.json()) as { services: Array<{ id: string; status: string }> }

    expect(response.status).toBe(200)
    expect(payload.services.map((service) => service.id)).toEqual(['api', 'blog'])
    // Live compute: api has persisted rollups saying down, blog has no data.
    expect(payload.services[0]?.status).toBe('outage')
    expect(payload.services[1]?.status).toBe('unknown')
  })
})
