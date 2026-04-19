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
})
