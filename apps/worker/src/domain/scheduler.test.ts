import { describe, expect, it, vi } from 'vitest'

import { runScheduledChecks } from './scheduler'
import * as checkRunnerModule from './check-runner'

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
}) {
  const state = {
    services: initial?.services ?? [],
    statuses: initial?.statuses ?? [],
    incidents: initial?.incidents ?? [],
    latencyWrites: [] as Array<{ serviceId: string; latencyMs: number; recordedAt: string }>,
  }

  const database = {
    async exec() {
      return undefined
    },
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
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
                const [serviceId, status, latestReason, checkedAt] = args as [
                  string,
                  'up' | 'down',
                  string | null,
                  string,
                ]
                const row = state.statuses.find((entry) => entry.service_id === serviceId)
                if (row) {
                  row.current_status = status
                  row.latest_reason = latestReason
                  row.checked_at = checkedAt
                } else {
                  state.statuses.push({
                    service_id: serviceId,
                    current_status: status,
                    latest_reason: latestReason,
                    checked_at: checkedAt,
                  })
                }
                return
              }

              if (query.includes('INSERT INTO latency_points')) {
                const [_id, serviceId, recordedAt, latencyMs] = args as [string, string, string, number]
                state.latencyWrites.push({ serviceId, recordedAt, latencyMs })
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

              return null
            },
          }
        },
      }
    },
  } as unknown as D1Database

  return { database, state }
}

describe('runScheduledChecks', () => {
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
      },
    ])
    expect(state.latencyWrites).toHaveLength(1)
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
      expect.any(Function)
    )
    expect(state.statuses[0]).toMatchObject({
      service_id: 'redis',
      current_status: 'up',
    })
  })
})
