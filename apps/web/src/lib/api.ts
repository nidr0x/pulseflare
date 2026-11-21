export type SummaryState = 'operational' | 'degraded' | 'unknown'
export type SnapshotLoadState = 'idle' | 'loading' | 'ready' | 'error'
export const DEFAULT_STALE_AFTER_MINUTES = 5
// Public snapshots scan the full 90-day rollup window. Poll infrequently and
// rely on the edge cache plus focus refreshes to keep D1 reads bounded.
export const PUBLIC_REFRESH_INTERVAL_MS = 5 * 60_000
// Bound every public API call so a hung connection resolves to the error state
// instead of leaving the page in a loading loop forever.
export const DEFAULT_PUBLIC_FETCH_TIMEOUT_MS = 10_000

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
  fetcher: typeof fetch | undefined = globalThis.fetch,
  timeoutMs = DEFAULT_PUBLIC_FETCH_TIMEOUT_MS,
  validate: (value: unknown) => value is T
): Promise<T | null> {
  if (typeof fetcher !== 'function') {
    return null
  }

  try {
    const response = await fetcher(path, { signal: AbortSignal.timeout(timeoutMs) })

    if (!response.ok) {
      return null
    }

    const payload: unknown = await response.json()
    return validate(payload) ? payload : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    return false
  }

  const day = value.slice(0, 10)
  return Number.isFinite(Date.parse(`${day}T00:00:00.000Z`)) && new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day
}

function isUtcDay(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  )
}

function isDate(value: unknown): value is string {
  return isTimestamp(value) || isUtcDay(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isHistory(value: unknown): value is UptimeWindowState[] {
  return Array.isArray(value) && value.every((state) => ['up', 'degraded', 'down', 'unknown'].includes(state as string))
}

function isPercent(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
}

function isLatency(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isProduct(value: unknown): value is StatusProduct {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.strapline === undefined || typeof value.strapline === 'string') &&
    (value.logo === undefined || typeof value.logo === 'string') &&
    (value.icon === undefined || typeof value.icon === 'string') &&
    (value.navigation === undefined ||
      (Array.isArray(value.navigation) &&
        value.navigation.every((item) => isRecord(item) && typeof item.label === 'string' && typeof item.href === 'string')))
  )
}

function isSummary(value: unknown): value is StatusSnapshot['summary'] {
  return (
    isRecord(value) &&
    ['operational', 'degraded', 'unknown'].includes(value.status as string) &&
    (value.checkedAt === null || isTimestamp(value.checkedAt)) &&
    Number.isInteger(value.upCount) && (value.upCount as number) >= 0 &&
    Number.isInteger(value.downCount) && (value.downCount as number) >= 0 &&
    Number.isInteger(value.totalCount) && (value.totalCount as number) >= 0 &&
    (value.staleAfterMinutes === undefined ||
      (typeof value.staleAfterMinutes === 'number' && Number.isFinite(value.staleAfterMinutes) && value.staleAfterMinutes >= 0))
  )
}

function isService(value: unknown): value is ServiceRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' && typeof value.name === 'string' &&
    (typeof value.group === 'string' || value.group === null) &&
    ['operational', 'degraded', 'outage', 'unknown'].includes(value.status as string) &&
    isPercent(value.uptimePercentage) && isLatency(value.latencyMs) && isHistory(value.history) &&
    (value.historyDays === undefined || (Array.isArray(value.historyDays) && value.historyDays.every(isUtcDay))) &&
    Array.isArray(value.locations) && value.locations.every((location) =>
      isRecord(location) && typeof location.label === 'string' && isPercent(location.uptimePercentage) &&
      isHistory(location.history) && isLatency(location.latencyMs)
    ) &&
    typeof value.notes === 'string'
  )
}

function isIncident(value: unknown): value is IncidentRecord {
  return (
    isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' &&
    ['open', 'resolved', 'monitoring', 'investigating', 'scheduled'].includes(value.status as string) &&
    ['minor', 'major', 'maintenance'].includes(value.impact as string) &&
    isTimestamp(value.startedAt) && (value.resolvedAt === undefined || isTimestamp(value.resolvedAt)) &&
    typeof value.summary === 'string' && isStringArray(value.services)
  )
}

function isMaintenance(value: unknown): value is MaintenanceRecord {
  return (
    isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string' &&
    typeof value.body === 'string' && isDate(value.start) &&
    (value.end === undefined || isDate(value.end)) &&
    ['scheduled', 'in_progress', 'completed'].includes(value.status as string) && isStringArray(value.services)
  )
}

function isPublicSnapshot(value: unknown): value is PublicSnapshotPayload {
  return (
    isRecord(value) && isProduct(value.product) && isSummary(value.summary) &&
    Array.isArray(value.services) && value.services.every(isService) &&
    Array.isArray(value.incidents) && value.incidents.every(isIncident) &&
    Array.isArray(value.maintenance) && value.maintenance.every(isMaintenance)
  )
}

function isIncidentPage(value: unknown): value is IncidentPageData {
  return (
    isRecord(value) && isProduct(value.product) &&
    Array.isArray(value.services) && value.services.every((service) =>
      isRecord(service) && typeof service.id === 'string' && typeof service.name === 'string'
    ) &&
    Array.isArray(value.incidents) && value.incidents.every(isIncident) &&
    Array.isArray(value.maintenance) && value.maintenance.every(isMaintenance)
  )
}

export async function fetchPublicSnapshot(
  fetcher: typeof fetch | undefined = globalThis.fetch,
  timeoutMs = DEFAULT_PUBLIC_FETCH_TIMEOUT_MS
): Promise<PublicSnapshotPayload | null> {
  return fetchJson('/api/public/snapshot', fetcher, timeoutMs, isPublicSnapshot)
}

export async function fetchPublicIncidentPage(
  fetcher: typeof fetch | undefined = globalThis.fetch,
  timeoutMs = DEFAULT_PUBLIC_FETCH_TIMEOUT_MS
): Promise<IncidentPageData | null> {
  return fetchJson('/api/public/incidents', fetcher, timeoutMs, isIncidentPage)
}

export async function fetchPublicSummary(
  fetcher: typeof fetch | undefined = globalThis.fetch,
  timeoutMs = DEFAULT_PUBLIC_FETCH_TIMEOUT_MS
): Promise<PublicSummaryPayload | null> {
  return fetchJson('/api/public/summary', fetcher, timeoutMs, isSummary)
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
  if (!Number.isFinite(milliseconds)) {
    return 'unknown duration'
  }

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
