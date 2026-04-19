import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import App, { resolveRoutePath } from './App'
import { filterEntriesByService } from './components/IncidentTimeline'
import { getInitialStatusSnapshot, mergeSummaryIntoSnapshot } from './lib/api'

describe('App', () => {
  it('renders the simplified public status layout', () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('All systems operational')
    expect(html).toContain('Uptime over the last 90 days')
    expect(html).toContain('Operational')
  })

  it('maps supported and unsupported paths into app routes', () => {
    expect(resolveRoutePath('/')).toBe('/')
    expect(resolveRoutePath('/incidents')).toBe('/incidents')
    expect(resolveRoutePath('/something-else')).toBe('/')
  })

  it('filters timeline entries by selected service id', () => {
    const snapshot = getInitialStatusSnapshot()

    expect(filterEntriesByService(snapshot.incidents, 'alerts-pipeline')).toHaveLength(1)
    expect(filterEntriesByService(snapshot.incidents, 'edge-api')).toHaveLength(1)
    expect(filterEntriesByService(snapshot.incidents, 'all')).toHaveLength(snapshot.incidents.length)
  })

  it('hydrates the initial snapshot summary while keeping the rest of the snapshot intact', () => {
    const snapshot = getInitialStatusSnapshot()
    const next = mergeSummaryIntoSnapshot(snapshot, {
      status: 'degraded',
      checkedAt: '2026-04-19T08:15:00.000Z',
      upCount: 4,
      downCount: 1,
      totalCount: 5,
    })

    expect(next.summary.status).toBe('degraded')
    expect(next.summary.downCount).toBe(1)
    expect(next.services).toBe(snapshot.services)
    expect(next.incidents).toBe(snapshot.incidents)
  })
})
