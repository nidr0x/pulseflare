import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runSmokeChecks } from './smoke-test.mjs'

describe('runSmokeChecks', () => {
  it('checks health and the public snapshot after deployment', async () => {
    const calls = []

    await runSmokeChecks({
      baseUrl: 'https://status.example.com',
      maxAttempts: 1,
      fetcher: async (input) => {
        const url = String(input)
        calls.push(url)

        if (url.endsWith('/api/health')) {
          return Response.json({ status: 'ok', lastRun: { status: 'succeeded' } })
        }

        return Response.json({
          product: { name: 'Pulseflare' },
          summary: { status: 'unknown' },
          services: [],
          incidents: [],
          maintenance: [],
        })
      },
    })

    assert.deepEqual(calls, [
      'https://status.example.com/api/health',
      'https://status.example.com/api/public/snapshot',
    ])
  })

  it('fails when health never becomes ready', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        maxAttempts: 2,
        retryDelayMs: 0,
        fetcher: async () => Response.json({ status: 'degraded' }, { status: 503 }),
      }),
      /Health check did not become ready after 2 attempts/
    )
  })
})
