import { describe, expect, it } from 'vitest'

import { defineStatusConfig, parseStatusConfig } from './config.ts'

describe('status config', () => {
  it('accepts a service with an http check', () => {
    const config = defineStatusConfig({
      site: { name: 'Acme Status' },
      services: [
        {
          id: 'api',
          name: 'API',
          group: 'Core',
          checks: [{ type: 'http', url: 'https://api.example.com/health', method: 'GET' }],
        },
      ],
      notifications: { providers: [] },
      maintenances: [],
    })

    expect(parseStatusConfig(config).services).toHaveLength(1)
  })

  it('rejects duplicate service ids', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [
          { id: 'api', name: 'API A', checks: [{ type: 'http', url: 'https://a.dev' }] },
          { id: 'api', name: 'API B', checks: [{ type: 'http', url: 'https://b.dev' }] },
        ],
        notifications: { providers: [] },
        maintenances: [],
      })
    ).toThrow(/duplicate service id/i)
  })

  it('rejects services without checks', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [{ id: 'api', name: 'API', checks: [] }],
        notifications: { providers: [] },
        maintenances: [],
      })
    ).toThrow(/invalid service api checks/i)
  })

  it('rejects blank site names', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: '   ' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://a.dev' }] }],
        notifications: { providers: [] },
        maintenances: [],
      })
    ).toThrow(/invalid site name/i)
  })

  it('accepts tcp checks with probes', () => {
    const config = defineStatusConfig({
      site: { name: 'Acme Status' },
      services: [
        {
          id: 'tcp-api',
          name: 'TCP API',
          checks: [
            {
              type: 'tcp',
              target: 'tcp.example.com:443',
              probe: { kind: 'region', target: 'iad' },
            },
          ],
        },
      ],
      notifications: { providers: [] },
      maintenances: [],
    })

    expect(parseStatusConfig(config).services).toHaveLength(1)
  })

  it('rejects invalid notification provider shapes', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://a.dev' }] }],
        notifications: {
          providers: [{ id: 'pager', type: 'email', url: 'https://hooks.example.com' }],
        },
        maintenances: [],
      })
    ).toThrow(/invalid notification provider 0 type/i)
  })

  it('rejects maintenance service references that do not exist', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://a.dev' }] }],
        notifications: { providers: [] },
        maintenances: [
          {
            id: 'maint-1',
            title: 'Database migration',
            body: 'Short maintenance window',
            start: '2026-04-18T10:00:00Z',
            services: ['missing-service'],
          },
        ],
      })
    ).toThrow(/invalid maintenance 0 service reference/i)
  })

  it('rejects invalid provider body templates', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://a.dev' }] }],
        notifications: {
          providers: [
            {
              id: 'pager',
              type: 'webhook',
              url: 'https://hooks.example.com',
              bodyTemplate: [],
            },
          ],
        },
        maintenances: [],
      })
    ).toThrow(/invalid notification provider 0 bodytemplate/i)
  })

  it('rejects null grace period minutes', () => {
    expect(() =>
      parseStatusConfig({
        site: { name: 'Acme Status' },
        services: [{ id: 'api', name: 'API', checks: [{ type: 'http', url: 'https://a.dev' }] }],
        notifications: {
          gracePeriodMinutes: null,
          providers: [],
        },
        maintenances: [],
      })
    ).toThrow(/invalid notifications grace period/i)
  })
})
