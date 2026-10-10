import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

import worker from '../index'
import { BOOTSTRAP_SCHEMA_SQL } from '../install'
import { runScheduledChecks } from './scheduler'
import * as checkRunnerModule from './check-runner'
import type { ObservabilityLogger } from '../observability'

type ServiceRow = {
  id: string
  name: string
  service_group: string | null
  sort_order: number
  is_active?: number
}

type StatusRow = {
  service_id: string
  current_status: 'up' | 'down'
  latest_reason: string | null
  checked_at: string
  failing_since?: string | null
  failure_count: number
  recovery_count: number
}

type IncidentRow = {
  id: string
  service_id: string
  status: 'open' | 'resolved'
  impact: 'minor' | 'major'
  latest_reason: string | null
  opened_at: string
  resolved_at: string | null
}

function createFakeDatabase(initial?: {
  services?: ServiceRow[]
  statuses?: StatusRow[]
  incidents?: IncidentRow[]
  forceIncidentConflict?: boolean
}) {
  const state = {
    services: initial?.services ?? [],
    statuses: initial?.statuses ?? [],
    incidents: initial?.incidents ?? [],
    notifications: [] as Array<Record<string, unknown>>,
    checkResults: [] as Array<Record<string, unknown>>,
    latencyWrites: [] as Array<{ serviceId: string; latencyMs: number; recordedAt: string; locationLabel: string }>,
    dailyRollups: [] as Array<{
      serviceId: string
      day: string
      locationLabel: string
      upCount: number
      downCount: number
      latencyMs: number | null
      latencyAt: string | null
    }>,
    lastPrunedAt: null as string | null,
    pruneRuns: 0,
    execCalls: 0,
    batchCalls: [] as number[],
    forceIncidentConflict: initial?.forceIncidentConflict ?? false,
  }

  const database = {
    async exec() {
      state.execCalls += 1
      return undefined
    },
    prepare(query: string) {
      return {
        async all() {
          if (query.includes('FROM services') && query.includes('WHERE is_active = 1')) {
            return {
              results: state.services
                .filter((service) => service.is_active !== 0)
                .map(({ id, name, service_group, sort_order }) => ({ id, name, service_group, sort_order })),
            }
          }

          return { results: [] }
        },
        async first() {
          if (query.includes('FROM scheduler_lease') && query.includes('last_pruned_at')) {
            return { last_pruned_at: state.lastPrunedAt }
          }

          return null
        },
        bind(...args: unknown[]) {
          return {
            async all() {
              if (query.includes('FROM notification_outbox')) {
                return { results: state.notifications }
              }

              if (query.includes('FROM services') && query.includes('WHERE is_active = 1')) {
                return {
                  results: state.services
                    .filter((service) => service.is_active !== 0)
                    .map(({ id, name, service_group, sort_order }) => ({ id, name, service_group, sort_order })),
                }
              }

              return { results: [] }
            },
            async run() {
              if (query.includes('INSERT INTO notification_outbox')) {
                const [id, providerId, event, incidentId, serviceId, payloadJson] = args as [
                  string,
                  string,
                  string,
                  string,
                  string,
                  string,
                ]
                if (!state.notifications.some((row) => row.incident_id === incidentId && row.provider_id === providerId && row.event === event)) {
                  state.notifications.push({
                    id,
                    provider_id: providerId,
                    event,
                    incident_id: incidentId,
                    service_id: serviceId,
                    payload_json: payloadJson,
                    attempts: 0,
                  })
                }
                return
              }

              if (query.includes('SET claimed_by = ?, claimed_until = ?')) {
                return { meta: { changes: 1 } }
              }

              if (query.includes('UPDATE services SET is_active = 0')) {
                for (const service of state.services) {
                  service.is_active = 0
                }
                return
              }

              if (query.includes('INSERT INTO services') && query.includes('ON CONFLICT(id) DO UPDATE')) {
                const [id, name, group, sortOrder] = args as [string, string, string | null, number]
                const existing = state.services.find((service) => service.id === id)
                if (existing) {
                  existing.name = name
                  existing.service_group = group
                  existing.sort_order = sortOrder
                  existing.is_active = 1
                } else {
                  state.services.push({
                    id,
                    name,
                    service_group: group,
                    sort_order: sortOrder,
                    is_active: 1,
                  })
                }
                return
              }

              if (query.includes('INSERT INTO service_status') && query.includes('ON CONFLICT(service_id)')) {
                const [serviceId, status, latestReason, checkedAt, failingSince, failureCount, recoveryCount] = args as [
                  string,
                  'up' | 'down',
                  string | null,
                  string,
                  string | null,
                  number,
                  number,
                ]
                const row = state.statuses.find((entry) => entry.service_id === serviceId)
                if (row) {
                  row.current_status = status
                  row.latest_reason = latestReason
                  row.checked_at = checkedAt
                  row.failing_since = failingSince
                  row.failure_count = failureCount
                  row.recovery_count = recoveryCount
                } else {
                  state.statuses.push({
                    service_id: serviceId,
                    current_status: status,
                    latest_reason: latestReason,
                    checked_at: checkedAt,
                    failing_since: failingSince,
                    failure_count: failureCount,
                    recovery_count: recoveryCount,
                  })
                }
                return
              }

              if (query.includes('INSERT INTO check_results')) {
                const [_id, serviceId, recordedAt, status, reason, latencyMs, locationLabel] = args as [
                  string,
                  string,
                  string,
                  'up' | 'down',
                  string,
                  number | null,
                  string,
                ]
                state.checkResults.push({ serviceId, recordedAt, status, reason, latencyMs, locationLabel })
                return
              }

              if (query.includes('INSERT INTO daily_check_rollups')) {
                const [serviceId, day, locationLabel, upCount, downCount, latencyMs, latencyAt] = args as [
                  string,
                  string,
                  string,
                  number,
                  number,
                  number | null,
                  string | null,
                ]
                const existing = state.dailyRollups.find(
                  (row) => row.serviceId === serviceId && row.day === day && row.locationLabel === locationLabel
                )
                if (existing) {
                  existing.upCount += upCount
                  existing.downCount += downCount
                  if (latencyMs !== null && (!existing.latencyAt || latencyAt! >= existing.latencyAt)) {
                    existing.latencyMs = latencyMs
                    existing.latencyAt = latencyAt
                  }
                } else {
                  state.dailyRollups.push({ serviceId, day, locationLabel, upCount, downCount, latencyMs, latencyAt })
                }
                return
              }

              if (query.includes('INSERT INTO latency_points')) {
                const [_id, serviceId, recordedAt, latencyMs, locationLabel] = args as [
                  string,
                  string,
                  string,
                  number,
                  string,
                ]
                state.latencyWrites.push({ serviceId, recordedAt, latencyMs, locationLabel })
                return
              }

              if (query.includes('INSERT INTO incidents')) {
                const [id, serviceId, status, impact, latestReason, openedAt] = query.includes('impact')
                  ? (args as [string, string, 'open', 'minor' | 'major', string | null, string])
                  : ([...args.slice(0, 3), 'minor', ...args.slice(3)] as [
                      string,
                      string,
                      'open',
                      'minor' | 'major',
                      string | null,
                      string,
                    ])
                if (state.forceIncidentConflict) {
                  state.forceIncidentConflict = false
                  state.incidents.push({
                    id: 'existing-incident',
                    service_id: serviceId,
                    status: 'open',
                    impact: 'minor',
                    latest_reason: 'Internal failure detail',
                    opened_at: openedAt,
                    resolved_at: null,
                  })

                  if (!query.includes('ON CONFLICT DO NOTHING')) {
                    throw new Error('Expected conflict-safe incident insert')
                  }

                  return
                }

                if (state.incidents.some((entry) => entry.service_id === serviceId && entry.status === 'open')) {
                  return
                }

                state.incidents.push({
                  id,
                  service_id: serviceId,
                  status,
                  impact,
                  latest_reason: latestReason,
                  opened_at: openedAt,
                  resolved_at: null,
                })
                return
              }

              if (query.includes('UPDATE incidents')) {
                const [latestReason, resolvedAt, serviceId] = args as [string | null, string, string]
                const incident = state.incidents.find(
                  (entry) => entry.service_id === serviceId && entry.status === 'open'
                )
                if (incident) {
                  incident.status = 'resolved'
                  incident.latest_reason = latestReason
                  incident.resolved_at = resolvedAt
                }
              }

              if (query.includes('UPDATE scheduler_lease') && query.includes('last_pruned_at')) {
                state.lastPrunedAt = args[0] as string
                state.pruneRuns += 1
                return
              }

              if (query.includes('DELETE FROM')) {
                state.pruneRuns += 0
                return
              }
            },
            async first() {
              if (query.includes('FROM scheduler_lease') && query.includes('last_pruned_at')) {
                return { last_pruned_at: state.lastPrunedAt }
              }

              if (query.includes('SELECT COUNT(*) AS service_count FROM services')) {
                return { service_count: state.services.filter((service) => service.is_active !== 0).length }
              }

              if (query.includes('FROM incidents') && query.includes("status = 'open'")) {
                const [serviceId] = args as [string]
                const incident = state.incidents.find(
                  (entry) => entry.service_id === serviceId && entry.status === 'open'
                )

                return incident
                  ? { id: incident.id, status: incident.status, latest_reason: incident.latest_reason }
                  : null
              }

              if (query.includes('FROM service_status')) {
                const [serviceId] = args as [string]
                const row = state.statuses.find((entry) => entry.service_id === serviceId)

                return row
                  ? {
                      current_status: row.current_status,
                      checked_at: row.checked_at,
                      failing_since: row.failing_since ?? null,
                      failure_count: row.failure_count,
                      recovery_count: row.recovery_count,
                    }
                  : null
              }

              return null
            },
          }
        },
      }
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      state.batchCalls.push(statements.length)

      for (const statement of statements) {
        await statement.run()
      }

      return []
    },
  } as unknown as D1Database

  return { database, state }
}

function createTestLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies ObservabilityLogger
}

function createSqliteDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(BOOTSTRAP_SCHEMA_SQL)
  const database = {
    async exec(query: string) {
      sqlite.exec(query)
    },
    prepare(query: string) {
      let parameters: Array<string | number | null> = []
      const statement = {
        bind(...args: unknown[]) {
          parameters = args as Array<string | number | null>
          return statement
        },
        async first<T>() {
          return (sqlite.prepare(query).get(...parameters) as T | undefined) ?? null
        },
        async all<T>() {
          return { results: sqlite.prepare(query).all(...parameters) as unknown as T[] }
        },
        async run() {
          const result = sqlite.prepare(query).run(...parameters)
          return { meta: { changes: Number(result.changes) } }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      sqlite.exec('BEGIN')
      try {
        for (const statement of statements) {
          await statement.run()
        }
        sqlite.exec('COMMIT')
        return []
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database

  return { database, close: () => sqlite.close() }
}

describe('runScheduledChecks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('runs configured HTTP checks and persists service status plus a daily latency rollup', async () => {
    const { database, state } = createFakeDatabase()
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }))

    const result = await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
            failureThreshold: 1,
            recoveryThreshold: 1,
              checks: [{ type: 'http', url: 'https://api.example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      fetcher,
      '2026-04-25T08:00:00.000Z'
    )

    expect(result).toMatchObject({
      servicesChecked: 1,
      upCount: 1,
      downCount: 0,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(state.execCalls).toBe(0)
    expect(state.statuses).toEqual([
      {
        service_id: 'api',
        current_status: 'up',
        latest_reason: 'GET https://api.example.com/health -> 200',
        checked_at: '2026-04-25T08:00:00.000Z',
        failing_since: null,
        failure_count: 0,
        recovery_count: 1,
      },
    ])
    expect(state.dailyRollups).toEqual([
      expect.objectContaining({
        serviceId: 'api',
        day: '2026-04-25',
        locationLabel: 'default',
        upCount: 1,
        downCount: 0,
      }),
    ])
    expect(state.batchCalls).toEqual([2, 2, 6])
  })

  it('persists a scheduler run to SQLite and serves it through the public snapshot', async () => {
    const { database, close } = createSqliteDatabase()
    const checkedAt = new Date().toISOString()
    const env = {
      PULSEFLARE_D1: database,
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [
          {
            id: 'api',
            name: 'API',
            impact: 'major',
            failureThreshold: 1,
            recoveryThreshold: 1,
            checks: [{ type: 'http' as const, url: 'https://api.example.com/health' }],
          },
        ],
        notifications: { providers: [] },
        maintenances: [],
        staleAfterMinutes: 5,
      },
    }
    const fetcher = async () => new Response('unavailable', { status: 503 })

    try {
      await runScheduledChecks(env, fetcher, checkedAt, fetcher, createTestLogger())

      const response = await worker.fetch(
        new Request('https://example.com/api/public/snapshot'),
        env as never,
        {} as ExecutionContext
      )
      const payload = (await response.json()) as {
        services: Array<{
          id: string
          status: string
          uptimePercentage: number
          history: string[]
          locations: Array<{ label: string; uptimePercentage: number }>
        }>
        incidents: Array<{ status: string; impact: string; summary: string }>
      }

      expect(response.status).toBe(200)
      expect(payload.services[0]).toMatchObject({
        id: 'api',
        status: 'outage',
        uptimePercentage: 0,
        history: expect.arrayContaining(['down']),
        locations: [expect.objectContaining({ label: 'Local', uptimePercentage: 0 })],
      })
      expect(payload.incidents).toEqual([
        expect.objectContaining({
          status: 'open',
          impact: 'major',
          summary: 'API is experiencing an issue.',
        }),
      ])
    } finally {
      close()
    }
  })

  it('opens and then resolves incidents as service state changes', async () => {
    const { database, state } = createFakeDatabase()

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failureThreshold: 1,
              recoveryThreshold: 1,
              checks: [{ type: 'http', url: 'https://api.example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('down', { status: 503 }),
      '2026-04-25T08:00:00.000Z'
    )

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({
      service_id: 'api',
      status: 'open',
    })

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failureThreshold: 1,
              recoveryThreshold: 1,
              checks: [{ type: 'http', url: 'https://api.example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('ok', { status: 200 }),
      '2026-04-25T08:05:00.000Z'
    )

    expect(state.incidents[0]).toMatchObject({
      service_id: 'api',
      status: 'resolved',
      resolved_at: '2026-04-25T08:05:00.000Z',
    })
  })

  it('reuses the incident created by a concurrent open operation', async () => {
    const { database, state } = createFakeDatabase({ forceIncidentConflict: true })

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failureThreshold: 1,
              recoveryThreshold: 1,
              checks: [{ type: 'http', url: 'https://api.example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('down', { status: 503 }),
      '2026-04-25T08:02:00.000Z'
    )

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]?.id).toBe('existing-incident')
  })

  it('waits for consecutive failures and recoveries before changing incident state', async () => {
    const { database, state } = createFakeDatabase()
    const statusConfig = {
      site: { name: 'Pulseflare' },
      services: [
        {
          id: 'api',
          name: 'API',
          failureThreshold: 2,
          recoveryThreshold: 2,
          checks: [{ type: 'http' as const, url: 'https://api.example.com/health' }],
        },
      ],
      notifications: { providers: [] },
      maintenances: [],
    }

    const run = (response: Response, checkedAt: string) =>
      runScheduledChecks({ PULSEFLARE_D1: database, STATUS_CONFIG: statusConfig }, async () => response, checkedAt)

    await run(new Response('down', { status: 503 }), '2026-04-25T09:00:00.000Z')
    expect(state.incidents).toHaveLength(0)

    await run(new Response('down', { status: 503 }), '2026-04-25T09:01:00.000Z')
    expect(state.incidents).toHaveLength(1)

    await run(new Response('ok', { status: 200 }), '2026-04-25T09:02:00.000Z')
    expect(state.incidents[0]?.status).toBe('open')

    await run(new Response('ok', { status: 200 }), '2026-04-25T09:03:00.000Z')
    expect(state.incidents[0]?.status).toBe('resolved')
  })

  it('persists a configured TCP check through the scheduled runner', async () => {
    const { database, state } = createFakeDatabase()
    const runnerSpy = vi.spyOn(checkRunnerModule, 'runConfiguredCheck').mockResolvedValue({
      status: 'up',
      reason: 'TCP redis.example.com:6379 connected',
      latencyMs: 12,
    })

    const result = await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'redis',
              name: 'Redis',
              checks: [{ type: 'tcp', target: 'redis.example.com:6379' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('unused'),
      '2026-04-25T08:10:00.000Z'
    )

    expect(result).toMatchObject({
      servicesChecked: 1,
      upCount: 1,
      downCount: 0,
    })
    expect(runnerSpy).toHaveBeenCalledWith(
      { type: 'tcp', target: 'redis.example.com:6379' },
      expect.any(Function),
      undefined,
      undefined,
      undefined
    )
    expect(state.statuses[0]).toMatchObject({
      service_id: 'redis',
      current_status: 'up',
    })
  })

  it('waits for the grace period before opening an incident or sending notifications', async () => {
    const { database, state } = createFakeDatabase()
    const notifyFetcher = vi.fn(async () => new Response(null, { status: 202 }))

    const env = {
      PULSEFLARE_D1: database,
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [
          {
            id: 'api',
            name: 'API',
            failureThreshold: 1,
            recoveryThreshold: 1,
            checks: [{ type: 'http', url: 'https://api.example.com/health' }],
          },
        ],
        notifications: {
          gracePeriodMinutes: 5,
          providers: [{ id: 'ops', type: 'webhook', url: 'https://hooks.example.com/pulseflare' }],
        },
        maintenances: [],
      },
    }

    await runScheduledChecks(env, async () => new Response('down', { status: 503 }), '2026-04-25T08:00:00.000Z', notifyFetcher)

    expect(state.incidents).toHaveLength(0)
    expect(notifyFetcher).not.toHaveBeenCalled()

    await runScheduledChecks(env, async () => new Response('down', { status: 503 }), '2026-04-25T08:06:00.000Z', notifyFetcher)

    expect(state.incidents).toHaveLength(1)
    expect(state.incidents[0]).toMatchObject({
      service_id: 'api',
      status: 'open',
    })
    expect(notifyFetcher).toHaveBeenCalledTimes(1)
  })

  it('suppresses notifications while the affected service is under active maintenance', async () => {
    const { database, state } = createFakeDatabase()
    const notifyFetcher = vi.fn(async () => new Response(null, { status: 202 }))

    const env = {
      PULSEFLARE_D1: database,
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [
          {
            id: 'api',
            name: 'API',
            failureThreshold: 1,
            recoveryThreshold: 1,
            checks: [{ type: 'http', url: 'https://api.example.com/health' }],
          },
        ],
        notifications: {
          providers: [{ id: 'ops', type: 'webhook', url: 'https://hooks.example.com/pulseflare' }],
        },
        maintenances: [
          {
            id: 'active-maintenance',
            title: 'API maintenance',
            body: 'Working on the API.',
            start: '2026-04-25T07:30:00.000Z',
            end: '2026-04-25T09:00:00.000Z',
            services: ['api'],
          },
        ],
      },
    }

    await runScheduledChecks(env, async () => new Response('down', { status: 503 }), '2026-04-25T08:06:00.000Z', notifyFetcher)

    expect(state.incidents).toHaveLength(1)
    expect(notifyFetcher).not.toHaveBeenCalled()
  })

  it('keeps failed probe details and derives service state from all locations by default', async () => {
    const { database, state } = createFakeDatabase()
    vi.spyOn(checkRunnerModule, 'runConfiguredCheck')
      .mockResolvedValueOnce({ status: 'up', reason: 'IAD passed', latencyMs: 18, locationLabel: 'region:iad' })
      .mockResolvedValueOnce({ status: 'down', reason: 'FRA failed', latencyMs: 41, locationLabel: 'region:fra' })

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failureThreshold: 1,
              recoveryThreshold: 1,
              checks: [
                { type: 'http', url: 'https://api.example.com/health', probe: { kind: 'region', target: 'iad' } },
                { type: 'http', url: 'https://api.example.com/health', probe: { kind: 'region', target: 'fra' } },
              ],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('unused'),
      '2026-04-25T08:30:00.000Z'
    )

    expect(state.checkResults).toEqual([expect.objectContaining({ status: 'down', locationLabel: 'region:fra' })])
    expect(state.latencyWrites).toHaveLength(0)
    expect(state.dailyRollups).toHaveLength(2)
    expect(state.statuses[0]?.current_status).toBe('down')
  })

  it('aggregates check counts and latency once per location per scheduler run', async () => {
    const { database, state } = createFakeDatabase()
    vi.spyOn(checkRunnerModule, 'runConfiguredCheck')
      .mockResolvedValueOnce({ status: 'up', reason: 'IAD HTTP passed', latencyMs: 18, locationLabel: 'region:iad' })
      .mockResolvedValueOnce({ status: 'up', reason: 'IAD TCP passed', latencyMs: 22, locationLabel: 'region:iad' })
      .mockResolvedValueOnce({ status: 'down', reason: 'FRA failed', latencyMs: 41, locationLabel: 'region:fra' })

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              checks: [
                { type: 'http', url: 'https://api.example.com', probe: { kind: 'region', target: 'iad' } },
                { type: 'tcp', target: 'api.example.com:443', probe: { kind: 'region', target: 'iad' } },
                { type: 'http', url: 'https://api.example.com', probe: { kind: 'region', target: 'fra' } },
              ],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('unused'),
      '2026-04-25T08:30:00.000Z'
    )

    expect(state.dailyRollups).toEqual([
      expect.objectContaining({
        serviceId: 'api',
        day: '2026-04-25',
        locationLabel: 'region:iad',
        upCount: 2,
        downCount: 0,
        latencyMs: 20,
      }),
      expect.objectContaining({
        serviceId: 'api',
        day: '2026-04-25',
        locationLabel: 'region:fra',
        upCount: 0,
        downCount: 1,
        latencyMs: 41,
      }),
    ])
  })

  it('uses a strict majority of healthy locations when configured', async () => {
    const { database, state } = createFakeDatabase()
    vi.spyOn(checkRunnerModule, 'runConfiguredCheck')
      .mockResolvedValueOnce({ status: 'up', reason: 'IAD passed', latencyMs: 20, locationLabel: 'region:iad' })
      .mockResolvedValueOnce({ status: 'down', reason: 'FRA failed', latencyMs: 40, locationLabel: 'region:fra' })
      .mockResolvedValueOnce({ status: 'up', reason: 'LHR passed', latencyMs: 30, locationLabel: 'region:lhr' })

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failurePolicy: 'majority',
              checks: [
                { type: 'http', url: 'https://api.example.com', probe: { kind: 'region', target: 'iad' } },
                { type: 'http', url: 'https://api.example.com', probe: { kind: 'region', target: 'fra' } },
                { type: 'http', url: 'https://api.example.com', probe: { kind: 'region', target: 'lhr' } },
              ],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('unused'),
      '2026-04-25T08:30:00.000Z'
    )

    expect(state.statuses[0]?.current_status).toBe('up')
    expect(state.incidents).toHaveLength(0)
  })

  it('stores configured impact on the incident and prunes retained data once per day', async () => {
    const { database, state } = createFakeDatabase()
    const env = {
      PULSEFLARE_D1: database,
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [
          {
            id: 'api',
            name: 'API',
            impact: 'major',
            failureThreshold: 1,
            recoveryThreshold: 1,
            checks: [{ type: 'http', url: 'https://api.example.com' }],
          },
        ],
        notifications: { providers: [] },
        maintenances: [],
      },
    }
    const fetcher = async () => new Response('down', { status: 503 })

    await runScheduledChecks(env, fetcher, '2026-04-25T08:30:00.000Z')
    await runScheduledChecks(env, fetcher, '2026-04-25T08:31:00.000Z')

    expect(state.incidents[0]?.impact).toBe('major')
    expect(state.pruneRuns).toBe(1)
  })

  it('emits structured probe, incident, and scheduler lifecycle events', async () => {
    const { database } = createFakeDatabase()
    const logger = createTestLogger()

    await runScheduledChecks(
      {
        PULSEFLARE_D1: database,
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'API',
              failureThreshold: 1,
              recoveryThreshold: 1,
              checks: [{ type: 'http', url: 'https://api.example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      },
      async () => new Response('down', { status: 503 }),
      '2026-04-25T08:20:00.000Z',
      undefined,
      logger
    )

    const events = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].map(
      ([message]) => JSON.parse(message as string)
    )

    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['scheduler.run.started', 'probe.failed', 'incident.opened', 'scheduler.run.completed'])
    )
    expect(events.find((event) => event.event === 'probe.failed')).toMatchObject({
      serviceId: 'api',
      status: 'down',
    })
  })
})
