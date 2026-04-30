import { describe, expect, it } from 'vitest'

import { buildSummary } from './status-summary'

describe('buildSummary', () => {
  it('reports operational for an empty service list', () => {
    expect(buildSummary([])).toEqual({
      status: 'operational',
      upCount: 0,
      downCount: 0,
      totalCount: 0,
    })
  })

  it('reports operational when all services are up', () => {
    const summary = buildSummary([
      { id: 'api', name: 'API', status: 'up' },
      { id: 'web', name: 'Web', status: 'up' },
    ])

    expect(summary).toEqual({
      status: 'operational',
      upCount: 2,
      downCount: 0,
      totalCount: 2,
    })
  })

  it('reports degraded when any service is down', () => {
    const summary = buildSummary([
      { id: 'api', name: 'API', status: 'down' },
      { id: 'web', name: 'Web', status: 'up' },
    ])

    expect(summary.status).toBe('degraded')
    expect(summary.upCount).toBe(1)
    expect(summary.downCount).toBe(1)
  })

  it('reports degraded when all services are down', () => {
    const summary = buildSummary([
      { id: 'api', name: 'API', status: 'down' },
      { id: 'web', name: 'Web', status: 'down' },
    ])

    expect(summary).toEqual({
      status: 'degraded',
      upCount: 0,
      downCount: 2,
      totalCount: 2,
    })
  })
})
