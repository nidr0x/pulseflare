import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import App, { resolveRoutePath } from './App'
import { filterEntriesByService, mergeTimelineEntries } from './components/IncidentTimeline'
import { getInitialStatusSnapshot, getStatusSnapshot, mergeSummaryIntoSnapshot } from './lib/api'
import { HomePage } from './routes/HomePage'
import { IncidentsPage } from './routes/IncidentsPage'

describe('App', () => {
  it('renders the simplified public status layout', () => {
    const html = renderToStaticMarkup(<App />)

    expect(html).toContain('All systems operational')
    expect(html).toContain('Uptime over the last 90 days')
    expect(html).toContain('Operational')
  })

  it('renders the status page without the incident timeline', () => {
    const html = renderToStaticMarkup(<HomePage snapshot={getInitialStatusSnapshot()} />)

    expect(html).toContain('Uptime over the last 90 days')
    expect(html).not.toContain('Incident log')
    expect(html).not.toContain('Recent incidents')
  })

  it('renders the incidents route as the dedicated history view', () => {
    const html = renderToStaticMarkup(<IncidentsPage snapshot={getInitialStatusSnapshot()} />)

    expect(html).toContain('Incidents &amp; Maintenance')
    expect(html).toContain('Full incident history')
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

  it('merges incidents and maintenance into one chronological timeline view', () => {
    const entries = mergeTimelineEntries(
      [
        {
          id: 'incident-1',
          title: 'API outage',
          status: 'investigating',
          impact: 'major',
          startedAt: '2026-04-20T08:10:00.000Z',
          summary: 'API is unavailable.',
          services: ['api'],
        },
      ],
      [
        {
          id: 'maintenance-1',
          title: 'Redis upgrade',
          body: 'Short maintenance window.',
          start: '2026-04-21T09:00:00.000Z',
          end: '2026-04-21T10:00:00.000Z',
          status: 'scheduled',
          services: ['redis'],
        },
        {
          id: 'maintenance-2',
          title: 'Completed index rebuild',
          body: 'Finished successfully.',
          start: '2026-04-19T09:00:00.000Z',
          end: '2026-04-19T10:00:00.000Z',
          status: 'completed',
          services: ['api'],
        },
      ]
    )

    expect(entries.map((entry) => entry.id)).toEqual([
      'maintenance-1',
      'incident-1',
      'maintenance-2',
    ])
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

  it('hydrates services and incidents from public API payloads', async () => {
    const fetcher = (async (url: string) => {
      const payloads = {
        '/api/public/summary': {
          status: 'degraded',
          checkedAt: '2026-04-19T08:15:00.000Z',
          upCount: 1,
          downCount: 1,
          totalCount: 2,
        },
        '/api/public/services': {
          services: [
            {
              id: 'api',
              name: 'API',
              target: 'https://api.example.com/health',
              status: 'outage',
              uptimePercentage: 0,
              latencyMs: 0,
              history: ['down'],
              notes: 'Last checked 2026-04-19T08:15:00.000Z',
            },
          ],
        },
        '/api/public/incidents': {
          incidents: [
            {
              id: 'incident-1',
              title: 'API outage',
              status: 'investigating',
              impact: 'major',
              startedAt: '2026-04-19T08:10:00.000Z',
              summary: 'API is unavailable.',
              services: ['api'],
            },
          ],
        },
        '/api/public/maintenance': {
          maintenance: [
            {
              id: 'maintenance-1',
              title: 'Redis upgrade',
              body: 'Short maintenance window.',
              start: '2026-04-19T09:00:00.000Z',
              end: '2026-04-19T10:00:00.000Z',
              status: 'scheduled',
              services: ['api'],
            },
          ],
        },
      } as const

      return new Response(JSON.stringify(payloads[url as keyof typeof payloads]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const snapshot = await getStatusSnapshot(fetcher)

    expect(snapshot.summary.status).toBe('degraded')
    expect(snapshot.services).toEqual([
      expect.objectContaining({ id: 'api', name: 'API', status: 'outage' }),
    ])
    expect(snapshot.incidents).toEqual([
      expect.objectContaining({ id: 'incident-1', title: 'API outage' }),
    ])
    expect(snapshot.maintenance).toEqual([
      expect.objectContaining({ id: 'maintenance-1', title: 'Redis upgrade', status: 'scheduled' }),
    ])
  })
})
