import { MOCK_STATUS_SNAPSHOT } from './mockSnapshot'

export type SummaryState = 'operational' | 'degraded'

export type ServiceState = 'operational' | 'degraded' | 'outage' | 'unknown'
export type UptimeWindowState = 'up' | 'degraded' | 'down' | 'unknown'

export type ServiceRecord = {
  id: string
  name: string
  group: string | null
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
  body: string
  start: string
  end?: string
  status: 'scheduled' | 'in_progress' | 'completed'
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

type PublicServicesPayload = {
  services: ServiceRecord[]
}

type PublicIncidentsPayload = {
  incidents: IncidentRecord[]
}

type PublicMaintenancePayload = {
  maintenance: MaintenanceRecord[]
}

async function fetchJson<T>(
  path: string,
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<T | null> {
  if (typeof fetcher !== 'function') {
    return null
  }

  try {
    const response = await fetcher(path)
    if (!response.ok) {
      return null
    }

    return (await response.json()) as T
  } catch {
    return null
  }
}

export async function fetchPublicSummary(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<PublicSummaryPayload | null> {
  return fetchJson<PublicSummaryPayload>('/api/public/summary', fetcher)
}

async function fetchPublicServices(fetcher: typeof fetch | undefined = globalThis.fetch): Promise<ServiceRecord[] | null> {
  const payload = await fetchJson<PublicServicesPayload>('/api/public/services', fetcher)
  return payload?.services ?? null
}

async function fetchPublicIncidents(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<IncidentRecord[] | null> {
  const payload = await fetchJson<PublicIncidentsPayload>('/api/public/incidents', fetcher)
  return payload?.incidents ?? null
}

async function fetchPublicMaintenance(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<MaintenanceRecord[] | null> {
  const payload = await fetchJson<PublicMaintenancePayload>('/api/public/maintenance', fetcher)
  return payload?.maintenance ?? null
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
  const [summary, services, incidents, maintenance] = await Promise.all([
    fetchPublicSummary(fetcher),
    fetchPublicServices(fetcher),
    fetchPublicIncidents(fetcher),
    fetchPublicMaintenance(fetcher),
  ])

  if (!summary && !services && !incidents && !maintenance) {
    return MOCK_STATUS_SNAPSHOT
  }

  const snapshot = summary ? mergeSummaryIntoSnapshot(MOCK_STATUS_SNAPSHOT, summary) : MOCK_STATUS_SNAPSHOT

  return {
    ...snapshot,
    services: services ?? snapshot.services,
    incidents: incidents ?? snapshot.incidents,
    maintenance: maintenance ?? snapshot.maintenance,
  }
}

export function getInitialStatusSnapshot(): StatusSnapshot {
  return MOCK_STATUS_SNAPSHOT
}
