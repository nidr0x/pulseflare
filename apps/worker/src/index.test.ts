import { describe, expect, it } from 'vitest'

import worker from './index'

describe('worker routing', () => {
  it('serves static app assets for non-API requests', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/'),
      {
        ASSETS: {
          fetch(request: Request) {
            return Promise.resolve(new Response(`<html>${new URL(request.url).pathname}</html>`))
          },
        },
      } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('<html>/</html>')
  })

  it('keeps API routes on the worker instead of forwarding them to static assets', async () => {
    let assetsFetchCount = 0

    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {
        ASSETS: {
          fetch() {
            assetsFetchCount += 1
            return Promise.resolve(new Response('unexpected'))
          },
        },
      } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(200)
    expect(assetsFetchCount).toBe(0)
  })

  it('keeps the public snapshot route on the worker instead of forwarding it to static assets', async () => {
    let assetsFetchCount = 0

    const response = await worker.fetch(
      new Request('https://example.com/api/public/snapshot'),
      {
        ASSETS: {
          fetch() {
            assetsFetchCount += 1
            return Promise.resolve(new Response('unexpected'))
          },
        },
      } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(200)
    expect(assetsFetchCount).toBe(0)
  })

  it('runs scheduled checks through waitUntil', async () => {
    let waitUntilPromise: Promise<unknown> | undefined

    await worker.scheduled(
      {} as ScheduledController,
      {
        PULSEFLARE_D1: {
          async exec() {
            return undefined
          },
          prepare(query: string) {
            return {
              bind(...args: unknown[]) {
                return {
                  async run() {
                    return undefined
                  },
                  async first() {
                    if (query.includes('SELECT id, status, latest_reason FROM incidents')) {
                      return null
                    }

                    if (query.includes('SELECT COUNT(*) AS service_count FROM services')) {
                      return { service_count: 0 }
                    }

                    return null
                  },
                }
              },
            }
          },
        },
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          notifications: { providers: [] },
          maintenances: [],
        },
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromise = promise
        },
      } as ExecutionContext
    )

    expect(waitUntilPromise).toBeInstanceOf(Promise)
    await expect(waitUntilPromise).resolves.toMatchObject({
      servicesChecked: 0,
      upCount: 0,
      downCount: 0,
    })
  })
})
