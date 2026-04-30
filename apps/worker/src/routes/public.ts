import type { StatusCheck, StatusConfig, StatusService } from '@pulseflare/schema'

import { getWorkerConfig, getWorkerDatabase } from '../config'
import { listPublicIncidents, listPublicServiceStatuses, type PublicServiceStatusRecord } from '../repositories/d1'

type ServiceState = 'operational' | 'outage' | 'unknown'
type WindowState = 'up' | 'down' | 'unknown'
type PublicMaintenanceStatus = 'scheduled' | 'in_progress' | 'completed'

const HISTORY_WINDOW_DAYS = 90
const MAINTENANCE_RESPONSE_LIMIT = 10
const RECENT_MAINTENANCE_WINDOW_DAYS = 30

function getLatestCheckedAt(records: PublicServiceStatusRecord[]): string {
  const timestamps = records
    .map((record) => record.checkedAt)
    .filter((checkedAt): checkedAt is string => Boolean(checkedAt))
    .sort()

  return timestamps.at(-1) ?? new Date().toISOString()
}

export async function handlePublicSummary(env: unknown): Promise<Response> {
  const config = getConfig(env)
  const statuses = await getRuntimeServiceStatuses(env)
  const records = [...statuses.values()]
  const totalCount = config.services.length || records.length
  const upCount = records.filter((record) => record.status === 'up').length
  const downCount = records.filter((record) => record.status === 'down').length

  return Response.json({
    status: downCount > 0 ? 'degraded' : 'operational',
    upCount,
    downCount,
    totalCount,
    checkedAt: getLatestCheckedAt(records),
  })
}

function getTarget(check: StatusCheck): string {
  if (check.type === 'http') {
    return check.url
  }

  return check.target
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

function buildHistory(status: ServiceState): WindowState[] {
  const state = status === 'outage' ? 'down' : status === 'unknown' ? 'unknown' : 'up'
  return Array.from({ length: HISTORY_WINDOW_DAYS }, () => state)
}

function getUptimePercentage(status: ServiceState): number {
  if (status === 'outage') {
    return 0
  }

  return 100
}

function getServiceNotes(service: StatusService, status: ServiceState, checkedAt?: string | null): string {
  if (status === 'unknown') {
    return 'Waiting for first check'
  }

  if (checkedAt) {
    return `Last checked ${checkedAt}`
  }

  return service.group ? `${service.group} service` : 'Configured monitor'
}

function buildServicePayload(service: StatusService, statusRecord?: PublicServiceStatusRecord) {
  const status = mapServiceState(statusRecord?.status)

  return {
    id: service.id,
    name: service.name,
    target: getTarget(service.checks[0]),
    status,
    uptimePercentage: getUptimePercentage(status),
    latencyMs: statusRecord?.latencyMs ?? 0,
    history: buildHistory(status),
    notes: getServiceNotes(service, status, statusRecord?.checkedAt),
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

export async function handlePublicServices(env: unknown): Promise<Response> {
  const config = getConfig(env)
  const statuses = await getRuntimeServiceStatuses(env)

  return Response.json({
    services: config.services.map((service) => buildServicePayload(service, statuses.get(service.id))),
  })
}

export async function handlePublicIncidents(env: unknown): Promise<Response> {
  const database = getWorkerDatabase(env)

  if (!database) {
    return Response.json({ incidents: [] })
  }

  const incidents = await listPublicIncidents(database)

  return Response.json({
    incidents: incidents.map((incident) => ({
      id: incident.id,
      title: incident.latestReason ?? `${incident.serviceName} incident`,
      status: incident.status === 'resolved' ? 'resolved' : 'investigating',
      impact: 'major',
      startedAt: incident.openedAt,
      resolvedAt: incident.resolvedAt ?? undefined,
      summary: incident.latestReason ?? `${incident.serviceName} is being investigated.`,
      services: [incident.serviceId],
    })),
  })
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

export async function handlePublicMaintenance(env: unknown, now = new Date()): Promise<Response> {
  const config = getConfig(env)
  const validServiceIds = new Set(config.services.map((service) => service.id))
  const nowMs = now.getTime()
  const recentCutoffMs = nowMs - RECENT_MAINTENANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000

  const normalizedEntries = config.maintenances
    .filter((entry) => (entry.services ?? []).every((serviceId) => validServiceIds.has(serviceId)))
    .map((entry) => {
      const status = getPublicMaintenanceStatus(entry.start, entry.end, nowMs)

      return {
        id: entry.id,
        title: entry.title,
        body: entry.body,
        start: entry.start,
        end: entry.end,
        status,
        services: entry.services ?? [],
      }
    })

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

  return Response.json({
    maintenance: [...activeAndUpcoming, ...recentCompleted].slice(0, MAINTENANCE_RESPONSE_LIMIT),
  })
}
