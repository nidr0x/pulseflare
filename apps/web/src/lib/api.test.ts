import { describe, expect, it } from 'vitest'

import {
  fetchPublicIncidentPage,
  fetchPublicSnapshot,
  getIncidentPageData,
  getStatusSnapshot,
} from './api'

const snapshot = {
  product: { name: 'Pulseflare', description: 'Status' },
  summary: {
    status: 'operational',
    checkedAt: '2026-11-18T12:00:00.000Z',
    upCount: 1,
    downCount: 0,
    totalCount: 1,
  },
  services: [
    {
      id: 'api',
      name: 'API',
      group: null,
      status: 'operational',
      uptimePercentage: 100,
      latencyMs: 20,
      history: ['up'],
      historyDays: ['2026-11-18'],
      locations: [{ label: 'Local', uptimePercentage: 100, history: ['up'], latencyMs: 20 }],
      notes: '',
    },
  ],
  incidents: [],
  maintenance: [
    {
      id: 'maintenance-1',
      title: 'Database maintenance',
      body: 'Scheduled work.',
      start: '2026-11-19',
      status: 'scheduled',
      services: ['api'],
    },
  ],
}

const incidentPage = {
  product: { name: 'Pulseflare', description: 'Status' },
  services: [{ id: 'api', name: 'API' }],
  incidents: [
    {
      id: 'incident-1',
      title: 'API incident',
      status: 'open',
      impact: 'major',
      startedAt: '2026-11-18T11:00:00.000Z',
      summary: 'API is unavailable.',
      services: ['api'],
    },
  ],
  maintenance: [],
}

function responseWith(payload: unknown): typeof fetch {
  return async () => Response.json(payload)
}

describe('public API response validation', () => {
  it('accepts a snapshot with the fields consumed by status views', async () => {
    await expect(fetchPublicSnapshot(responseWith(snapshot))).resolves.toEqual(snapshot)
  })

  it('rejects snapshots with missing history or invalid UI dates', async () => {
    const invalidHistory = {
      ...snapshot,
      services: [{ ...snapshot.services[0], history: undefined }],
    }
    const invalidDate = {
      ...snapshot,
      summary: { ...snapshot.summary, checkedAt: 'not-a-date' },
    }

    await expect(fetchPublicSnapshot(responseWith(invalidHistory))).resolves.toBeNull()
    await expect(fetchPublicSnapshot(responseWith(invalidDate))).resolves.toBeNull()
  })

  it('rejects incidents with malformed timestamps and keeps the query error path', async () => {
    const invalidPage = {
      ...incidentPage,
      incidents: [{ ...incidentPage.incidents[0], startedAt: '2026-02-30T12:00:00.000Z' }],
    }

    await expect(fetchPublicIncidentPage(responseWith(invalidPage))).resolves.toBeNull()
    await expect(getIncidentPageData(responseWith(invalidPage))).rejects.toThrow('Incident history unavailable')
  })

  it('throws through the existing snapshot query error path when the response is malformed', async () => {
    await expect(getStatusSnapshot(responseWith({ ...snapshot, services: [{ id: 'api' }] }))).rejects.toThrow(
      'Status snapshot unavailable'
    )
  })
})
