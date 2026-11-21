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

const EXPECTED_SHA = 'abc123'
const ROOT_HTML = '<!doctype html><script type="module" src="/assets/app.js"></script>'

function smokeFetcher(payloads) {
  return async (input, init) => {
    const url = String(input)

    if (url.endsWith('/')) {
      return new Response(ROOT_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    if (url.endsWith('/assets/app.js')) {
      assert.equal(init?.method, 'HEAD')
      return new Response(null, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
    }

    for (const [suffix, payload] of payloads) {
      if (url.endsWith(suffix)) {
        return Response.json(suffix === '/api/health' ? { ...payload, gitSha: EXPECTED_SHA } : payload)
      }
    }

    return Response.json({ message: `unreachable ${url}` }, { status: 404 })
  }
}

describe('runSmokeChecks', () => {
  it('checks the expected revision, public APIs, root HTML, and its JavaScript asset', async () => {
    const calls = []

    await runSmokeChecks({
      baseUrl: 'https://status.example.com',
      expectedSha: EXPECTED_SHA,
      maxAttempts: 1,
      fetcher: async (input, init) => {
        const url = String(input)
        calls.push(url)

        if (url.endsWith('/api/health')) {
          return Response.json({ status: 'ok', gitSha: EXPECTED_SHA, lastRun: { status: 'succeeded' } })
        }

        if (url.endsWith('/')) {
          return new Response(ROOT_HTML, { headers: { 'content-type': 'text/html' } })
        }

        if (url.endsWith('/assets/app.js')) {
          assert.equal(init?.method, 'HEAD')
          return new Response(null, { headers: { 'content-type': 'text/javascript' } })
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
      'https://status.example.com/',
      'https://status.example.com/assets/app.js',
      'https://status.example.com/api/public/snapshot',
      'https://status.example.com/api/public/incidents',
    ])
  })

  it('fails when health never becomes ready', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        expectedSha: EXPECTED_SHA,
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
        expectedSha: EXPECTED_SHA,
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
        expectedSha: EXPECTED_SHA,
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

  it('fails when health reports a different deployed SHA', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        expectedSha: EXPECTED_SHA,
        maxAttempts: 1,
        fetcher: async () => Response.json({ status: 'ok', gitSha: 'old-sha' }),
      }),
      /expected SHA abc123/
    )
  })

  it('fails when the referenced JavaScript asset is missing', async () => {
    await assert.rejects(
      runSmokeChecks({
        baseUrl: 'https://status.example.com',
        expectedSha: EXPECTED_SHA,
        maxAttempts: 1,
        fetcher: async (input) => {
          const url = String(input)
          if (url.endsWith('/api/health')) return Response.json({ status: 'ok', gitSha: EXPECTED_SHA })
          if (url.endsWith('/')) return new Response(ROOT_HTML, { headers: { 'content-type': 'text/html' } })
          return new Response(null, { status: 404 })
        },
      }),
      /JavaScript asset returned HTTP 404/
    )
  })
})
