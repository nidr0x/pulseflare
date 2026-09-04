export type PublicServiceStatusRecord = {
  id: string
  name: string
  group: string | null
  status: 'up' | 'down' | 'unknown'
  checkedAt: string | null
  latencyMs: number | null
}

export type PublicServiceHistoryRecord = {
  uptimePercentage: number | null
  history: Array<'up' | 'degraded' | 'down' | 'unknown'>
  locations: PublicServiceLocationRecord[]
}

export type PublicServiceLocationRecord = {
  label: string
  uptimePercentage: number | null
  history: Array<'up' | 'degraded' | 'down' | 'unknown'>
}

export type PublicIncidentRecord = {
  id: string
  serviceId: string
  serviceName: string
  status: 'open' | 'resolved'
  openedAt: string
  resolvedAt: string | null
}

export type SchedulerRunRecord = {
  id: string
  startedAt: string
  finishedAt: string | null
  status: 'running' | 'succeeded' | 'failed'
  servicesChecked: number
  upCount: number
  downCount: number
  errorMessage: string | null
}

type D1Row = {
  id: string
  name: string
  service_group: string | null
  current_status: string | null
  checked_at: string | null
  latest_latency_ms: number | null
}

type CheckResultD1Row = {
  service_id: string
  recorded_at: string
  status: 'up' | 'down'
  location_label?: string | null
}

type D1Result<T> = {
  results?: T[]
}

type IncidentD1Row = {
  id: string
  service_id: string
  service_name: string
  status: string
  opened_at: string
  resolved_at: string | null
}

type SchedulerRunD1Row = {
  id: string
  started_at: string
  finished_at: string | null
  status: string
  services_checked: number
  up_count: number
  down_count: number
  error_message: string | null
}

function mapCurrentStatus(currentStatus: string | null): PublicServiceStatusRecord['status'] {
  if (currentStatus === null) {
    return 'unknown'
  }

  if (currentStatus === 'up' || currentStatus === 'down') {
    return currentStatus
  }

  throw new Error(`Unexpected service status value: ${currentStatus}`)
}

export async function listPublicServiceStatuses(database: D1Database): Promise<PublicServiceStatusRecord[]> {
  const statement = database.prepare(`
    SELECT
      services.id,
      services.name,
      services.service_group,
      service_status.current_status,
      service_status.checked_at,
      (
        SELECT latency_points.latency_ms
        FROM latency_points
        WHERE latency_points.service_id = services.id
        ORDER BY latency_points.recorded_at DESC
        LIMIT 1
      ) AS latest_latency_ms
    FROM services
    LEFT JOIN service_status ON service_status.service_id = services.id
    WHERE services.is_active = 1
    ORDER BY services.sort_order ASC, services.name ASC
  `)

  const result = (await statement.all()) as D1Result<D1Row>

  return (result.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    group: row.service_group,
    status: mapCurrentStatus(row.current_status),
    checkedAt: row.checked_at,
    latencyMs: row.latest_latency_ms,
  }))
}

function getUtcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10)
}

function getHistoryDays(now: Date, days: number): string[] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - days + 1)

  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start)
    day.setUTCDate(start.getUTCDate() + index)
    return getUtcDayKey(day)
  })
}

type DayCounts = { up: number; down: number }
type DayHistory = Map<string, DayCounts>

function incrementDayCount(days: DayHistory, day: string, status: 'up' | 'down'): void {
  const counts = days.get(day) ?? { up: 0, down: 0 }
  counts[status] += 1
  days.set(day, counts)
}

function summarizeDayHistory(dayKeys: string[], dayCounts: DayHistory) {
  let successfulChecks = 0
  let totalChecks = 0

  const history = dayKeys.map((day) => {
    const counts = dayCounts.get(day)

    if (!counts) {
      return 'unknown' as const
    }

    successfulChecks += counts.up
    totalChecks += counts.up + counts.down

    if (counts.down === 0) {
      return 'up' as const
    }

    return counts.up === 0 ? ('down' as const) : ('degraded' as const)
  })

  return {
    uptimePercentage:
      totalChecks > 0 ? Math.round((successfulChecks / totalChecks) * 10000) / 100 : null,
    history,
  }
}

function mapPublicLocationLabel(value: string): string {
  const normalized = value.trim()

  if (normalized === 'default' || normalized === 'local') {
    return 'Local'
  }

  if (normalized === 'proxy') {
    return 'Remote proxy'
  }

  if (normalized.startsWith('region:')) {
    return normalized.slice('region:'.length) || 'Unknown region'
  }

  return 'Remote'
}

export async function getPublicServiceHistory(
  database: D1Database,
  now = new Date(),
  days = 90
): Promise<Map<string, PublicServiceHistoryRecord>> {
  const dayKeys = getHistoryDays(now, days)
  const cutoff = `${dayKeys[0]}T00:00:00.000Z`
  const result = (await database
    .prepare(
      `
        SELECT service_id, recorded_at, status, location_label
        FROM check_results
        WHERE recorded_at >= ?
        ORDER BY recorded_at ASC
      `
    )
    .bind(cutoff)
    .all()) as D1Result<CheckResultD1Row>

  const grouped = new Map<string, { aggregate: DayHistory; locations: Map<string, DayHistory> }>()

  for (const row of result.results ?? []) {
    const day = row.recorded_at.slice(0, 10)
    const serviceHistory = grouped.get(row.service_id) ?? {
      aggregate: new Map<string, DayCounts>(),
      locations: new Map<string, DayHistory>(),
    }
    const locationLabel = row.location_label?.trim() || 'default'
    const locationDays = serviceHistory.locations.get(locationLabel) ?? new Map<string, DayCounts>()

    incrementDayCount(serviceHistory.aggregate, day, row.status)
    incrementDayCount(locationDays, day, row.status)
    serviceHistory.locations.set(locationLabel, locationDays)
    grouped.set(row.service_id, serviceHistory)
  }

  return new Map(
    [...grouped.entries()].map(([serviceId, serviceHistory]) => {
      const aggregate = summarizeDayHistory(dayKeys, serviceHistory.aggregate)
      const locations = [...serviceHistory.locations.entries()]
        .map(([label, dayCounts]) => ({
          label: mapPublicLocationLabel(label),
          ...summarizeDayHistory(dayKeys, dayCounts),
        }))
        .sort((left, right) => left.label.localeCompare(right.label))

      return [
        serviceId,
        {
          ...aggregate,
          locations,
        },
      ] as const
    })
  )
}

function mapIncidentStatus(status: string): PublicIncidentRecord['status'] {
  if (status === 'open' || status === 'resolved') {
    return status
  }

  throw new Error(`Unexpected incident status value: ${status}`)
}

export async function listPublicIncidents(database: D1Database): Promise<PublicIncidentRecord[]> {
  const statement = database.prepare(`
    SELECT
      incidents.id,
      incidents.service_id,
      services.name AS service_name,
      incidents.status,
      incidents.opened_at,
      incidents.resolved_at
    FROM incidents
    JOIN services ON services.id = incidents.service_id
    ORDER BY opened_at DESC
    LIMIT 50
  `)

  const result = (await statement.all()) as D1Result<IncidentD1Row>

  return (result.results ?? []).map((row) => ({
    id: row.id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    status: mapIncidentStatus(row.status),
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
  }))
}

export async function getLatestSchedulerRun(database: D1Database): Promise<SchedulerRunRecord | null> {
  const result = (await database
    .prepare(
      `
        SELECT id, started_at, finished_at, status, services_checked, up_count, down_count, error_message
        FROM scheduler_runs
        ORDER BY started_at DESC
        LIMIT 1
      `
    )
    .first<SchedulerRunD1Row>())

  if (!result) {
    return null
  }

  if (result.status !== 'running' && result.status !== 'succeeded' && result.status !== 'failed') {
    throw new Error(`Unexpected scheduler run status value: ${result.status}`)
  }

  return {
    id: result.id,
    startedAt: result.started_at,
    finishedAt: result.finished_at,
    status: result.status,
    servicesChecked: result.services_checked,
    upCount: result.up_count,
    downCount: result.down_count,
    errorMessage: result.error_message,
  }
}
