import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runConfiguredCheck } from './check-runner'

describe('runConfiguredCheck', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('marks an HTTP check as up when the response matches expectations', async () => {
    const fetcher = vi.fn(async () => new Response('ok', { status: 200 }))

    await expect(
      runConfiguredCheck(
        {
          type: 'http',
          url: 'https://api.example.com/health',
          expect: {
            status: [200],
            bodyIncludes: ['ok'],
          },
        },
        fetcher
      )
    ).resolves.toMatchObject({
      status: 'up',
      reason: 'GET https://api.example.com/health -> 200',
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('marks an HTTP check as down when the status code is unexpected', async () => {
    const fetcher = vi.fn(async () => new Response('ok', { status: 503 }))

    await expect(
      runConfiguredCheck(
        {
          type: 'http',
          url: 'https://api.example.com/health',
          expect: {
            status: [200],
          },
        },
        fetcher
      )
    ).resolves.toMatchObject({
      status: 'down',
      reason: 'Expected HTTP status 200 but received 503',
    })
  })

  it('marks an HTTP check as down when required body text is missing', async () => {
    const fetcher = vi.fn(async () => new Response('degraded', { status: 200 }))

    await expect(
      runConfiguredCheck(
        {
          type: 'http',
          url: 'https://api.example.com/health',
          expect: {
            bodyIncludes: ['ok'],
          },
        },
        fetcher
      )
    ).resolves.toMatchObject({
      status: 'down',
      reason: 'Expected response body to include "ok"',
    })
  })

  it('marks a TCP check as up when the socket opens successfully', async () => {
    const connectMock = vi.fn(() => ({
      opened: Promise.resolve({ remoteAddress: '203.0.113.10', localAddress: '198.51.100.5' }),
      close: vi.fn(async () => undefined),
    }))

    await expect(
      runConfiguredCheck(
        {
          type: 'tcp',
          target: 'redis.example.com:6379',
        },
        globalThis.fetch,
        connectMock
      )
    ).resolves.toMatchObject({
      status: 'up',
      reason: 'TCP redis.example.com:6379 connected',
    })
  })

  it('marks a TCP check as down when the socket connection fails', async () => {
    const connectMock = vi.fn(() => ({
      opened: Promise.reject(new Error('Connection refused')),
      close: vi.fn(async () => undefined),
    }))

    await expect(
      runConfiguredCheck(
        {
          type: 'tcp',
          target: 'redis.example.com:6379',
        },
        globalThis.fetch,
        connectMock
      )
    ).resolves.toMatchObject({
      status: 'down',
      reason: 'Connection refused',
    })
  })
})
