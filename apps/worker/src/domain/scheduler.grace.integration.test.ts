import { describe, expect, it, vi } from 'vitest'
import type { ObservabilityLogger } from '../observability'

import { runScheduledChecks } from './scheduler'
import { createMigrationBackedD1Database } from '../testing/sqlite-d1'

const silentLogger = { info() {}, warn() {}, error() {} } as unknown as ObservabilityLogger

const failingProbe = async () => new Response('down', { status: 503 })
const healthyProbe = async () => new Response('ok')

function createEnv(database: D1Database) {
  return {
    PULSEFLARE_D1: database,
    STATUS_CONFIG: {
      site: { name: 'Pulseflare' },
      services: [
        {
          id: 'api',
          name: 'API',
          failureThreshold: 1,
          recoveryThreshold: 1,
          checks: [{ type: 'http', url: 'https://check.example.com/health' }],
        },
      ],
      notifications: {
        gracePeriodMinutes: 5,
        providers: [{ id: 'ops', type: 'webhook', url: 'https://hooks.example.com/pulseflare' }],
      },
      maintenances: [],
    },
  } as never
}

type OutboxRow = {
  event: 'incident_opened' | 'incident_resolved'
  status: string
  attempts: number
  next_attempt_at: string
  created_at: string
  last_error: string | null
}

function listOutbox(raw: import('node:sqlite').DatabaseSync): OutboxRow[] {
  return raw
    .prepare(
      'SELECT event, status, attempts, next_attempt_at, created_at, last_error FROM notification_outbox ORDER BY created_at, event'
    )
    .all() as unknown as OutboxRow[]
}

describe('scheduler notification timing (real migrations)', () => {
  // The scheduler lease uses wall-clock time, so the runs must be timed relative
  // to "now" while keeping grace-period deltas strictly controlled.
  const base = Date.now()

  it('opens the incident after the grace period and delivers the open webhook on the same run', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const notifyFetcher = vi.fn(async () => new Response(null, { status: 202 }))
    const env = createEnv(database)

    const firstFailure = new Date(base).toISOString()
    const graceSatisfied = new Date(base + 6 * 60_000).toISOString()

    await runScheduledChecks(env, failingProbe, firstFailure, notifyFetcher, silentLogger)

    expect(notifyFetcher).not.toHaveBeenCalled()
    expect(listOutbox(raw)).toEqual([])

    await runScheduledChecks(env, failingProbe, graceSatisfied, notifyFetcher, silentLogger)

    const incident = raw
      .prepare("SELECT opened_at FROM incidents WHERE status = 'open' LIMIT 1")
      .get() as { opened_at: string }

    expect(incident.opened_at).toBe(graceSatisfied)
    expect(listOutbox(raw)).toEqual([
      {
        event: 'incident_opened',
        status: 'delivered',
        attempts: 1,
        next_attempt_at: graceSatisfied,
        created_at: graceSatisfied,
        last_error: null,
      },
    ])
    expect(notifyFetcher).toHaveBeenCalledTimes(1)

    const [, init] = notifyFetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: 'incident_opened',
      serviceId: 'api',
      serviceName: 'API',
      status: 'open',
    })
  })

  it('cancels a still-undelivered open notification when the incident resolves during the retry window', async () => {
    const { database, raw } = createMigrationBackedD1Database()
    const failingNotify = vi.fn(async () => new Response(null, { status: 500 }))
    const okNotify = vi.fn(async () => new Response(null, { status: 202 }))
    const env = createEnv(database)

    const firstFailure = new Date(base).toISOString()
    const graceSatisfied = new Date(base + 6 * 60_000).toISOString()
    const recovery = new Date(base + 6.5 * 60_000).toISOString()

    await runScheduledChecks(env, failingProbe, firstFailure, failingNotify, silentLogger)
    await runScheduledChecks(env, failingProbe, graceSatisfied, failingNotify, silentLogger)
    await runScheduledChecks(env, healthyProbe, recovery, okNotify, silentLogger)

    expect(listOutbox(raw)).toEqual([
      {
        event: 'incident_opened',
        status: 'failed',
        attempts: 1,
        next_attempt_at: new Date(base + 7 * 60_000).toISOString(),
        created_at: graceSatisfied,
        last_error: 'Incident resolved during notification grace period',
      },
      {
        event: 'incident_resolved',
        status: 'delivered',
        attempts: 1,
        next_attempt_at: recovery,
        created_at: recovery,
        last_error: null,
      },
    ])

    const resolvedPayload = JSON.parse(
      ((((okNotify.mock.calls as unknown as Array<[string, RequestInit]>)[0] ?? [])[1])?.body as string) ?? '{}'
    ) as { event: string }

    expect(resolvedPayload.event).toBe('incident_resolved')
  })
})
