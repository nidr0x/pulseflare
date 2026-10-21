import type { StatusConfig, StatusService } from '@pulseflare/schema'

import { getWorkerDatabase } from '../config'
import { getRuntimeConfig } from '../install'
import {
  getPublicServiceHistory,
  listPublicIncidents,
  listPublicServiceStatuses,
  getLatestSchedulerRun,
  readMaterializedSnapshotServices,
  type PublicServiceHistoryRecord,
  type PublicServiceStatusRecord,
} from '../repositories/d1'

type ServiceState = 'operational' | 'outage' | 'unknown'
type WindowState = 'up' | 'degraded' | 'down' | 'unknown'
type PublicMaintenanceStatus = 'scheduled' | 'in_progress' | 'completed'
type PublicSummaryStatus = 'operational' | 'degraded' | 'unknown'
type PublicProductPayload = {
  name: string
  description: string
  logo?: string
  icon?: string
  navigation: Array<{ label: string; href: string }>
}

const HISTORY_WINDOW_DAYS = 90
const MAINTENANCE_RESPONSE_LIMIT = 10
const RECENT_MAINTENANCE_WINDOW_DAYS = 30
const DEFAULT_STALE_AFTER_MINUTES = 5
// Materialized snapshots are refreshed once per scheduled run; allow several
// missed crons before falling back to live computation.
const MATERIALIZED_SNAPSHOT_MAX_AGE_MS = 10 * 60_000

function publicJson(data: unknown): Response {
  return Response.json(data, {
    headers: {
      'cache-control': 'public, max-age=30, stale-while-revalidate=60',
    },
  })
}

function isSafePublicReference(value: string): boolean {
  const normalized = value.trim()
  if (normalized.startsWith('//') || normalized.startsWith('\\\\')) return false

  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return !/^[a-z][a-z\d+.-]*:/i.test(normalized)
  }
}

function buildPublicProduct(config: StatusConfig): PublicProductPayload {
  const brand = config.site.brand
  return {
    name: config.site.name,
    description: config.site.description ?? 'System health and incident reporting',
    ...(brand?.logo && isSafePublicReference(brand.logo) ? { logo: brand.logo } : {}),
    ...(brand?.icon && isSafePublicReference(brand.icon) ? { icon: brand.icon } : {}),
    navigation: (config.site.navigation ?? []).filter((item) => isSafePublicReference(item.href)),
  }
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
  const config = getRuntimeConfig(env)
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

function getMedianLatency(locations: PublicServiceHistoryRecord['locations']): number | null {
  const values = locations
    .map((location) => location.latencyMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => left - right)

  if (values.length === 0) {
    return null
  }

  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 1
    ? values[middle]
    : Math.round((values[middle - 1] + values[middle]) / 2)
}

function getHistoryDays(now: Date, days: number): string[] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  start.setUTCDate(start.getUTCDate() - days + 1)
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(start)
    day.setUTCDate(start.getUTCDate() + index)
    return day.toISOString().slice(0, 10)
  })
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
    latencyMs: getMedianLatency(historyRecord?.locations ?? []),
    history: historyRecord?.history ?? Array.from({ length: HISTORY_WINDOW_DAYS }, () => 'unknown' as const),
    historyDays: historyRecord?.historyDays ?? getHistoryDays(now, HISTORY_WINDOW_DAYS),
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

/**
 * Builds the services slice of the public payloads from raw repository data.
 * Shared by the routes (live fallback) and the scheduler, which materializes
 * the exact same payload into `snapshot_state` after each completed run.
 */
export async function buildRuntimeServicesPayload(
  config: StatusConfig,
  database: D1Database,
  now: Date
): Promise<unknown[]> {
  const [statusRecords, history] = await Promise.all([
    listPublicServiceStatuses(database),
    getPublicServiceHistory(database, now, HISTORY_WINDOW_DAYS),
  ])
  const statuses = new Map(statusRecords.map((record) => [record.id, record]))
  const staleAfterMinutes = config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES

  return config.services.map((service) =>
    buildServicePayload(service, statuses.get(service.id), history.get(service.id), now, staleAfterMinutes)
  )
}

async function buildServicesPayload(env: unknown, now: Date) {
  const config = getRuntimeConfig(env)
  const database = getWorkerDatabase(env)

  if (!database) {
    const staleAfterMinutes = config.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES
    return config.services.map((service) =>
      buildServicePayload(service, undefined, undefined, now, staleAfterMinutes)
    )
  }

  return buildRuntimeServicesPayload(config, database, now)
}

/**
 * Returns the materialized payload filtered and ordered by the current config
 * (`ghost` services removed after config changes). Returns null when the
 * materialized data cannot fully cover the config, signaling a live fallback.
 */
function resolveMaterializedServices(
  materializedServices: unknown[],
  config: StatusConfig
): unknown[] | null {
  const byId = new Map<string, Record<string, unknown>>()

  for (const entry of materializedServices) {
    if (entry && typeof entry === 'object' && 'id' in entry) {
      const id = (entry as { id: unknown }).id

      if (typeof id === 'string') {
        byId.set(id, entry as Record<string, unknown>)
      }
    }
  }

  if (!config.services.every((service) => byId.has(service.id))) {
    return null
  }

  return config.services.map((service) => byId.get(service.id) as unknown)
}

function isMaterializedSnapshotFresh(updatedAt: string, now: Date): boolean {
  const updatedAtMs = Date.parse(updatedAt)
  const ageMs = now.getTime() - updatedAtMs
  return Number.isFinite(updatedAtMs) && ageMs >= 0 && ageMs <= MATERIALIZED_SNAPSHOT_MAX_AGE_MS
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
      status: resolved ? 'resolved' : 'open',
      impact: incident.impact,
      startedAt: incident.openedAt,
      resolvedAt: incident.resolvedAt ?? undefined,
      summary: resolved
        ? `${incident.serviceName} has recovered.`
        : `${incident.serviceName} is experiencing an issue.`,
      services: [incident.serviceId],
    }
  })
}

export async function handlePublicIncidents(env: unknown, now = new Date()): Promise<Response> {
  const config = getRuntimeConfig(env)
  const database = getWorkerDatabase(env)
  const [incidents, maintenance] = await Promise.all([
    database ? listPublicIncidents(database) : Promise.resolve([]),
    Promise.resolve(buildMaintenancePayload(config, now)),
  ])

  return publicJson({
    product: buildPublicProduct(config),
    services: config.services.map(({ id, name }) => ({ id, name })),
    incidents: buildIncidentPayload(incidents),
    maintenance,
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
  return publicJson({ maintenance: buildMaintenancePayload(getRuntimeConfig(env), now) })
}

export async function handlePublicSnapshot(env: unknown, now = new Date()): Promise<Response> {
  const config = getRuntimeConfig(env)
  const database = getWorkerDatabase(env)

  // Prefer the scheduler-materialized services payload: it avoids rescanning
  // 90 days of rollups on every cold cache miss. The read happens before any
  // history query so a fresh row skips the heavy scan entirely.
  const materialized = database ? await readMaterializedSnapshotServices(database) : null
  const materializedFresh =
    materialized !== null && isMaterializedSnapshotFresh(materialized.updatedAt, now)

  let services: unknown[]

  if (database && materializedFresh) {
    const resolved = resolveMaterializedServices(materialized!.services, config)
    services = resolved ?? (await buildRuntimeServicesPayload(config, database, now))
  } else {
    services = await buildServicesPayload(env, now)
  }

  const statuses = await getRuntimeServiceStatuses(env)
  const incidents = database ? await listPublicIncidents(database) : []

  return publicJson({
    product: buildPublicProduct(config),
    summary: buildSummaryPayload(config, statuses, now),
    services,
    incidents: buildIncidentPayload(incidents),
    maintenance: buildMaintenancePayload(config, now),
  })
}

export async function handleHealth(env: unknown, now = new Date()): Promise<Response> {
  // Health must always reflect the latest scheduler state, so browsers and
  // intermediaries are told never to cache it.
  const headers = { 'cache-control': 'no-store' }
  const database = getWorkerDatabase(env)

  if (!database) {
    return Response.json({ status: 'unknown', lastRun: null }, { status: 503, headers })
  }

  const lastRun = await getLatestSchedulerRun(database)
  const staleAfterMinutes = getRuntimeConfig(env).staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES
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
    { status: healthy ? 200 : 503, headers }
  )
}
