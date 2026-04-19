export type PublicServiceStatusRecord = {
  id: string
  name: string
  group: string | null
  status: 'up' | 'down' | 'unknown'
  checkedAt: string | null
}

type D1Row = {
  id: string
  name: string
  service_group: string | null
  current_status: string | null
  checked_at: string | null
}

type D1Result<T> = {
  results?: T[]
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
