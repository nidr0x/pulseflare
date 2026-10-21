import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runSmokeChecks } from './smoke-test.mjs'

const SNAPSHOT_PAYLOAD = {
  product: { name: 'Pulseflare' },
  summary: { status: 'unknown' },
  services: [{ id: 'api', name: 'API' }],
  incidents: [],
  maintenance: [],
}

const INCIDENTS_PAYLOAD = {
  product: { name: 'Pulseflare' },
  services: [{ id: 'api', name: 'API' }],
  incidents: [],
  maintenance: [],
}

function smokeFetcher(payloads) {
  return async (input) => {
    const url = String(input)

    for (const [suffix, payload] of payloads) {
      if (url.endsWith(suffix)) {
        return Response.json(payload)
      }
    }

    return Response.json({ message: `unreachable ${url}` }, { status: 404 })
  }
}

describe('runSmokeChecks', () => {
  it('checks health, the public snapshot, and the incidents view after deployment', async () => {
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

        if (url.endsWith('/api/public/snapshot')) {
          return Response.json(SNAPSHOT_PAYLOAD)
        }

        if (url.endsWith('/api/public/incidents')) {
          return Response.json(INCIDENTS_PAYLOAD)
        }

        return Response.json({ message: 'unreachable' }, { status: 404 })
      },
    })

    assert.deepEqual(calls, [
      'https://status.example.com/api/health',
      'https://status.example.com/api/public/snapshot',
      'https://status.example.com/api/public/incidents',
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

  it('fails when the snapshot and incidents views list different services', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        maxAttempts: 1,
        fetcher: smokeFetcher([
          ['/api/health', { status: 'ok' }],
          ['/api/public/snapshot', SNAPSHOT_PAYLOAD],
          ['/api/public/incidents', { ...INCIDENTS_PAYLOAD, services: [] }],
        ]),
      }),
      /list different services/
    )
  })

  it('fails when the incidents view returns an invalid payload', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        maxAttempts: 1,
        fetcher: smokeFetcher([
          ['/api/health', { status: 'ok' }],
          ['/api/public/snapshot', SNAPSHOT_PAYLOAD],
          ['/api/public/incidents', { product: {} }],
        ]),
      }),
      /Incidents view returned an invalid payload/
    )
  })
})
