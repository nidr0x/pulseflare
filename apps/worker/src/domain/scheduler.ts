import type { StatusService } from '@pulseflare/schema'

import { getRemoteProbeUrl, getWorkerDatabase, getWorkerSecret } from '../config'
import { ensureBootstrapSchema, getRuntimeConfig, syncServices } from '../install'
import { runConfiguredCheck, type CheckRunResult } from './check-runner'
import { deriveIncidentMutation, type IncidentMutation } from './incident-engine'
import {
  dispatchPendingNotifications,
  prepareCancelPendingIncidentNotifications,
  prepareNotificationDispatches,
} from './notification-engine'

type Fetcher = typeof fetch

type OpenIncidentRow = {
  id: string
  status: 'open'
  latest_reason: string | null
}

type ServiceStatusRow = {
  current_status: 'up' | 'down'
  failing_since: string | null
  failure_count: number
  recovery_count: number
}

type ServiceCheckSummary = {
  status: 'up' | 'down'
  reason: string
  latencyMs?: number
}

export type ScheduledCheckSummary = {
  servicesChecked: number
  upCount: number
  downCount: number
}

const DEFAULT_FAILURE_THRESHOLD = 2
const DEFAULT_RECOVERY_THRESHOLD = 2
const CHECK_CONCURRENCY = 4
const DEFAULT_RETENTION_DAYS = 90
const SCHEDULER_LEASE_MS = 2 * 60_000

async function findOpenIncident(database: D1Database, serviceId: string): Promise<OpenIncidentRow | null> {
  return (
    (await database
      .prepare(
        `
          SELECT id, status, latest_reason
          FROM incidents
          WHERE service_id = ? AND status = 'open'
          LIMIT 1
        `
      )
      .bind(serviceId)
      .first<OpenIncidentRow>()) ?? null
  )
}

async function findServiceStatus(database: D1Database, serviceId: string): Promise<ServiceStatusRow | null> {
  return (
    (await database
      .prepare(
        `
          SELECT current_status, failing_since, failure_count, recovery_count
          FROM service_status
          WHERE service_id = ?
        `
      )
      .bind(serviceId)
      .first<ServiceStatusRow>()) ?? null
  )
}

function prepareServiceStatus(
  database: D1Database,
  input: {
    serviceId: string
    status: 'up' | 'down'
    latestReason: string | null
    checkedAt: string
    failingSince: string | null
    failureCount: number
    recoveryCount: number
  }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO service_status (
          service_id, current_status, latest_reason, checked_at, failing_since, failure_count, recovery_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(service_id) DO UPDATE SET
          current_status = excluded.current_status,
          latest_reason = excluded.latest_reason,
          checked_at = excluded.checked_at,
          failing_since = excluded.failing_since,
          failure_count = excluded.failure_count,
          recovery_count = excluded.recovery_count
      `
    )
    .bind(
      input.serviceId,
      input.status,
      input.latestReason,
      input.checkedAt,
      input.failingSince,
      input.failureCount,
      input.recoveryCount
    )
}

function prepareCheckResult(
  database: D1Database,
  input: {
    serviceId: string
    recordedAt: string
    status: 'up' | 'down'
    reason: string
    latencyMs?: number
  }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO check_results (id, service_id, recorded_at, status, reason, latency_ms, location_label)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      crypto.randomUUID(),
      input.serviceId,
      input.recordedAt,
      input.status,
      input.reason,
      input.latencyMs ?? null,
      'default'
    )
}

function prepareLatencyPoint(
  database: D1Database,
  input: { serviceId: string; recordedAt: string; latencyMs: number }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO latency_points (id, service_id, recorded_at, latency_ms, location_label)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind(crypto.randomUUID(), input.serviceId, input.recordedAt, input.latencyMs, 'default')
}

function prepareOpenIncident(
  database: D1Database,
  input: { id: string; serviceId: string; latestReason: string | null; openedAt: string }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO incidents (id, service_id, status, latest_reason, opened_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT DO NOTHING
      `
    )
    .bind(input.id, input.serviceId, 'open', input.latestReason, input.openedAt)
}

function prepareResolveIncident(
  database: D1Database,
  input: { serviceId: string; latestReason: string | null; resolvedAt: string }
): D1PreparedStatement {
  return database
    .prepare(
      `
        UPDATE incidents
        SET status = 'resolved', latest_reason = ?, resolved_at = ?
        WHERE service_id = ? AND status = 'open'
      `
    )
    .bind(input.latestReason, input.resolvedAt, input.serviceId)
}

function summarizeServiceResults(results: CheckRunResult[]): ServiceCheckSummary {
  const failed = results.find((result) => result.status === 'down')

  if (failed) {
    return {
      status: 'down',
      reason: failed.reason,
      latencyMs: failed.latencyMs,
    }
  }

  const latencyValues = results
    .map((result) => result.latencyMs)
    .filter((value): value is number => typeof value === 'number')

  return {
    status: 'up',
    reason: results[0]?.reason ?? 'Check completed successfully',
    latencyMs:
      latencyValues.length > 0
        ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
        : undefined,
  }
}

async function runServiceChecks(
  service: StatusService,
  fetcher: Fetcher,
  remoteProbeUrl?: string
): Promise<ServiceCheckSummary> {
  const results: CheckRunResult[] = []

  for (const check of service.checks) {
    results.push(await runConfiguredCheck(check, fetcher, undefined, remoteProbeUrl))
  }

  return summarizeServiceResults(results)
}

async function runServiceChecksConcurrently(
  services: StatusService[],
  fetcher: Fetcher,
  remoteProbeUrl?: string,
  onServiceFinished?: () => Promise<void>
): Promise<Array<{ service: StatusService; result: ServiceCheckSummary }>> {
  const results: Array<ServiceCheckSummary | undefined> = new Array(services.length)
  let nextIndex = 0

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= services.length) {
        return
      }

      try {
        results[index] = await runServiceChecks(services[index], fetcher, remoteProbeUrl)
      } catch (error) {
        results[index] = {
          status: 'down',
          reason: error instanceof Error ? error.message : 'Check execution failed',
        }
      }

      if (onServiceFinished) {
        await onServiceFinished()
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, services.length) }, () => consume())
  )

  return services.map((service, index) => ({
    service,
    result: results[index] ?? { status: 'down', reason: 'Check execution failed' },
  }))
}

function applyIncidentThreshold(
  mutation: IncidentMutation,
  failureCount: number,
  recoveryCount: number,
  service: StatusService
): IncidentMutation {
  const failureThreshold = service.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
  const recoveryThreshold = service.recoveryThreshold ?? DEFAULT_RECOVERY_THRESHOLD

  if (mutation.action === 'open' && failureCount < failureThreshold) {
    return { action: 'noop', status: null, latestReason: mutation.latestReason }
  }

  if (mutation.action === 'resolve' && recoveryCount < recoveryThreshold) {
    return { action: 'noop', status: 'open', latestReason: mutation.latestReason }
  }

  return mutation
}

function getFailingSince(
  previous: ServiceStatusRow | null,
  currentStatus: 'up' | 'down',
  checkedAt: string
): string | null {
  if (currentStatus === 'up') {
    return null
  }

  if (previous?.current_status === 'down' && previous.failing_since) {
    return previous.failing_since
  }

  return checkedAt
}

function gracePeriodSatisfied(
  failingSince: string | null,
  checkedAt: string,
  gracePeriodMinutes: number | undefined
): boolean {
  if (!failingSince) {
    return false
  }

  if (!gracePeriodMinutes || gracePeriodMinutes <= 0) {
    return true
  }

  return Date.parse(checkedAt) - Date.parse(failingSince) >= gracePeriodMinutes * 60_000
}

function isServiceUnderActiveMaintenance(
  config: ReturnType<typeof getRuntimeConfig>,
  serviceId: string,
  checkedAt: string
): boolean {
  const nowMs = Date.parse(checkedAt)

  return config.maintenances.some((entry) => {
    const appliesToService = !entry.services || entry.services.length === 0 || entry.services.includes(serviceId)
    if (!appliesToService) {
      return false
    }

    const startMs = Date.parse(entry.start)
    const endMs = entry.end ? Date.parse(entry.end) : undefined
    return startMs <= nowMs && (endMs === undefined || endMs > nowMs)
  })
}

async function pruneHistoricalData(database: D1Database, retentionDays: number, now: string): Promise<void> {
  const cutoff = new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  await database
    .prepare('DELETE FROM check_results WHERE recorded_at < ?')
    .bind(cutoff)
    .run()
  await database
    .prepare('DELETE FROM latency_points WHERE recorded_at < ?')
    .bind(cutoff)
    .run()
}

async function startSchedulerRun(database: D1Database, id: string, startedAt: string): Promise<void> {
  await database
    .prepare(
      `
        INSERT INTO scheduler_runs (id, started_at, status)
        VALUES (?, ?, 'running')
      `
    )
    .bind(id, startedAt)
    .run()
}

async function acquireSchedulerLease(database: D1Database, now: string, ownerId: string): Promise<boolean> {
  const lockedUntil = new Date(Date.parse(now) + SCHEDULER_LEASE_MS).toISOString()

  await database
    .prepare('INSERT OR IGNORE INTO scheduler_lease (id, locked_until, owner_id) VALUES (1, ?, NULL)')
    .bind(now)
    .run()

  const result = (await database
    .prepare(
      `
        UPDATE scheduler_lease
        SET locked_until = ?, owner_id = ?
        WHERE id = 1 AND locked_until <= ?
      `
    )
    .bind(lockedUntil, ownerId, now)
    .run()) as { meta?: { changes?: number } } | undefined

  return result?.meta?.changes === undefined || result.meta.changes > 0
}

async function renewSchedulerLease(database: D1Database, now: string, ownerId: string): Promise<boolean> {
  const lockedUntil = new Date(Date.parse(now) + SCHEDULER_LEASE_MS).toISOString()
  const result = (await database
    .prepare(
      `
        UPDATE scheduler_lease
        SET locked_until = ?
        WHERE id = 1 AND owner_id = ? AND locked_until > ?
      `
    )
    .bind(lockedUntil, ownerId, now)
    .run()) as { meta?: { changes?: number } } | undefined

  return result?.meta?.changes === undefined || result.meta.changes > 0
}

async function releaseSchedulerLease(database: D1Database, now: string, ownerId: string): Promise<void> {
  await database
    .prepare('UPDATE scheduler_lease SET locked_until = ?, owner_id = NULL WHERE id = 1 AND owner_id = ?')
    .bind(now, ownerId)
    .run()
}

async function finishSchedulerRun(
  database: D1Database,
  id: string,
  finishedAt: string,
  summary: ScheduledCheckSummary
): Promise<void> {
  await database
    .prepare(
      `
        UPDATE scheduler_runs
        SET status = 'succeeded', finished_at = ?, services_checked = ?, up_count = ?, down_count = ?
        WHERE id = ?
      `
    )
    .bind(finishedAt, summary.servicesChecked, summary.upCount, summary.downCount, id)
    .run()
}

async function failSchedulerRun(database: D1Database, id: string, finishedAt: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown scheduler error'

  await database
    .prepare(
      `
        UPDATE scheduler_runs
        SET status = 'failed', finished_at = ?, error_message = ?
        WHERE id = ?
      `
    )
    .bind(finishedAt, message, id)
    .run()
}

export async function runScheduledChecks(
  env: unknown,
  fetcher: Fetcher = globalThis.fetch,
  checkedAt = new Date().toISOString(),
  notificationFetcher: Fetcher = fetcher
): Promise<ScheduledCheckSummary> {
  const database = getWorkerDatabase(env)

  if (!database) {
    throw new Error('Missing PULSEFLARE_D1 binding')
  }

  const config = getRuntimeConfig(env)
  const remoteProbeUrl = getRemoteProbeUrl(env)
  const runId = crypto.randomUUID()

  await ensureBootstrapSchema(database)
  if (!(await acquireSchedulerLease(database, checkedAt, runId))) {
    return { servicesChecked: 0, upCount: 0, downCount: 0 }
  }

  let runStarted = false

  try {
    await startSchedulerRun(database, runId, checkedAt)
    runStarted = true
    await syncServices(database, config)

    let upCount = 0
    let downCount = 0
    const serviceResults = await runServiceChecksConcurrently(config.services, fetcher, remoteProbeUrl, async () => {
      if (!(await renewSchedulerLease(database, new Date().toISOString(), runId))) {
        throw new Error('Scheduler lease lost during service checks')
      }
    })

    for (const { service, result } of serviceResults) {
      if (!(await renewSchedulerLease(database, new Date().toISOString(), runId))) {
        throw new Error('Scheduler lease lost while persisting service results')
      }
      const previousStatus = await findServiceStatus(database, service.id)
      const failureCount =
        result.status === 'down'
          ? (previousStatus?.current_status === 'down' ? previousStatus.failure_count : 0) + 1
          : 0
      const recoveryCount =
        result.status === 'up'
          ? (previousStatus?.current_status === 'up' ? previousStatus.recovery_count : 0) + 1
          : 0
      const failingSince = getFailingSince(previousStatus, result.status, checkedAt)

      if (result.status === 'up') {
        upCount += 1
      } else {
        downCount += 1
      }

      const existingOpenIncident = await findOpenIncident(database, service.id)
      const thresholdedMutation = applyIncidentThreshold(
        deriveIncidentMutation({
          currentStatus: result.status,
          currentReason: result.reason,
          hasOpenIncident: Boolean(existingOpenIncident),
        }),
        failureCount,
        recoveryCount,
        service
      )
      const mutation =
        thresholdedMutation.action === 'open' &&
        !gracePeriodSatisfied(failingSince, checkedAt, config.notifications.gracePeriodMinutes)
          ? { action: 'noop', status: null, latestReason: thresholdedMutation.latestReason } as const
          : thresholdedMutation
      const statements: D1PreparedStatement[] = [
        prepareServiceStatus(database, {
          serviceId: service.id,
          status: result.status,
          latestReason: result.reason,
          checkedAt,
          failingSince,
          failureCount,
          recoveryCount,
        }),
        prepareCheckResult(database, {
          serviceId: service.id,
          recordedAt: checkedAt,
          status: result.status,
          reason: result.reason,
          latencyMs: result.latencyMs,
        }),
      ]

      if (typeof result.latencyMs === 'number') {
        statements.push(
          prepareLatencyPoint(database, {
            serviceId: service.id,
            recordedAt: checkedAt,
            latencyMs: result.latencyMs,
          })
        )
      }

      const suppressOpenNotification =
        mutation.action === 'open' && isServiceUnderActiveMaintenance(config, service.id, checkedAt)

      if (mutation.action === 'open') {
        statements.push(
          prepareOpenIncident(database, {
            id: crypto.randomUUID(),
            serviceId: service.id,
            latestReason: mutation.latestReason,
            openedAt: checkedAt,
          })
        )
      }

      if (mutation.action === 'resolve') {
        statements.push(
          prepareResolveIncident(database, {
            serviceId: service.id,
            latestReason: mutation.latestReason,
            resolvedAt: checkedAt,
          })
        )

        if (existingOpenIncident) {
          statements.push(
            prepareCancelPendingIncidentNotifications(database, existingOpenIncident.id),
            ...prepareNotificationDispatches(database, config, {
              mutation,
              incidentId: existingOpenIncident.id,
              serviceId: service.id,
              serviceName: service.name,
              occurredAt: checkedAt,
            })
          )
        }
      }

      await database.batch(statements)

      if (mutation.action === 'open' && !suppressOpenNotification) {
        const persistedIncident = await findOpenIncident(database, service.id)
        if (!persistedIncident) {
          throw new Error(`Open incident was not persisted for service ${service.id}`)
        }

        const notificationStatements = prepareNotificationDispatches(database, config, {
          mutation,
          incidentId: persistedIncident.id,
          serviceId: service.id,
          serviceName: service.name,
          occurredAt: checkedAt,
        })
        if (notificationStatements.length > 0) {
          await database.batch(notificationStatements)
        }
      }
    }

    if (config.notifications.providers.length > 0) {
      const secrets = Object.fromEntries(
        config.notifications.providers
          .filter((provider) => provider.secretName)
          .map((provider) => [provider.secretName as string, getWorkerSecret(env, provider.secretName as string)])
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      )
      await dispatchPendingNotifications(database, config, notificationFetcher, new Date(checkedAt), secrets)
    }

    await pruneHistoricalData(database, config.retentionDays ?? DEFAULT_RETENTION_DAYS, checkedAt)

    const summary = {
      servicesChecked: config.services.length,
      upCount,
      downCount,
    }
    await finishSchedulerRun(database, runId, checkedAt, summary)
    return summary
  } catch (error) {
    if (runStarted) {
      await failSchedulerRun(database, runId, new Date().toISOString(), error)
    }
    throw error
  } finally {
    await releaseSchedulerLease(database, new Date().toISOString(), runId)
  }
}
