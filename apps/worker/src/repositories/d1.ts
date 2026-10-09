export type PublicServiceStatusRecord = {
  id: string
  name: string
  group: string | null
  status: 'up' | 'down' | 'unknown'
  checkedAt: string | null
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
  latencyMs: number | null
}

export type PublicIncidentRecord = {
  id: string
  serviceId: string
  serviceName: string
  status: 'open' | 'resolved'
  impact: 'minor' | 'major'
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
}

type DailyCheckRollupD1Row = {
  service_id: string
  day: string
  location_label: string
  up_count: number
  down_count: number
  last_latency_ms: number | null
}

type D1Result<T> = {
  results?: T[]
}

type IncidentD1Row = {
  id: string
  service_id: string
  service_name: string
  status: string
  impact: string
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
      service_status.checked_at
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

function addDayCounts(days: DayHistory, day: string, up: number, down: number): void {
  const counts = days.get(day) ?? { up: 0, down: 0 }
  counts.up += up
  counts.down += down
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
  const cutoff = dayKeys[0]
  const result = (await database
    .prepare(
      `
        SELECT service_id, day, location_label, up_count, down_count, last_latency_ms
        FROM daily_check_rollups
        WHERE day >= ?
        ORDER BY day DESC, location_label ASC
      `
    )
    .bind(cutoff)
    .all()) as D1Result<DailyCheckRollupD1Row>

  const grouped = new Map<
    string,
    { aggregate: DayHistory; locations: Map<string, { days: DayHistory; latencyMs: number | null }> }
  >()

  for (const row of result.results ?? []) {
    const serviceHistory = grouped.get(row.service_id) ?? {
      aggregate: new Map<string, DayCounts>(),
      locations: new Map<string, { days: DayHistory; latencyMs: number | null }>(),
    }
    const locationLabel = row.location_label?.trim() || 'default'
    const location = serviceHistory.locations.get(locationLabel) ?? {
      days: new Map<string, DayCounts>(),
      latencyMs: null,
    }

    addDayCounts(serviceHistory.aggregate, row.day, row.up_count, row.down_count)
    addDayCounts(location.days, row.day, row.up_count, row.down_count)
    if (location.latencyMs === null && row.last_latency_ms !== null) {
      location.latencyMs = row.last_latency_ms
    }
    serviceHistory.locations.set(locationLabel, location)
    grouped.set(row.service_id, serviceHistory)
  }

  return new Map(
    [...grouped.entries()].map(([serviceId, serviceHistory]) => {
      const aggregate = summarizeDayHistory(dayKeys, serviceHistory.aggregate)
      const locations = [...serviceHistory.locations.entries()]
        .map(([label, location]) => ({
          label: mapPublicLocationLabel(label),
          ...summarizeDayHistory(dayKeys, location.days),
          latencyMs: location.latencyMs,
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

function mapIncidentImpact(impact: string): PublicIncidentRecord['impact'] {
  if (impact === 'minor' || impact === 'major') {
    return impact
  }

  throw new Error(`Unexpected incident impact value: ${impact}`)
}

export async function listPublicIncidents(database: D1Database): Promise<PublicIncidentRecord[]> {
  const statement = database.prepare(`
    SELECT
      incidents.id,
      incidents.service_id,
      services.name AS service_name,
      incidents.status,
      incidents.impact,
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
    impact: mapIncidentImpact(row.impact),
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
