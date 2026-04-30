import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../index'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('/api/public/summary', () => {
  it('summarizes configured services with D1 status when available', async () => {
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

  it('returns configured services before the database has runtime state', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/services'),
      { STATUS_CONFIG: statusConfig } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      services: Array<{ id: string; name: string; target: string; status: string; history: string[] }>
    }

    expect(response.status).toBe(200)
    expect(payload.services).toHaveLength(2)
    expect(payload.services[0]).toMatchObject({
      id: 'api',
      name: 'API',
      target: 'https://api.example.com/health',
      status: 'unknown',
    })
    expect(payload.services[0]?.history).toHaveLength(90)
  })

  it('overlays D1 status rows onto configured services', async () => {
    const database = {
      prepare(query: string) {
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
                  latest_latency_ms: 731,
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
      status: 'outage',
      uptimePercentage: 0,
      latencyMs: 731,
    })
    expect(payload.services.find((service) => service.id === 'blog')).toMatchObject({
      status: 'unknown',
      uptimePercentage: 100,
    })
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
                  latest_reason: 'API recovered',
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
      incidents: Array<{ id: string; title: string; status: string; services: string[] }>
    }

    expect(response.status).toBe(200)
    expect(payload.incidents).toEqual([
      expect.objectContaining({
        id: 'incident-1',
        title: 'API recovered',
        status: 'resolved',
        services: ['api'],
      }),
    ])
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
