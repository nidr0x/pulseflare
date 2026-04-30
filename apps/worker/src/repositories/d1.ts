export type PublicServiceStatusRecord = {
  id: string
  name: string
  group: string | null
  status: 'up' | 'down' | 'unknown'
  checkedAt: string | null
  latencyMs: number | null
}

export type PublicIncidentRecord = {
  id: string
  serviceId: string
  serviceName: string
  status: 'open' | 'resolved'
  latestReason: string | null
  openedAt: string
  resolvedAt: string | null
}

type D1Row = {
  id: string
  name: string
  service_group: string | null
  current_status: string | null
  checked_at: string | null
  latest_latency_ms: number | null
}

type D1Result<T> = {
  results?: T[]
}

type IncidentD1Row = {
  id: string
  service_id: string
  service_name: string
  status: string
  latest_reason: string | null
  opened_at: string
  resolved_at: string | null
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
      incidents.latest_reason,
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
    latestReason: row.latest_reason,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
  }))
}
