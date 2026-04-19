import { MOCK_STATUS_SNAPSHOT } from './mockSnapshot'

export type SummaryState = 'operational' | 'degraded'

export type ServiceState = 'operational' | 'degraded' | 'outage'
export type UptimeWindowState = 'up' | 'degraded' | 'down'

export type ServiceRecord = {
  id: string
  name: string
  target: string
  status: ServiceState
  uptimePercentage: number
  latencyMs: number
  history: UptimeWindowState[]
  notes: string
}

export type IncidentRecord = {
  id: string
  title: string
  status: 'resolved' | 'monitoring' | 'investigating' | 'scheduled'
  impact: 'minor' | 'major' | 'maintenance'
  startedAt: string
  resolvedAt?: string
  summary: string
  services: string[]
}

export type MaintenanceRecord = {
  id: string
  title: string
  window: string
  summary: string
  services: string[]
}

export type StatusSnapshot = {
  product: {
    name: string
    strapline: string
    description: string
  }
  summary: {
    status: SummaryState
    checkedAt: string
    upCount: number
    downCount: number
    totalCount: number
  }
  services: ServiceRecord[]
  incidents: IncidentRecord[]
  maintenance: MaintenanceRecord[]
}

export type PublicSummaryPayload = {
  status: SummaryState
  checkedAt: string
  upCount: number
  downCount: number
  totalCount: number
}

export async function fetchPublicSummary(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<PublicSummaryPayload | null> {
  if (typeof fetcher !== 'function') {
    return null
  }

  try {
    const response = await fetcher('/api/public/summary')
    if (!response.ok) {
      return null
    }

    return (await response.json()) as PublicSummaryPayload
  } catch {
    return null
  }
}

export function mergeSummaryIntoSnapshot(
  snapshot: StatusSnapshot,
  summary: PublicSummaryPayload
): StatusSnapshot {
  return {
    ...snapshot,
    summary: {
      status: summary.status,
      checkedAt: summary.checkedAt,
      upCount: summary.upCount,
      downCount: summary.downCount,
      totalCount: summary.totalCount,
    },
  }
}

export async function getStatusSnapshot(fetcher?: typeof fetch): Promise<StatusSnapshot> {
  const summary = await fetchPublicSummary(fetcher)

  if (!summary) {
    return MOCK_STATUS_SNAPSHOT
  }

  return mergeSummaryIntoSnapshot(MOCK_STATUS_SNAPSHOT, summary)
}

export function getInitialStatusSnapshot(): StatusSnapshot {
  return MOCK_STATUS_SNAPSHOT
}
