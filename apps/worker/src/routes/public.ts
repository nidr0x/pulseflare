import type { StatusConfig, StatusService } from '@pulseflare/schema'

import { getWorkerConfig, getWorkerDatabase } from '../config'
import {
  getPublicServiceHistory,
  listPublicIncidents,
  listPublicServiceStatuses,
  getLatestSchedulerRun,
  type PublicServiceHistoryRecord,
  type PublicServiceStatusRecord,
} from '../repositories/d1'

type ServiceState = 'operational' | 'outage' | 'unknown'
type WindowState = 'up' | 'degraded' | 'down' | 'unknown'
type PublicMaintenanceStatus = 'scheduled' | 'in_progress' | 'completed'
type PublicSummaryStatus = 'operational' | 'degraded' | 'unknown'

const HISTORY_WINDOW_DAYS = 90
const MAINTENANCE_RESPONSE_LIMIT = 10
const RECENT_MAINTENANCE_WINDOW_DAYS = 30
const DEFAULT_STALE_AFTER_MINUTES = 5

function publicJson(data: unknown): Response {
  return Response.json(data, {
    headers: {
      'cache-control': 'public, max-age=30, stale-while-revalidate=60',
    },
  })
}

function getLatestCheckedAt(records: PublicServiceStatusRecord[]): string | null {
  const timestamps = records
    .map((record) => record.checkedAt)
    .filter((checkedAt): checkedAt is string => Boolean(checkedAt))
    .sort()

  return timestamps.at(-1) ?? null
}

function isStale(checkedAt: string | null | undefined, now: Date, staleAfterMinutes: number): boolean {
  if (!checkedAt) {
    return true
  }

  return now.getTime() - Date.parse(checkedAt) > staleAfterMinutes * 60_000
}

function buildSummaryPayload(
  config: StatusConfig,
  statuses: Map<string, PublicServiceStatusRecord>,
  now: Date
) {
  const staleAfterMinutes = config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES
  const records = config.services
    .map((service) => statuses.get(service.id))
    .filter((record): record is PublicServiceStatusRecord => Boolean(record))
    .filter((record) => !isStale(record.checkedAt, now, staleAfterMinutes))
  const totalCount = config.services.length
  const upCount = records.filter((record) => record.status === 'up').length
  const downCount = records.filter((record) => record.status === 'down').length
  const status: PublicSummaryStatus =
    totalCount === 0 || records.length !== totalCount
      ? 'unknown'
      : downCount > 0
        ? 'degraded'
        : upCount === totalCount
          ? 'operational'
          : 'unknown'

  return {
    status,
    upCount,
    downCount,
    totalCount,
    checkedAt: getLatestCheckedAt([...statuses.values()]),
    staleAfterMinutes,
  }
}

export async function handlePublicSummary(env: unknown, now = new Date()): Promise<Response> {
  const config = getConfig(env)
  const statuses = await getRuntimeServiceStatuses(env)

  return publicJson(buildSummaryPayload(config, statuses, now))
}

function mapServiceState(status: PublicServiceStatusRecord['status'] | undefined): ServiceState {
  if (status === 'up') {
    return 'operational'
  }

  if (status === 'down') {
    return 'outage'
  }

  return 'unknown'
}

function getServiceNotes(
  service: StatusService,
  status: ServiceState,
  checkedAt: string | null | undefined,
  stale: boolean
): string {
  if (!checkedAt) {
    return 'Waiting for first check'
  }

  if (stale) {
    return `Status data is stale; last checked ${checkedAt}`
  }

  if (status === 'unknown') {
    return 'Waiting for a valid check result'
  }

  return `Last checked ${checkedAt}`
}

function buildServicePayload(
  service: StatusService,
  statusRecord: PublicServiceStatusRecord | undefined,
  historyRecord: PublicServiceHistoryRecord | undefined,
  now: Date,
  staleAfterMinutes: number
) {
  const stale = isStale(statusRecord?.checkedAt, now, staleAfterMinutes)
  const status = stale ? 'unknown' : mapServiceState(statusRecord?.status)

  return {
    id: service.id,
    name: service.name,
    group: service.group ?? null,
    status,
    uptimePercentage: historyRecord?.uptimePercentage ?? null,
    latencyMs: statusRecord?.latencyMs ?? null,
    history: historyRecord?.history ?? Array.from({ length: HISTORY_WINDOW_DAYS }, () => 'unknown' as const),
    locations: historyRecord?.locations ?? [],
    notes: getServiceNotes(service, status, statusRecord?.checkedAt, stale),
  }
}

async function getRuntimeServiceStatuses(env: unknown): Promise<Map<string, PublicServiceStatusRecord>> {
  const database = getWorkerDatabase(env)

  if (!database) {
    return new Map()
  }

  const records = await listPublicServiceStatuses(database)
  return new Map(records.map((record) => [record.id, record]))
}

async function getRuntimeServiceHistory(env: unknown, now: Date): Promise<Map<string, PublicServiceHistoryRecord>> {
  const database = getWorkerDatabase(env)

  if (!database) {
    return new Map()
  }

  return getPublicServiceHistory(database, now, HISTORY_WINDOW_DAYS)
}

function getConfig(env: unknown): StatusConfig {
  return (
    getWorkerConfig(env) ?? {
      site: { name: 'Pulseflare' },
      services: [],
      notifications: { providers: [] },
      maintenances: [],
    }
  )
}

async function buildServicesPayload(env: unknown, now: Date) {
  const config = getConfig(env)
  const [statuses, history] = await Promise.all([
    getRuntimeServiceStatuses(env),
    getRuntimeServiceHistory(env, now),
  ])
  const staleAfterMinutes = config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES

  return config.services.map((service) =>
    buildServicePayload(service, statuses.get(service.id), history.get(service.id), now, staleAfterMinutes)
  )
}

export async function handlePublicServices(env: unknown, now = new Date()): Promise<Response> {
  return publicJson({ services: await buildServicesPayload(env, now) })
}

function buildIncidentPayload(incidents: Awaited<ReturnType<typeof listPublicIncidents>>) {
  return incidents.map((incident) => {
    const resolved = incident.status === 'resolved'

    return {
      id: incident.id,
      title: resolved ? `${incident.serviceName} recovered` : `${incident.serviceName} incident`,
      status: resolved ? 'resolved' : 'investigating',
      impact: 'major',
      startedAt: incident.openedAt,
      resolvedAt: incident.resolvedAt ?? undefined,
      summary: resolved
        ? `${incident.serviceName} has recovered.`
        : `${incident.serviceName} is experiencing an issue.`,
      services: [incident.serviceId],
    }
  })
}

export async function handlePublicIncidents(env: unknown): Promise<Response> {
  const database = getWorkerDatabase(env)

  if (!database) {
    return publicJson({ incidents: [] })
  }

  return publicJson({ incidents: buildIncidentPayload(await listPublicIncidents(database)) })
}

function getPublicMaintenanceStatus(
  start: string,
  end: string | undefined,
  nowMs: number
): PublicMaintenanceStatus {
  const startMs = Date.parse(start)
  const endMs = end ? Date.parse(end) : undefined

  if (startMs > nowMs) {
    return 'scheduled'
  }

  if (endMs === undefined || endMs > nowMs) {
    return 'in_progress'
  }

  return 'completed'
}

function getEffectivePastTimestamp(start: string, end: string | undefined): number {
  return Date.parse(end ?? start)
}

function buildMaintenancePayload(config: StatusConfig, now: Date) {
  const validServiceIds = new Set(config.services.map((service) => service.id))
  const nowMs = now.getTime()
  const recentCutoffMs = nowMs - RECENT_MAINTENANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000

  const normalizedEntries = config.maintenances
    .filter((entry) => (entry.services ?? []).every((serviceId) => validServiceIds.has(serviceId)))
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      start: entry.start,
      end: entry.end,
      status: getPublicMaintenanceStatus(entry.start, entry.end, nowMs),
      services: entry.services ?? [],
    }))

  const activeAndUpcoming = normalizedEntries
    .filter((entry) => entry.status !== 'completed')
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))

  const recentCompleted = normalizedEntries
    .filter((entry) => entry.status === 'completed')
    .filter((entry) => getEffectivePastTimestamp(entry.start, entry.end) >= recentCutoffMs)
    .sort(
      (left, right) =>
        getEffectivePastTimestamp(right.start, right.end) - getEffectivePastTimestamp(left.start, left.end)
    )

  return [...activeAndUpcoming, ...recentCompleted].slice(0, MAINTENANCE_RESPONSE_LIMIT)
}

export async function handlePublicMaintenance(env: unknown, now = new Date()): Promise<Response> {
  return publicJson({ maintenance: buildMaintenancePayload(getConfig(env), now) })
}

export async function handlePublicSnapshot(env: unknown, now = new Date()): Promise<Response> {
  const config = getConfig(env)
  const database = getWorkerDatabase(env)
  const [statuses, history, incidents] = await Promise.all([
    getRuntimeServiceStatuses(env),
    getRuntimeServiceHistory(env, now),
    database ? listPublicIncidents(database) : Promise.resolve([]),
  ])
  const staleAfterMinutes = config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES

  return publicJson({
    product: {
      name: config.site.name,
      description: config.site.description ?? 'System health and incident reporting',
    },
    summary: buildSummaryPayload(config, statuses, now),
    services: config.services.map((service) =>
      buildServicePayload(service, statuses.get(service.id), history.get(service.id), now, staleAfterMinutes)
    ),
    incidents: buildIncidentPayload(incidents),
    maintenance: buildMaintenancePayload(config, now),
  })
}

export async function handleHealth(env: unknown, now = new Date()): Promise<Response> {
  const database = getWorkerDatabase(env)

  if (!database) {
    return Response.json({ status: 'unknown', lastRun: null }, { status: 503 })
  }

  const lastRun = await getLatestSchedulerRun(database)
  const staleAfterMinutes = getConfig(env).staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES
  const healthy =
    lastRun?.status === 'succeeded' &&
    Boolean(lastRun.finishedAt) &&
    now.getTime() - Date.parse(lastRun.finishedAt as string) <= staleAfterMinutes * 60_000

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            servicesChecked: lastRun.servicesChecked,
          }
        : null,
    },
    { status: healthy ? 200 : 503 }
  )
}
