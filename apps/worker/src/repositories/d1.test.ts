import { describe, expect, it } from 'vitest'

import { listPublicServiceStatuses } from './d1'

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
