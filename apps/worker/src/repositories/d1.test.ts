import { describe, expect, it } from 'vitest'

import {
  getLatestCompletedSchedulerRun,
  getPublicServiceHistory,
  listPublicServiceStatuses,
  readMaterializedSnapshotServices,
  writeMaterializedSnapshotServices,
} from './d1'

describe('getLatestCompletedSchedulerRun', () => {
  it('reads the latest run by completion time and only considers completed statuses', async () => {
    let query = ''
    const database = {
      prepare(statement: string) {
        query = statement
        return {
          async first() {
            return {
              id: 'run-1',
              started_at: '2026-04-25T08:00:00.000Z',
              finished_at: '2026-04-25T08:01:00.000Z',
              status: 'succeeded',
              services_checked: 1,
              up_count: 1,
              down_count: 0,
              error_message: null,
            }
          },
        }
      },
    } as unknown as D1Database

    await expect(getLatestCompletedSchedulerRun(database)).resolves.toMatchObject({
      id: 'run-1',
      status: 'succeeded',
      startedAt: '2026-04-25T08:00:00.000Z',
      finishedAt: '2026-04-25T08:01:00.000Z',
    })
    expect(query).toContain("WHERE status IN ('succeeded', 'failed')")
    expect(query).toContain('ORDER BY finished_at DESC')
  })
})

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
      historyDays: ['2026-04-24', '2026-04-25'],
      locations: [
        { label: 'fra', uptimePercentage: 100, history: ['up'], latencyMs: 31 },
        { label: 'iad', uptimePercentage: 66.67, history: ['degraded'], latencyMs: 45 },
      ],
    })
  })

  it('trims per-location history to the latest bucket while keeping the full service window', async () => {
    const database = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    {
                      service_id: 'api',
                      day: '2026-04-25',
                      up_count: 0,
                      down_count: 2,
                      location_label: 'region:iad',
                      last_latency_ms: 90,
                    },
                    {
                      service_id: 'api',
                      day: '2026-04-24',
                      up_count: 2,
                      down_count: 0,
                      location_label: 'region:iad',
                      last_latency_ms: 30,
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

    const record = history.get('api')

    expect(record?.history).toEqual(['up', 'down'])
    expect(record?.locations).toEqual([
      { label: 'iad', uptimePercentage: 50, history: ['down'], latencyMs: 90 },
    ])
  })
})

describe('materialized snapshot services', () => {
  function createSnapshotStateFake() {
    const store: { row: { updated_at: string; payload_json: string } | null } = { row: null }

    return {
      store,
      database: {
        prepare(query: string) {
          if (query.includes('FROM snapshot_state') || query.includes('INTO snapshot_state')) {
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    store.row = {
                      updated_at: values[0] as string,
                      payload_json: values[1] as string,
                    }
                  },
                }
              },
              async first() {
                return store.row ? { ...store.row } : null
              },
            }
          }

          throw new Error(`Unexpected query: ${query}`)
        },
      } as unknown as D1Database,
    }
  }

  it('returns null while no snapshot row has been written', async () => {
    const { database } = createSnapshotStateFake()

    await expect(readMaterializedSnapshotServices(database)).resolves.toBeNull()
  })

  it('roundtrips the services payload through snapshot_state', async () => {
    const { database } = createSnapshotStateFake()
    const services = [{ id: 'api', name: 'API', status: 'outage' }]

    await writeMaterializedSnapshotServices(database, '2026-04-25T08:04:00.000Z', services)

    await expect(readMaterializedSnapshotServices(database)).resolves.toEqual({
      updatedAt: '2026-04-25T08:04:00.000Z',
      services,
    })
  })

  it('treats corrupt or non-array payloads as missing', async () => {
    const { database, store } = createSnapshotStateFake()

    store.row = { updated_at: '2026-04-25T08:04:00.000Z', payload_json: '{corrupt' }

    await expect(readMaterializedSnapshotServices(database)).resolves.toBeNull()

    store.row = { updated_at: '2026-04-25T08:04:00.000Z', payload_json: '"not-an-array"' }

    await expect(readMaterializedSnapshotServices(database)).resolves.toBeNull()
  })
})
