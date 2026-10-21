import { afterEach, describe, expect, it, vi } from 'vitest'

import worker from './index'
import { createMigrationBackedD1Database } from './testing/sqlite-d1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createMemoryCache() {
  const entries = new Map<string, Response>()
  const deletedUrls: string[] = []

  return {
    deletedUrls,
    async match(request: Request) {
      const entry = entries.get(request.url)
      return entry ? entry.clone() : undefined
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone())
    },
    async delete(request: Request | string) {
      const url = typeof request === 'string' ? request : request.url
      deletedUrls.push(url)
      return entries.delete(url)
    },
  }
}

const BOOTSTRAP_ENV = {
  PULSEFLARE_BOOTSTRAP_TOKEN: 'secret',
  STATUS_CONFIG: {
    site: { name: 'Pulseflare' },
    services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
    notifications: { providers: [] },
    maintenances: [],
  },
}

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
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
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
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(assetsFetchCount).toBe(0)
  })

  it('returns a JSON 404 for unknown API routes without falling through to assets', async () => {
    let assetsFetchCount = 0

    const response = await worker.fetch(
      new Request('https://example.com/api/does-not-exist'),
      {
        ASSETS: {
          fetch() {
            assetsFetchCount += 1
            return Promise.resolve(new Response('asset'))
          },
        },
      } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    await expect(response.json()).resolves.toEqual({ error: 'Not Found' })
    expect(assetsFetchCount).toBe(0)
  })

  it('rejects unsupported methods on public API routes', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary', { method: 'POST' }),
      {} as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    await expect(response.json()).resolves.toEqual({ error: 'Method Not Allowed' })
  })

  it('responds to HEAD without a body', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary', { method: 'HEAD' }),
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

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('')
  })

  it('returns a hardened JSON 500 when an API route fails', async () => {
    const errorLogs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLogs.push(args.map(String).join(' '))
    })

    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          notifications: { providers: [] },
          maintenances: [],
        },
        PULSEFLARE_D1: {
          prepare() {
            throw new Error('database unavailable')
          },
        },
      } as never,
      {} as ExecutionContext
    )

    const body = (await response.json()) as { error: string; requestId: string }

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(body.error).toBe('Internal Server Error')
    expect(typeof body.requestId).toBe('string')
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/)

    const loggedEvent = errorLogs.flatMap((entry) => {
      try {
        return [JSON.parse(entry) as { event?: string; requestId?: string }]
      } catch {
        return []
      }
    }).find((event) => event?.event === 'request.failed')

    expect(loggedEvent?.requestId).toBe(body.requestId)
  })

  it('serves repeated public summary requests from the edge cache', async () => {
    vi.stubGlobal('caches', { default: createMemoryCache() })
    let prepareCalls = 0

    const database = {
      prepare() {
        prepareCalls += 1
        return {
          async all() {
            return {
              results: [
                {
                  id: 'api',
                  name: 'API',
                  service_group: null,
                  current_status: 'up',
                  checked_at: new Date().toISOString(),
                },
              ],
            }
          },
        }
      },
    }
    const env = {
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
        notifications: { providers: [] },
        maintenances: [],
      },
      PULSEFLARE_D1: database,
    } as never
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
    } as unknown as ExecutionContext
    const requestUrl = 'https://example.com/api/public/summary'

    const first = await worker.fetch(new Request(requestUrl), env, ctx)
    expect(first.status).toBe(200)
    await Promise.all(pending)

    const second = await worker.fetch(new Request(requestUrl), env, ctx)

    expect(second.status).toBe(200)
    expect(prepareCalls).toBe(1)
    expect(second.headers.get('cache-control')).toContain('max-age=30')
    expect(second.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  it('shares the edge cache across harmless query strings', async () => {
    vi.stubGlobal('caches', { default: createMemoryCache() })
    let prepareCalls = 0

    const env = {
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
        notifications: { providers: [] },
        maintenances: [],
      },
      PULSEFLARE_D1: {
        prepare() {
          prepareCalls += 1
          return {
            async all() {
              return {
                results: [
                  {
                    id: 'api',
                    name: 'API',
                    service_group: null,
                    current_status: 'up',
                    checked_at: new Date().toISOString(),
                  },
                ],
              }
            },
          }
        },
      },
    } as never
    const pending: Promise<unknown>[] = []
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise)
      },
    } as unknown as ExecutionContext

    await worker.fetch(new Request('https://example.com/api/public/summary?ref=one'), env, ctx)
    await Promise.all(pending)
    await worker.fetch(new Request('https://example.com/api/public/summary?ref=two'), env, ctx)

    expect(prepareCalls).toBe(1)
  })

  it('falls back to live data when the edge cache is unavailable', async () => {
    vi.stubGlobal('caches', {
      default: {
        async match() {
          throw new Error('cache unavailable')
        },
        async put() {
          return undefined
        },
      },
    })

    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          notifications: { providers: [] },
          maintenances: [],
        },
        PULSEFLARE_D1: {
          prepare() {
            return {
              async all() {
                return { results: [] }
              },
            }
          },
        },
      } as never,
      { waitUntil() {} } as unknown as ExecutionContext
    )

    expect(response.status).toBe(200)
  })

  it('does not cache failed public API responses', async () => {
    vi.stubGlobal('caches', { default: createMemoryCache() })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let prepareCalls = 0

    const env = {
      STATUS_CONFIG: {
        site: { name: 'Pulseflare' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://api.example.com' }] }],
        notifications: { providers: [] },
        maintenances: [],
      },
      PULSEFLARE_D1: {
        prepare() {
          prepareCalls += 1
          throw new Error('database unavailable')
        },
      },
    } as never
    const ctx = {} as ExecutionContext
    const requestUrl = 'https://example.com/api/public/summary'

    const first = await worker.fetch(new Request(requestUrl), env, ctx)
    const second = await worker.fetch(new Request(requestUrl), env, ctx)

    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    expect(prepareCalls).toBe(2)
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
              async all() {
                return { results: [] }
              },
              async first() {
                if (query.includes('SELECT last_pruned_at FROM scheduler_lease')) {
                  return { last_pruned_at: null }
                }

                return null
              },
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
          async batch(statements: Array<{ run: () => Promise<unknown> }>) {
            for (const statement of statements) {
              await statement.run()
            }

            return []
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

  it('purges cached public responses after a successful bootstrap', async () => {
    const { database } = createMigrationBackedD1Database()
    const cache = createMemoryCache()

    await cache.put(
      new Request('https://example.com/api/public/summary'),
      new Response(JSON.stringify({ stale: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    await cache.put(
      new Request('https://example.com/api/public/snapshot'),
      new Response(JSON.stringify({ stale: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    )
    vi.stubGlobal('caches', { default: cache })

    const response = await worker.fetch(
      new Request('https://example.com/api/install/bootstrap', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      { PULSEFLARE_D1: database, ...BOOTSTRAP_ENV } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(200)
    expect(cache.deletedUrls).toEqual(
      expect.arrayContaining([
        'https://example.com/api/public/summary',
        'https://example.com/api/public/snapshot',
        'https://example.com/api/public/services',
        'https://example.com/api/public/incidents',
        'https://example.com/api/public/maintenance',
      ])
    )
    await expect(cache.match(new Request('https://example.com/api/public/summary'))).resolves.toBeUndefined()
  })

  it('keeps cached public responses when bootstrap is rejected', async () => {
    const { database } = createMigrationBackedD1Database()
    const cache = createMemoryCache()
    vi.stubGlobal('caches', { default: cache })

    const response = await worker.fetch(
      new Request('https://example.com/api/install/bootstrap', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
      }),
      { PULSEFLARE_D1: database, ...BOOTSTRAP_ENV } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(401)
    expect(cache.deletedUrls).toEqual([])
  })
})
