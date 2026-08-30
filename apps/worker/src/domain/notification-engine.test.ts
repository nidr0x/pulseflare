import { describe, expect, it, vi } from 'vitest'
import type { StatusConfig } from '@pulseflare/schema'

import { dispatchPendingNotifications, enqueueNotificationDispatches } from './notification-engine'

function createFakeDatabase(rows: Array<Record<string, unknown>>, claimChanges = 1) {
  const runs: unknown[][] = []
  const outbox: unknown[][] = []
  const database = {
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (query.includes('FROM notification_outbox')) {
                return { results: rows }
              }

              return { results: [] }
            },
            async run() {
              runs.push(args)

              if (query.includes('INSERT INTO notification_outbox')) {
                const deliveryKey = args.slice(1, 4).join('|')
                const duplicate = outbox.some((row) => row.slice(1, 4).join('|') === deliveryKey)

                if (!duplicate || !query.includes('ON CONFLICT DO NOTHING')) {
                  outbox.push(args)
                }
              }

              if (query.includes('SET claimed_by = ?, claimed_until = ?')) {
                return { meta: { changes: claimChanges } }
              }
            },
          }
        },
      }
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      for (const statement of statements) {
        await statement.run()
      }

      return []
    },
  }

  return { database: database as unknown as D1Database, runs, outbox }
}

const config = {
  site: { name: 'Pulseflare' },
  services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
  notifications: {
    gracePeriodMinutes: 5,
    providers: [{ id: 'ops', type: 'webhook' as const, url: 'https://hooks.example.com/status' }],
  },
  maintenances: [],
} satisfies StatusConfig

describe('notification engine', () => {
  it('queues incident notifications after the configured grace period', async () => {
    const { database, runs } = createFakeDatabase([])

    await enqueueNotificationDispatches(database, config, {
      mutation: { action: 'open', status: 'open', latestReason: 'API failed' },
      incidentId: 'incident-1',
      serviceId: 'api',
      occurredAt: '2026-04-25T08:00:00.000Z',
    })

    expect(runs[0]).toEqual([
      expect.any(String),
      'ops',
      'incident_opened',
      'incident-1',
      'api',
      expect.stringContaining('API failed'),
      '2026-04-25T08:05:00.000Z',
      '2026-04-25T08:00:00.000Z',
    ])
  })

  it('does not enqueue the same incident delivery twice', async () => {
    const { database, outbox } = createFakeDatabase([])
    const input = {
      mutation: { action: 'open' as const, status: 'open' as const, latestReason: 'API failed' },
      incidentId: 'incident-1',
      serviceId: 'api',
      occurredAt: '2026-04-25T08:00:00.000Z',
    }

    await enqueueNotificationDispatches(database, config, input)
    await enqueueNotificationDispatches(database, config, input)

    expect(outbox).toHaveLength(1)
  })

  it('delivers pending webhooks and marks them delivered', async () => {
    const { database, runs } = createFakeDatabase([
      {
        id: 'outbox-1',
        provider_id: 'ops',
        event: 'incident_opened',
        incident_id: 'incident-1',
        service_id: 'api',
        payload_json: JSON.stringify({ event: 'incident_opened', incidentId: 'incident-1' }),
        attempts: 0,
      },
    ])
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))

    await dispatchPendingNotifications(database, config, fetcher, new Date('2026-04-25T08:05:00.000Z'))

    expect(fetcher).toHaveBeenCalledWith(
      'https://hooks.example.com/status',
      expect.objectContaining({ method: 'POST' })
    )
    expect(runs.at(-1)).toEqual(['2026-04-25T08:05:00.000Z', 'outbox-1', expect.any(String)])
  })

  it('schedules a retry when a webhook fails', async () => {
    const { database, runs } = createFakeDatabase([
      {
        id: 'outbox-1',
        provider_id: 'ops',
        event: 'incident_opened',
        incident_id: 'incident-1',
        service_id: 'api',
        payload_json: JSON.stringify({ event: 'incident_opened', incidentId: 'incident-1' }),
        attempts: 0,
      },
    ])
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }))

    await dispatchPendingNotifications(database, config, fetcher, new Date('2026-04-25T08:05:00.000Z'))

    expect(runs.at(-1)).toEqual([
      'retrying',
      1,
      '2026-04-25T08:06:00.000Z',
      'Webhook returned HTTP 503',
      'outbox-1',
      expect.any(String),
    ])
  })

  it('does not deliver an outbox row already claimed by another dispatcher', async () => {
    const { database } = createFakeDatabase(
      [
        {
          id: 'outbox-1',
          provider_id: 'ops',
          event: 'incident_opened',
          incident_id: 'incident-1',
          service_id: 'api',
          payload_json: JSON.stringify({ event: 'incident_opened', incidentId: 'incident-1' }),
          attempts: 0,
        },
      ],
      0
    )
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))

    await dispatchPendingNotifications(database, config, fetcher, new Date('2026-04-25T08:05:00.000Z'))

    expect(fetcher).not.toHaveBeenCalled()
  })
})
