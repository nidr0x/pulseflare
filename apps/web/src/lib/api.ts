export type SummaryState = 'operational' | 'degraded' | 'unknown'
export type SnapshotLoadState = 'idle' | 'loading' | 'ready' | 'error'
export const DEFAULT_STALE_AFTER_MINUTES = 5

export type ServiceState = 'operational' | 'degraded' | 'outage' | 'unknown'
export type UptimeWindowState = 'up' | 'degraded' | 'down' | 'unknown'

export type StatusProduct = {
  name: string
  strapline?: string
  description: string
  logo?: string
  icon?: string
  navigation?: Array<{ label: string; href: string }>
}

export type PublicServiceOption = { id: string; name: string }

export type ServiceLocationRecord = {
  label: string
  uptimePercentage: number | null
  history: UptimeWindowState[]
  latencyMs: number | null
}

export type ServiceRecord = {
  id: string
  name: string
  group: string | null
  status: ServiceState
  uptimePercentage: number | null
  latencyMs: number | null
  history: UptimeWindowState[]
  historyDays?: string[]
  locations: ServiceLocationRecord[]
  notes: string
}

export type IncidentRecord = {
  id: string
  title: string
  status: 'open' | 'resolved' | 'monitoring' | 'investigating' | 'scheduled'
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
  product: StatusProduct
  summary: {
    status: SummaryState
    checkedAt: string | null
    staleAfterMinutes?: number
    upCount: number
    downCount: number
    totalCount: number
  }
  services: ServiceRecord[]
  incidents: IncidentRecord[]
  maintenance: MaintenanceRecord[]
}

export type IncidentPageData = {
  product: StatusProduct
  services: PublicServiceOption[]
  incidents: IncidentRecord[]
  maintenance: MaintenanceRecord[]
}

export type PublicSummaryPayload = StatusSnapshot['summary']
export type PublicSnapshotPayload = StatusSnapshot

export const EMPTY_STATUS_SNAPSHOT: StatusSnapshot = {
  product: {
    name: 'Status',
    description: 'Waiting for live status data.',
    navigation: [],
  },
  summary: {
    status: 'unknown',
    checkedAt: null,
    staleAfterMinutes: DEFAULT_STALE_AFTER_MINUTES,
    upCount: 0,
    downCount: 0,
    totalCount: 0,
  },
  services: [],
  incidents: [],
  maintenance: [],
}

export const EMPTY_INCIDENT_PAGE_DATA: IncidentPageData = {
  product: {
    name: 'Status',
    description: 'Waiting for live status data.',
    navigation: [],
  },
  services: [],
  incidents: [],
  maintenance: [],
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

export async function fetchPublicSnapshot(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<PublicSnapshotPayload | null> {
  return fetchJson<PublicSnapshotPayload>('/api/public/snapshot', fetcher)
}

export async function fetchPublicIncidentPage(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<IncidentPageData | null> {
  return fetchJson<IncidentPageData>('/api/public/incidents', fetcher)
}

export async function fetchPublicSummary(
  fetcher: typeof fetch | undefined = globalThis.fetch
): Promise<PublicSummaryPayload | null> {
  return fetchJson<PublicSummaryPayload>('/api/public/summary', fetcher)
}

export function mergeSummaryIntoSnapshot(
  snapshot: StatusSnapshot,
  summary: PublicSummaryPayload
): StatusSnapshot {
  return { ...snapshot, summary }
}

export async function getStatusSnapshot(fetcher?: typeof fetch): Promise<StatusSnapshot> {
  const snapshot = await fetchPublicSnapshot(fetcher)

  if (!snapshot) {
    throw new Error('Status snapshot unavailable')
  }

  return snapshot
}

export async function getIncidentPageData(fetcher?: typeof fetch): Promise<IncidentPageData> {
  const pageData = await fetchPublicIncidentPage(fetcher)

  if (!pageData) {
    throw new Error('Incident history unavailable')
  }

  return pageData
}

export function getInitialStatusSnapshot(): StatusSnapshot {
  return EMPTY_STATUS_SNAPSHOT
}

export type SnapshotFreshness = {
  state: 'waiting' | 'fresh' | 'stale'
  ageMs: number | null
  staleByMs: number
}

export function getSnapshotFreshness(
  checkedAt: string | null,
  now = Date.now(),
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES
): SnapshotFreshness {
  if (!checkedAt) {
    return { state: 'waiting', ageMs: null, staleByMs: 0 }
  }

  const timestamp = Date.parse(checkedAt)
  if (!Number.isFinite(timestamp)) {
    return { state: 'waiting', ageMs: null, staleByMs: 0 }
  }

  const ageMs = Math.max(0, now - timestamp)
  const staleAfterMs = Math.max(0, staleAfterMinutes) * 60_000

  return {
    state: ageMs > staleAfterMs ? 'stale' : 'fresh',
    ageMs,
    staleByMs: Math.max(0, ageMs - staleAfterMs),
  }
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))

  if (seconds < 60) {
    return 'less than a minute'
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} hr`
  }

  return `${Math.floor(hours / 24)} days`
}
