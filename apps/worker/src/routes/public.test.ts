import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import defaultStatusConfig from '../../../../config/pulse.config.ts'
import worker from '../index'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('/api/public/summary', () => {
  it('summarizes configured services with D1 status when available', async () => {
    vi.setSystemTime(new Date('2026-04-18T17:02:00.000Z'))

    const database = {
      prepare() {
        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: 'Core',
                  current_status: 'up',
                  checked_at: '2026-04-18T17:00:00.000Z',
                },
                {
                  id: 'blog',
                  name: 'Blog',
                  service_group: null,
                  current_status: 'down',
                  checked_at: '2026-04-18T17:01:00.000Z',
                },
              ],
            }
          },
        }
      },
    }
    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            { id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] },
            { id: 'blog', name: 'Blog', checks: [{ type: 'http', url: 'https://example.com' }] },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
        PULSEFLARE_D1: database,
      } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      status: string
      upCount: number
      downCount: number
      totalCount: number
      checkedAt: string
    }

    expect(response.status).toBe(200)
    expect(payload.status).toBe('degraded')
    expect(payload.upCount).toBe(1)
    expect(payload.downCount).toBe(1)
    expect(payload.totalCount).toBe(2)
    expect(payload.checkedAt).toBe('2026-04-18T17:01:00.000Z')
  })
})

describe('/api/public/snapshot', () => {
  it('returns one canonical payload with persisted history and incidents', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:05:00.000Z'))

    const database = {
      prepare(query: string) {
        if (query.includes('FROM snapshot_state')) {
          return {
            async first() {
              return null
            },
          }
        }

        if (query.includes('FROM daily_check_rollups')) {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        service_id: 'api',
                        day: '2026-04-25',
                        up_count: 1,
                        down_count: 1,
                        location_label: 'region:iad',
                        last_latency_ms: 731,
                      },
                    ],
                  }
                },
              }
            },
          }
        }

        if (query.includes('FROM incidents')) {
          return {
            async all() {
              return {
                results: [
                  {
                    id: 'incident-1',
                    service_id: 'api',
                    service_name: 'API',
                    status: 'open',
                    impact: 'minor',
                    latest_reason: 'API failed',
                    opened_at: '2026-04-25T08:00:00.000Z',
                    resolved_at: null,
                  },
                ],
              }
            },
          }
        }

        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: 'Core',
                  current_status: 'down',
                  checked_at: '2026-04-25T08:01:00.000Z',
                },
              ],
            }
          },
        }
      },
    }

    const response = await worker.fetch(
      new Request('https://example.com/api/public/snapshot'),
      {
        STATUS_CONFIG: {
          site: { name: 'Acme Status', description: 'System health' },
          services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
          notifications: { providers: [] },
          maintenances: [],
        },
        PULSEFLARE_D1: database,
      } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      product: { name: string }
      summary: { status: string; checkedAt: string }
      services: Array<{ uptimePercentage: number | null; history: string[] }>
      incidents: Array<{ id: string; title: string; summary: string; status: string; impact: string }>
    }

    expect(response.status).toBe(200)
    expect(payload.product.name).toBe('Acme Status')
    expect(payload.summary).toMatchObject({
      status: 'degraded',
      checkedAt: '2026-04-25T08:01:00.000Z',
    })
    expect(payload.services[0]).toMatchObject({
      uptimePercentage: 50,
      history: expect.arrayContaining(['degraded']),
        latencyMs: 731,
        locations: [{ label: 'iad', uptimePercentage: 50, latencyMs: 731 }],
    })
    expect(payload.incidents).toEqual([
      expect.objectContaining({
        id: 'incident-1',
        title: 'API incident',
        summary: 'API is experiencing an issue.',
        status: 'open',
        impact: 'minor',
      }),
    ])
    expect(JSON.stringify(payload)).not.toContain('API failed')
  })
})

describe('/api/public/services', () => {
  const statusConfig = {
    site: { name: 'Pulseflare' },
    services: [
      {
        id: 'api',
        name: 'API',
        group: 'Core',
        checks: [{ type: 'http', url: 'https://api.example.com/health' }],
      },
      {
        id: 'blog',
        name: 'Blog',
        checks: [{ type: 'http', url: 'https://example.com/blog' }],
      },
    ],
    notifications: { providers: [] },
    maintenances: [],
  }

  function createSnapshotDatabase(
    snapshot: { updated_at: string; payload_json: string } | null,
    statuses: Array<Record<string, unknown>>,
    rollups: Array<Record<string, unknown>> = []
  ) {
    const queries: string[] = []
    return {
      queries,
      prepare(query: string) {
        queries.push(query)
        if (query.includes('FROM snapshot_state')) {
          return { async first() { return snapshot } }
        }
        if (query.includes('FROM daily_check_rollups')) {
          return { bind() { return { async all() { return { results: rollups } } } } }
        }
        if (query.includes('FROM incidents')) {
          return { async all() { return { results: [] } } }
        }
        expect(query).toContain('LEFT JOIN service_status')
        return { async all() { return { results: statuses } } }
      },
    }
  }

  function publicRequest(route: 'services' | 'snapshot', database: unknown, config = statusConfig) {
    return worker.fetch(
      new Request(`https://example.com/api/public/${route}`),
      { STATUS_CONFIG: config, PULSEFLARE_D1: database } as never,
      {} as ExecutionContext
    )
  }

  it('returns configured services before the database has runtime state', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/services'),
      { STATUS_CONFIG: statusConfig } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      services: Array<{ id: string; name: string; status: string; history: string[] }>
    }

    expect(response.status).toBe(200)
    expect(payload.services).toHaveLength(2)
    expect(payload.services[0]).toMatchObject({
      id: 'api',
      name: 'API',
      group: 'Core',
      status: 'unknown',
    })
    expect(payload.services[0]).not.toHaveProperty('target')
    expect(payload.services[0]?.history).toHaveLength(90)
  })

  it('overlays D1 status rows onto configured services', async () => {
    vi.setSystemTime(new Date('2026-04-18T17:02:00.000Z'))

    const database = {
      prepare(query: string) {
        if (query.includes('FROM snapshot_state')) {
          return { async first() { return null } }
        }

        if (query.includes('FROM daily_check_rollups')) {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        service_id: 'api',
                        day: '2026-04-18',
                        up_count: 0,
                        down_count: 1,
                        location_label: 'default',
                        last_latency_ms: 731,
                      },
                    ],
                  }
                },
              }
            },
          }
        }

        expect(query).toContain('LEFT JOIN service_status')

        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: 'Core',
                  current_status: 'down',
                  checked_at: '2026-04-18T17:00:00.000Z',
                },
              ],
            }
          },
        }
      },
    }

    const response = await worker.fetch(
      new Request('https://example.com/api/public/services'),
      { STATUS_CONFIG: statusConfig, PULSEFLARE_D1: database } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      services: Array<{ id: string; status: string; uptimePercentage: number; latencyMs: number }>
    }

    expect(response.status).toBe(200)
    expect(payload.services.find((service) => service.id === 'api')).toMatchObject({
      group: 'Core',
      status: 'outage',
      uptimePercentage: 0,
      latencyMs: 731,
    })
    expect(payload.services.find((service) => service.id === 'blog')).toMatchObject({
      status: 'unknown',
      uptimePercentage: null,
    })
  })

  it('shares a fresh materialized snapshot with snapshot, applying current config and per-service freshness', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:06:00.000Z'))
    const config = {
      ...statusConfig,
      staleAfterMinutes: 5,
      services: [
        { ...statusConfig.services[0], name: 'API v2', group: 'Platform' },
        statusConfig.services[1],
      ],
    }
    const snapshot = {
      updated_at: '2026-04-25T08:05:00.000Z',
      payload_json: JSON.stringify([
        {
          id: 'api',
          name: 'Old API name',
          group: 'Old group',
          status: 'operational',
          uptimePercentage: 99,
          latencyMs: 42,
          history: ['up'],
          historyDays: ['2026-04-25'],
          locations: [],
        },
        {
          id: 'blog',
          name: 'Old Blog name',
          group: 'Old group',
          status: 'outage',
          uptimePercentage: 100,
          latencyMs: 12,
          history: ['up'],
          historyDays: ['2026-04-25'],
          locations: [],
        },
        { id: 'retired', name: 'Retired', status: 'outage' },
      ]),
    }
    const statuses = [
      { id: 'api', name: 'API', service_group: 'Core', current_status: 'down', checked_at: '2026-04-25T08:00:00.000Z' },
      { id: 'blog', name: 'Blog', service_group: null, current_status: 'up', checked_at: '2026-04-25T08:04:00.000Z' },
    ]
    const servicesDatabase = createSnapshotDatabase(snapshot, statuses)
    const snapshotDatabase = createSnapshotDatabase(snapshot, statuses)

    const servicesResponse = await publicRequest('services', servicesDatabase, config)
    const snapshotResponse = await publicRequest('snapshot', snapshotDatabase, config)
    const servicesPayload = await servicesResponse.json() as { services: Array<Record<string, unknown>> }
    const snapshotPayload = await snapshotResponse.json() as { services: Array<Record<string, unknown>> }

    expect(servicesResponse.status).toBe(200)
    expect(Object.keys(servicesPayload)).toEqual(['services'])
    expect(servicesPayload.services).toEqual(snapshotPayload.services)
    expect(servicesPayload.services).toHaveLength(2)
    expect(servicesPayload.services[0]).toMatchObject({
      id: 'api',
      name: 'API v2',
      group: 'Platform',
      status: 'unknown',
      uptimePercentage: 99,
      latencyMs: 42,
      notes: 'Status data is stale; last checked 2026-04-25T08:00:00.000Z',
    })
    expect(servicesPayload.services[1]).toMatchObject({
      id: 'blog',
      name: 'Blog',
      group: null,
      status: 'operational',
      uptimePercentage: 100,
    })
    expect(servicesDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(false)
    expect(snapshotDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(false)
  })

  it('falls back to live history when a fresh snapshot belongs to the previous UTC day', async () => {
    vi.setSystemTime(new Date('2026-04-26T00:01:00.000Z'))
    const snapshot = {
      updated_at: '2026-04-25T23:59:00.000Z',
      payload_json: JSON.stringify([
        {
          id: 'api',
          status: 'outage',
          uptimePercentage: 0,
          history: ['down'],
          historyDays: ['2026-04-25'],
          locations: [{ label: 'iad', uptimePercentage: 0, history: ['down'], latencyMs: 731 }],
        },
        { id: 'blog', status: 'operational', history: ['up'], historyDays: ['2026-04-25'], locations: [] },
      ]),
    }
    const statuses = [
      { id: 'api', name: 'API', service_group: 'Core', current_status: 'up', checked_at: '2026-04-26T00:00:00.000Z' },
      { id: 'blog', name: 'Blog', service_group: null, current_status: 'up', checked_at: '2026-04-26T00:00:00.000Z' },
    ]
    const rollups = [
      {
        service_id: 'api',
        day: '2026-04-26',
        up_count: 1,
        down_count: 0,
        location_label: 'iad',
        last_latency_ms: 42,
      },
    ]
    const servicesDatabase = createSnapshotDatabase(snapshot, statuses, rollups)
    const snapshotDatabase = createSnapshotDatabase(snapshot, statuses, rollups)

    const servicesResponse = await publicRequest('services', servicesDatabase)
    const snapshotResponse = await publicRequest('snapshot', snapshotDatabase)
    const servicesPayload = await servicesResponse.json() as { services: Array<Record<string, unknown>> }
    const snapshotPayload = await snapshotResponse.json() as { services: Array<Record<string, unknown>> }

    expect(servicesPayload.services).toEqual(snapshotPayload.services)
    expect(servicesPayload.services[0]).toMatchObject({
      id: 'api',
      uptimePercentage: 100,
      history: expect.arrayContaining(['up']),
      historyDays: expect.arrayContaining(['2026-04-26']),
      locations: [{ uptimePercentage: 100, history: ['up'], latencyMs: 42 }],
    })
    expect(servicesDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
    expect(snapshotDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
  })

  it('falls back to live history when a fresh snapshot omits a configured service ID', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:06:00.000Z'))
    const snapshot = {
      updated_at: '2026-04-25T08:05:00.000Z',
      payload_json: JSON.stringify([{ id: 'api', name: 'API', status: 'operational' }]),
    }
    const statuses = [
      { id: 'api', name: 'API', service_group: 'Core', current_status: 'down', checked_at: '2026-04-25T08:04:00.000Z' },
      { id: 'blog', name: 'Blog', service_group: null, current_status: 'up', checked_at: '2026-04-25T08:04:00.000Z' },
    ]
    const servicesDatabase = createSnapshotDatabase(snapshot, statuses)
    const snapshotDatabase = createSnapshotDatabase(snapshot, statuses)

    const servicesResponse = await publicRequest('services', servicesDatabase)
    const snapshotResponse = await publicRequest('snapshot', snapshotDatabase)
    const servicesPayload = await servicesResponse.json() as { services: Array<Record<string, unknown>> }
    const snapshotPayload = await snapshotResponse.json() as { services: Array<Record<string, unknown>> }

    expect(servicesPayload.services).toEqual(snapshotPayload.services)
    expect(servicesPayload.services).toHaveLength(2)
    expect(servicesPayload.services[0]).toMatchObject({ id: 'api', name: 'API', status: 'outage' })
    expect(servicesPayload.services[1]).toMatchObject({ id: 'blog', name: 'Blog', status: 'operational' })
    expect(servicesDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
    expect(snapshotDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
  })

  it.each([
    ['absent', null],
    ['stale', { updated_at: '2026-04-25T07:50:00.000Z', payload_json: JSON.stringify([{ id: 'api' }, { id: 'blog' }]) }],
  ] as const)('falls back to live history when the snapshot is %s', async (_state, snapshot) => {
    vi.setSystemTime(new Date('2026-04-25T08:06:00.000Z'))
    const statuses = [
      { id: 'api', name: 'API', service_group: 'Core', current_status: 'down', checked_at: '2026-04-25T08:04:00.000Z' },
      { id: 'blog', name: 'Blog', service_group: null, current_status: 'up', checked_at: '2026-04-25T08:04:00.000Z' },
    ]
    const servicesDatabase = createSnapshotDatabase(snapshot, statuses)
    const snapshotDatabase = createSnapshotDatabase(snapshot, statuses)

    const servicesResponse = await publicRequest('services', servicesDatabase)
    const snapshotResponse = await publicRequest('snapshot', snapshotDatabase)
    const servicesPayload = await servicesResponse.json() as { services: Array<Record<string, unknown>> }
    const snapshotPayload = await snapshotResponse.json() as { services: Array<Record<string, unknown>> }

    expect(servicesPayload.services).toEqual(snapshotPayload.services)
    expect(servicesPayload.services).toHaveLength(2)
    expect(servicesDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
    expect(snapshotDatabase.queries.some((query) => query.includes('FROM daily_check_rollups'))).toBe(true)
  })
})

describe('/api/public/incidents', () => {
  it('returns D1 incidents sorted newest first', async () => {
    const database = {
      prepare(query: string) {
        expect(query).toContain('FROM incidents')
        expect(query).toContain('ORDER BY opened_at DESC')

        return {
          async all() {
            return {
              results: [
                {
                  id: 'incident-1',
                  service_id: 'api',
                  service_name: 'API',
                  status: 'resolved',
                    impact: 'major',
                  latest_reason: 'Internal recovery detail',
                  opened_at: '2026-04-18T17:00:00.000Z',
                  resolved_at: '2026-04-18T17:08:00.000Z',
                },
              ],
            }
          },
        }
      },
    }

    const response = await worker.fetch(
      new Request('https://example.com/api/public/incidents'),
      { PULSEFLARE_D1: database } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      incidents: Array<{ id: string; title: string; status: string; impact: string; services: string[] }>
    }

    expect(response.status).toBe(200)
    expect(payload.incidents).toEqual([
      expect.objectContaining({
        id: 'incident-1',
        title: 'API recovered',
        summary: 'API has recovered.',
        status: 'resolved',
        impact: 'major',
        services: ['api'],
      }),
    ])
    expect(JSON.stringify(payload)).not.toContain('Internal recovery detail')
  })
})

describe('/api/public/maintenance', () => {
  it('returns future entries first and then recent completed entries from config', async () => {
    vi.setSystemTime(new Date('2026-04-30T12:00:00.000Z'))

    const response = await worker.fetch(
      new Request('https://example.com/api/public/maintenance'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            { id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] },
            { id: 'redis', name: 'Redis', checks: [{ type: 'tcp', target: 'redis.example.com:6379' }] },
          ],
          notifications: { providers: [] },
          maintenances: [
            {
              id: 'recent',
              title: 'Recent maintenance',
              body: 'Finished recently.',
              start: '2026-04-10T10:00:00.000Z',
              end: '2026-04-10T11:00:00.000Z',
              services: ['api'],
            },
            {
              id: 'upcoming',
              title: 'Upcoming maintenance',
              body: 'Scheduled soon.',
              start: '2026-05-01T10:00:00.000Z',
              end: '2026-05-01T11:00:00.000Z',
              services: ['redis'],
            },
            {
              id: 'active',
              title: 'Active maintenance',
              body: 'In progress.',
              start: '2026-04-29T10:00:00.000Z',
              end: '2026-04-30T23:00:00.000Z',
              services: ['api', 'redis'],
            },
            {
              id: 'stale',
              title: 'Old maintenance',
              body: 'Should be filtered out.',
              start: '2026-03-01T10:00:00.000Z',
              end: '2026-03-01T11:00:00.000Z',
              services: ['api'],
            },
          ],
        },
      } as never,
      {} as ExecutionContext
    )

    const payload = (await response.json()) as {
      maintenance: Array<{ id: string; status: string; services: string[] }>
    }

    expect(response.status).toBe(200)
    expect(payload.maintenance).toEqual([
      expect.objectContaining({
        id: 'active',
        status: 'in_progress',
        services: ['api', 'redis'],
      }),
      expect.objectContaining({
        id: 'upcoming',
        status: 'scheduled',
        services: ['redis'],
      }),
      expect.objectContaining({
        id: 'recent',
        status: 'completed',
        services: ['api'],
      }),
    ])
  })

  it('returns an empty list when there are no matching entries', async () => {
    vi.setSystemTime(new Date('2026-04-30T12:00:00.000Z'))

    const response = await worker.fetch(
      new Request('https://example.com/api/public/maintenance'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          notifications: { providers: [] },
          maintenances: [],
        },
      } as never,
      {} as ExecutionContext
    )

    await expect(response.json()).resolves.toEqual({ maintenance: [] })
  })
})

describe('/api/health', () => {
  function createDatabase(runs: Array<Record<string, unknown>>) {
    return {
      prepare(query: string) {
        expect(query).toContain('FROM scheduler_runs')
        return {
          async first() {
            const completed = query.includes("WHERE status IN ('succeeded', 'failed')")
              ? runs.filter((run) => run.status === 'succeeded' || run.status === 'failed')
              : runs
            const orderBy = query.includes('ORDER BY finished_at DESC') ? 'finished_at' : 'started_at'
            return (
              [...completed].sort((left, right) =>
                String(right[orderBy] ?? '').localeCompare(String(left[orderBy] ?? ''))
              )[0] ?? null
            )
          },
        }
      },
    }
  }

  function run(id: string, status: string, startedAt: string, finishedAt: string | null) {
    return {
      id,
      started_at: startedAt,
      finished_at: finishedAt,
      status,
      services_checked: 1,
      up_count: 1,
      down_count: 0,
      error_message: null,
    }
  }

  function requestHealth(runs: Array<Record<string, unknown>>) {
    return worker.fetch(
      new Request('https://example.com/api/health'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          staleAfterMinutes: 5,
          notifications: { providers: [] },
          maintenances: [],
        },
        PULSEFLARE_D1: createDatabase(runs),
      } as never,
      {} as ExecutionContext
    )
  }

  it('keeps a recent successful run healthy while a newer run is still running', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:03:00.000Z'))

    const response = await requestHealth([
      run('running-2', 'running', '2026-04-25T08:02:00.000Z', null),
      run('success-1', 'succeeded', '2026-04-25T08:00:00.000Z', '2026-04-25T08:01:00.000Z'),
    ])

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      lastRun: {
        id: 'success-1',
        status: 'succeeded',
        startedAt: '2026-04-25T08:00:00.000Z',
        finishedAt: '2026-04-25T08:01:00.000Z',
        servicesChecked: 1,
      },
    })
  })

  it('returns 503 when the latest completed run failed', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:03:00.000Z'))

    const response = await requestHealth([
      run('failure-2', 'failed', '2026-04-25T08:01:00.000Z', '2026-04-25T08:02:00.000Z'),
      run('success-1', 'succeeded', '2026-04-25T08:00:00.000Z', '2026-04-25T08:01:00.000Z'),
    ])

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      lastRun: { id: 'failure-2', status: 'failed' },
    })
  })

  it('returns 503 when the latest successful run is stale', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:10:00.000Z'))

    const response = await requestHealth([
      run('success-1', 'succeeded', '2026-04-25T08:00:00.000Z', '2026-04-25T08:01:00.000Z'),
    ])

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      lastRun: { id: 'success-1', status: 'succeeded' },
    })
  })

  it('returns 503 and no last run when only an in-progress run exists', async () => {
    vi.setSystemTime(new Date('2026-04-25T08:03:00.000Z'))

    const response = await requestHealth([
      run('running-1', 'running', '2026-04-25T08:02:00.000Z', null),
    ])

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ status: 'degraded', lastRun: null })
  })
})

describe('config resolution', () => {
  it('uses the checked-in config when STATUS_CONFIG is not provided', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/incidents'),
      {} as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      product: { description: string }
      services: Array<{ id: string; name: string }>
    }

    expect(response.status).toBe(200)
    expect(payload.product.description).toBe(defaultStatusConfig.site.description)
    expect(payload.services).toEqual(
      defaultStatusConfig.services.map(({ id, name }) => ({ id, name }))
    )
  })
})
