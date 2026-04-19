import type { StatusCheck, StatusConfig, StatusService } from '@pulseflare/schema'

import { getWorkerConfig, getWorkerDatabase } from '../config'
import { listPublicIncidents, listPublicServiceStatuses, type PublicServiceStatusRecord } from '../repositories/d1'

type ServiceState = 'operational' | 'outage' | 'unknown'
type WindowState = 'up' | 'down' | 'unknown'

const HISTORY_WINDOW_DAYS = 90

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
