import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runScheduledChecks } from './scheduler'
import * as checkRunnerModule from './check-runner'
import type { ObservabilityLogger } from '../observability'

type ServiceRow = {
  id: string
  name: string
  service_group: string | null
  sort_order: number
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
    batchCalls: [] as number[],
    forceIncidentConflict: initial?.forceIncidentConflict ?? false,
  }

  const database = {
    async exec() {
      return undefined
    },
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              return { results: query.includes('FROM notification_outbox') ? state.notifications : [] }
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
                return
              }

              if (query.includes('INSERT INTO services') && query.includes('ON CONFLICT(id) DO UPDATE')) {
                const [id, name, group, sortOrder] = args as [string, string, string | null, number]
                const existing = state.services.find((service) => service.id === id)
                if (existing) {
                  existing.name = name
                  existing.service_group = group
                  existing.sort_order = sortOrder
                } else {
                  state.services.push({
                    id,
                    name,
                    service_group: group,
                    sort_order: sortOrder,
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
                const [id, serviceId, status, latestReason, openedAt] = args as [
                  string,
                  string,
                  'open',
                  string | null,
                  string,
                ]
                if (state.forceIncidentConflict) {
                  state.forceIncidentConflict = false
                  state.incidents.push({
                    id: 'existing-incident',
                    service_id: serviceId,
                    status: 'open',
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

              if (query.includes('DELETE FROM check_results') || query.includes('DELETE FROM latency_points')) {
                return
              }
            },
            async first() {
              if (query.includes('SELECT COUNT(*) AS service_count FROM services')) {
                return { service_count: state.services.length }
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

describe('runScheduledChecks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('runs configured HTTP checks and persists service status plus latency', async () => {
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
    expect(state.latencyWrites).toHaveLength(1)
    expect(state.batchCalls).toEqual([2, 3])
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

  it('persists each configured probe result with its location label', async () => {
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

    expect(state.checkResults).toEqual([
      expect.objectContaining({ status: 'up', locationLabel: 'region:iad' }),
      expect.objectContaining({ status: 'down', locationLabel: 'region:fra' }),
    ])
    expect(state.latencyWrites).toHaveLength(2)
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
