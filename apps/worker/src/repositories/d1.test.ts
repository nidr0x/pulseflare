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
  it('reads daily rollups and exposes the latest latency per location', async () => {
    const database = {
      prepare(query: string) {
        expect(query).toContain('FROM daily_check_rollups')

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
                      last_latency_ms: 45,
                    },
                    {
                      service_id: 'api',
                      day: '2026-04-25',
                      up_count: 1,
                      down_count: 0,
                      location_label: 'region:fra',
                      last_latency_ms: 31,
                    },
                    {
                      service_id: 'api',
                      day: '2026-04-24',
                      up_count: 1,
                      down_count: 0,
                      location_label: 'region:iad',
                      last_latency_ms: 40,
                    },
                    {
                      service_id: 'api',
                      day: '2026-04-24',
                      up_count: 1,
                      down_count: 0,
                      location_label: 'region:fra',
                      last_latency_ms: 28,
                    },
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
      uptimePercentage: 80,
      history: ['up', 'degraded'],
      locations: [
        { label: 'fra', uptimePercentage: 100, history: ['up', 'up'], latencyMs: 31 },
        { label: 'iad', uptimePercentage: 66.67, history: ['up', 'degraded'], latencyMs: 45 },
      ],
    })
  })
})
