import { describe, expect, it, vi } from 'vitest'
import type { StatusConfig } from '@pulseflare/schema'
import type { ObservabilityLogger } from '../observability'

import { runScheduledChecks } from './scheduler'
import { createMigrationBackedD1Database } from '../testing/sqlite-d1'

const silentLogger = { info() {}, warn() {}, error() {} } as unknown as ObservabilityLogger

const downProbe = async () => new Response('down', { status: 503 })
const upProbe = async () => new Response('ok')

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

describe('scheduler lifecycle (real migrations)', () => {
  // The scheduler lease release writes wall-clock time, so all checkedAt values
  // must stay comfortably ahead of real time while preserving relative deltas.
  const base = Date.now()

  it('skips a run when another owner holds an unexpired lease, then steals it after expiry', async () => {
    const { database, raw } = createMigrationBackedD1Database()

    raw
      .prepare(
        'INSERT INTO scheduler_lease (id, locked_until, owner_id, last_pruned_at) VALUES (1, ?, ?, NULL)'
      )
      .run(new Date(base + 2 * 60_000).toISOString(), 'other-owner')

    const skipped = await runScheduledChecks(
      createEnv(database, [apiService()]),
      upProbe,
      new Date(base).toISOString(),
      upProbe,
      silentLogger
    )

    expect(skipped).toMatchObject({ servicesChecked: 0, upCount: 0, downCount: 0 })
    expect(raw.prepare('SELECT owner_id FROM scheduler_lease WHERE id = 1').get()).toMatchObject({
      owner_id: 'other-owner',
    })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM scheduler_runs').get()).toMatchObject({
      count: 0,
    })

    const stolen = await runScheduledChecks(
      createEnv(database, [apiService()]),
      upProbe,
      new Date(base + 6 * 60_000).toISOString(),
      upProbe,
      silentLogger
    )

    expect(stolen).toMatchObject({ servicesChecked: 1, upCount: 1, downCount: 0 })
    expect(raw.prepare('SELECT COUNT(*) AS count FROM scheduler_runs').get()).toMatchObject({
      count: 1,
    })
    expect(raw.prepare('SELECT owner_id FROM scheduler_lease WHERE id = 1').get()).toMatchObject({
      owner_id: null,
    })
  })

  it('persists daily per-location rollups for each scheduled run', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const env = createEnv(database, [apiService()])
    const checkedAt = new Date(base).toISOString()

    await runScheduledChecks(env, downProbe, checkedAt, upProbe, silentLogger)
    await runScheduledChecks(env, downProbe, new Date(base + 6 * 60_000).toISOString(), upProbe, silentLogger)

    const rollups = raw
      .prepare(
        'SELECT service_id, day, location_label, up_count, down_count, last_latency_ms FROM daily_check_rollups ORDER BY day'
      )
      .all() as unknown as Array<{
      service_id: string
      day: string
      location_label: string
      up_count: number
      down_count: number
      last_latency_ms: number | null
    }>

    const day = checkedAt.slice(0, 10)
    expect(rollups).toEqual([
      {
        service_id: 'api',
        day,
        location_label: 'default',
        up_count: 0,
        down_count: 2,
        // Failed HTTP checks still record their observed latency; the value is
        // a real elapsed-time measurement, so only assert the type here.
        last_latency_ms: expect.any(Number),
      },
    ])

    const incidents = raw.prepare('SELECT COUNT(*) AS count FROM incidents').get() as {
      count: number
    }

    expect(incidents.count).toBe(1)
  })

  it('prunes historical results beyond retention and records the prune time', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const env = createEnv(database, [apiService()])
    const checkedAt = new Date(base).toISOString()
    const staleAt = new Date(base - 91 * 24 * 60 * 60_000).toISOString()

    raw
      .prepare(
        'INSERT INTO services (id, name, service_group, sort_order, is_active) VALUES (?, ?, NULL, 0, 1)'
      )
      .run('legacy', 'Legacy')
    raw
      .prepare(
        'INSERT INTO check_results (id, service_id, recorded_at, status, reason, location_label) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(crypto.randomUUID(), 'legacy', staleAt, 'up', 'legacy check', 'default')
    raw
      .prepare(
        'INSERT INTO latency_points (id, service_id, recorded_at, latency_ms, location_label) VALUES (?, ?, ?, ?, ?)'
      )
      .run(crypto.randomUUID(), 'legacy', staleAt, 42, 'default')
    raw
      .prepare(
        'INSERT INTO daily_check_rollups (service_id, day, location_label, up_count, down_count) VALUES (?, ?, ?, ?, ?)'
      )
      .run('legacy', staleAt.slice(0, 10), 'default', 1, 0)
    raw
      .prepare('INSERT INTO scheduler_runs (id, started_at, status) VALUES (?, ?, ?)')
      .run(crypto.randomUUID(), staleAt, 'succeeded')
    raw
      .prepare(
        'INSERT INTO notification_outbox (id, provider_id, event, incident_id, service_id, payload_json, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        crypto.randomUUID(),
        'ops',
        'incident_opened',
        'incident-1',
        'legacy',
        '{}',
        'delivered',
        1,
        staleAt,
        staleAt
      )

    await runScheduledChecks(env, upProbe, checkedAt, upProbe, silentLogger)

    const remaining = {
      oldResults: raw
        .prepare('SELECT COUNT(*) AS count FROM check_results WHERE service_id = ?')
        .get('legacy') as { count: number },
      oldLatency: raw
        .prepare('SELECT COUNT(*) AS count FROM latency_points WHERE service_id = ?')
        .get('legacy') as { count: number },
      oldRollups: raw
        .prepare('SELECT COUNT(*) AS count FROM daily_check_rollups WHERE service_id = ?')
        .get('legacy') as { count: number },
      oldRuns: raw
        .prepare('SELECT COUNT(*) AS count FROM scheduler_runs WHERE started_at < ?')
        .get(checkedAt) as { count: number },
      oldOutbox: raw
        .prepare(
          "SELECT COUNT(*) AS count FROM notification_outbox WHERE service_id = ? AND status IN ('delivered', 'failed')"
        )
        .get('legacy') as { count: number },
      lease: raw
        .prepare('SELECT last_pruned_at FROM scheduler_lease WHERE id = 1')
        .get() as { last_pruned_at: string | null },
    }

    expect(remaining.oldResults.count).toBe(0)
    expect(remaining.oldLatency.count).toBe(0)
    expect(remaining.oldRollups.count).toBe(0)
    expect(remaining.oldRuns.count).toBe(0)
    expect(remaining.oldOutbox.count).toBe(0)
    expect(remaining.lease.last_pruned_at).toBe(checkedAt)

    const current = raw
      .prepare('SELECT COUNT(*) AS count FROM daily_check_rollups WHERE service_id = ?')
      .get('api') as { count: number }

    expect(current.count).toBe(1)
  })

  it('archives services removed from config and reactivates them when re-added', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const api = apiService()
    const blog: StatusConfig['services'][number] = {
      id: 'blog',
      name: 'Blog',
      checks: [{ type: 'http', url: 'https://blog.example.com' }],
    }

    await runScheduledChecks(
      createEnv(database, [api, blog]),
      upProbe,
      new Date(base).toISOString(),
      upProbe,
      silentLogger
    )
    expect(
      raw.prepare('SELECT id, is_active FROM services ORDER BY id').all() as unknown as Array<{
        id: string
        is_active: number
      }>
    ).toEqual([
      { id: 'api', is_active: 1 },
      { id: 'blog', is_active: 1 },
    ])

    await runScheduledChecks(
      createEnv(database, [blog]),
      upProbe,
      new Date(base + 6 * 60_000).toISOString(),
      upProbe,
      silentLogger
    )
    expect(
      raw.prepare('SELECT id, is_active FROM services ORDER BY id').all() as unknown as Array<{
        id: string
        is_active: number
      }>
    ).toEqual([
      { id: 'api', is_active: 0 },
      { id: 'blog', is_active: 1 },
    ])

    await runScheduledChecks(
      createEnv(database, [api]),
      upProbe,
      new Date(base + 12 * 60_000).toISOString(),
      upProbe,
      silentLogger
    )
    expect(
      raw.prepare('SELECT id, is_active FROM services ORDER BY id').all() as unknown as Array<{
        id: string
        is_active: number
      }>
    ).toEqual([
      { id: 'api', is_active: 1 },
      { id: 'blog', is_active: 0 },
    ])
  })
})
