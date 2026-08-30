import { describe, expect, it } from 'vitest'

import { getPublicServiceHistory, listPublicServiceStatuses } from './d1'

describe('listPublicServiceStatuses', () => {
  it('preserves missing status rows instead of treating them as healthy', async () => {
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
                  current_status: null,
                  checked_at: null,
                  latest_latency_ms: null,
                },
              ],
            }
          },
        }
      },
    } as unknown as D1Database

    await expect(listPublicServiceStatuses(database)).resolves.toEqual([
      {
        id: 'api',
        name: 'API',
        group: 'Core',
        status: 'unknown',
        checkedAt: null,
        latencyMs: null,
      },
    ])
  })

  it('maps explicit down rows without changing them', async () => {
    const database = {
      prepare() {
        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: null,
                  current_status: 'down',
                  checked_at: '2026-04-18T17:00:00.000Z',
                  latest_latency_ms: 842,
                },
              ],
            }
          },
        }
      },
    } as unknown as D1Database

    await expect(listPublicServiceStatuses(database)).resolves.toEqual([
      {
        id: 'api',
        name: 'API',
        group: null,
        status: 'down',
        checkedAt: '2026-04-18T17:00:00.000Z',
        latencyMs: 842,
      },
    ])
  })

  it('rejects unexpected status values from D1 rows', async () => {
    const database = {
      prepare() {
        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: null,
                  current_status: 'degraded',
                  checked_at: '2026-04-18T17:00:00.000Z',
                  latest_latency_ms: 99,
                },
              ],
            }
          },
        }
      },
    } as unknown as D1Database

    await expect(listPublicServiceStatuses(database)).rejects.toThrow(
      'Unexpected service status value: degraded'
    )
  })
})

describe('getPublicServiceHistory', () => {
  it('aggregates persisted check results into daily windows and uptime', async () => {
    const database = {
      prepare(query: string) {
        expect(query).toContain('FROM check_results')

        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    { service_id: 'api', recorded_at: '2026-04-25T08:00:00.000Z', status: 'up' },
                    { service_id: 'api', recorded_at: '2026-04-25T08:01:00.000Z', status: 'down' },
                    { service_id: 'api', recorded_at: '2026-04-24T08:00:00.000Z', status: 'up' },
                  ],
                }
              },
            }
          },
        }
      },
    } as unknown as D1Database

    const history = await getPublicServiceHistory(
      database,
      new Date('2026-04-25T12:00:00.000Z'),
      2
    )

    expect(history.get('api')).toEqual({
      uptimePercentage: 66.67,
      history: ['up', 'degraded'],
    })
  })
})
