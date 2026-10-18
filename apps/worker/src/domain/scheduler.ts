import type { StatusService } from '@pulseflare/schema'

import { getRemoteProbeToken, getRemoteProbeUrl, getWorkerDatabase, getWorkerSecret } from '../config'
import { getRuntimeConfig, syncServices } from '../install'
import { runConfiguredCheck, type CheckRunResult } from './check-runner'
import { deriveIncidentMutation, type IncidentMutation } from './incident-engine'
import { emitObservabilityEvent, getObservabilityError, type ObservabilityLogger } from '../observability'
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

type ServiceRuntimeStateRow = {
  service_id: string
  current_status: 'up' | 'down' | null
  failing_since: string | null
  failure_count: number | null
  recovery_count: number | null
  open_incident_id: string | null
  open_incident_status: 'open' | null
  open_incident_latest_reason: string | null
}

type ServiceRuntimeState = {
  previousStatus: ServiceStatusRow | null
  openIncident: OpenIncidentRow | null
}

type ServiceCheckSummary = {
  status: 'up' | 'down'
  reason: string
  latencyMs?: number
  checks: CheckRunResult[]
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
const LEASE_RENEW_INTERVAL_MS = 30_000

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

async function listServiceRuntimeStates(database: D1Database): Promise<Map<string, ServiceRuntimeState>> {
  const result = (await database
    .prepare(
      `
        SELECT services.id AS service_id,
               service_status.current_status,
               service_status.failing_since,
               service_status.failure_count,
               service_status.recovery_count,
               incidents.id AS open_incident_id,
               incidents.status AS open_incident_status,
               incidents.latest_reason AS open_incident_latest_reason
        FROM services
        LEFT JOIN service_status ON service_status.service_id = services.id
        LEFT JOIN incidents ON incidents.service_id = services.id AND incidents.status = 'open'
        WHERE services.is_active = 1
      `
    )
    .all<ServiceRuntimeStateRow>()) as { results?: ServiceRuntimeStateRow[] }

  return new Map(
    (result.results ?? []).map((row) => [
      row.service_id,
      {
        previousStatus:
          row.current_status === null
            ? null
            : {
                current_status: row.current_status,
                failing_since: row.failing_since,
                failure_count: row.failure_count ?? 0,
                recovery_count: row.recovery_count ?? 0,
              },
        openIncident: row.open_incident_id
          ? {
              id: row.open_incident_id,
              status: row.open_incident_status ?? 'open',
              latest_reason: row.open_incident_latest_reason,
            }
          : null,
      },
    ])
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

function prepareCheckResult(database: D1Database, input: CheckRunResult & { serviceId: string; recordedAt: string }): D1PreparedStatement {
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
      input.locationLabel ?? 'default'
    )
}

function prepareDailyCheckRollup(
  database: D1Database,
  input: {
    serviceId: string
    day: string
    locationLabel: string
    upCount: number
    downCount: number
    latencyMs: number | null
    latencyAt: string | null
  }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO daily_check_rollups (
          service_id, day, location_label, up_count, down_count, last_latency_ms, last_latency_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(service_id, day, location_label) DO UPDATE SET
          up_count = daily_check_rollups.up_count + excluded.up_count,
          down_count = daily_check_rollups.down_count + excluded.down_count,
          last_latency_ms = CASE
            WHEN excluded.last_latency_at IS NOT NULL
              AND (daily_check_rollups.last_latency_at IS NULL
                OR excluded.last_latency_at >= daily_check_rollups.last_latency_at)
            THEN excluded.last_latency_ms
            ELSE daily_check_rollups.last_latency_ms
          END,
          last_latency_at = CASE
            WHEN excluded.last_latency_at IS NOT NULL
              AND (daily_check_rollups.last_latency_at IS NULL
                OR excluded.last_latency_at >= daily_check_rollups.last_latency_at)
            THEN excluded.last_latency_at
            ELSE daily_check_rollups.last_latency_at
          END
      `
    )
    .bind(
      input.serviceId,
      input.day,
      input.locationLabel,
      input.upCount,
      input.downCount,
      input.latencyMs,
      input.latencyAt
    )
}

function prepareOpenIncident(
  database: D1Database,
  input: {
    id: string
    serviceId: string
    impact: StatusService['impact']
    latestReason: string | null
    openedAt: string
  }
): D1PreparedStatement {
  return database
    .prepare(
      `
        INSERT INTO incidents (id, service_id, status, impact, latest_reason, opened_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT DO NOTHING
      `
    )
    .bind(input.id, input.serviceId, 'open', input.impact ?? 'minor', input.latestReason, input.openedAt)
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

function summarizeServiceResults(
  results: CheckRunResult[],
  failurePolicy: StatusService['failurePolicy'] = 'all'
): ServiceCheckSummary {
  const locationHealth = new Map<string, boolean>()

  for (const result of results) {
    const location = result.locationLabel ?? 'default'
    locationHealth.set(location, (locationHealth.get(location) ?? true) && result.status === 'up')
  }

  const healthyLocations = [...locationHealth.values()].filter(Boolean).length
  const serviceIsUp =
    failurePolicy === 'majority'
      ? healthyLocations > locationHealth.size / 2
      : healthyLocations === locationHealth.size
  const failed = results.find((result) => result.status === 'down')

  const latencyValues = results
    .filter((result) => result.status === 'up')
    .map((result) => result.latencyMs)
    .filter((value): value is number => typeof value === 'number')

  return {
    status: serviceIsUp ? 'up' : 'down',
    reason: serviceIsUp
      ? failed
        ? `${healthyLocations} of ${locationHealth.size} probe locations passed`
        : (results[0]?.reason ?? 'Check completed successfully')
      : (failed?.reason ?? 'No probe locations passed'),
    latencyMs:
      latencyValues.length > 0
        ? Math.round(latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length)
        : undefined,
    checks: results,
  }
}

async function runConfiguredChecksConcurrently(
  services: StatusService[],
  fetcher: Fetcher,
  remoteProbeUrl?: string,
  remoteProbeToken?: string,
  onCheckFinished?: () => Promise<void>,
  logger: ObservabilityLogger = console
): Promise<Array<{ service: StatusService; result: ServiceCheckSummary }>> {
  const checkResults = services.map((service) => new Array<CheckRunResult>(service.checks.length))
  const tasks = services.flatMap((service, serviceIndex) =>
    service.checks.map((check, checkIndex) => ({ service, serviceIndex, check, checkIndex }))
  )
  let nextIndex = 0

  async function consume(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= tasks.length) {
        return
      }

      const task = tasks[index]
      try {
        const result = await runConfiguredCheck(task.check, fetcher, undefined, remoteProbeUrl, remoteProbeToken)
        checkResults[task.serviceIndex][task.checkIndex] = result

        if (result.status === 'down') {
          emitObservabilityEvent(
            'warn',
            'probe.failed',
            {
              serviceId: task.service.id,
              status: result.status,
              latencyMs: result.latencyMs,
              reason: getObservabilityError(result.reason),
            },
            logger
          )
        }
      } catch (error) {
        const failedResult: CheckRunResult = {
          status: 'down',
          reason: error instanceof Error ? error.message : 'Check execution failed',
        }
        checkResults[task.serviceIndex][task.checkIndex] = failedResult
        emitObservabilityEvent(
          'error',
          'probe.failed',
          {
            serviceId: task.service.id,
            status: 'down',
            error: getObservabilityError(error),
          },
          logger
        )
      }

      if (onCheckFinished) {
        await onCheckFinished()
      }
    }
  }

  const workerCount = Math.min(CHECK_CONCURRENCY, tasks.length)
  const settledWorkers = await Promise.allSettled(Array.from({ length: workerCount }, () => consume()))
  const workerFailure = settledWorkers.find((result) => result.status === 'rejected')
  if (workerFailure?.status === 'rejected') throw workerFailure.reason

  return services.map((service, index) => ({
    service,
    result: summarizeServiceResults(checkResults[index], service.failurePolicy),
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

const PRUNE_INTERVAL_MS = 24 * 60 * 60_000

async function pruneHistoricalData(database: D1Database, retentionDays: number, now: string): Promise<void> {
  const lease = await database
    .prepare('SELECT last_pruned_at FROM scheduler_lease WHERE id = 1')
    .first<{ last_pruned_at: string | null }>()

  if (lease?.last_pruned_at && Date.parse(now) - Date.parse(lease.last_pruned_at) < PRUNE_INTERVAL_MS) {
    return
  }

  const cutoff = new Date(Date.parse(now) - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  await database.batch([
    database.prepare('DELETE FROM check_results WHERE recorded_at < ?').bind(cutoff),
    database.prepare('DELETE FROM latency_points WHERE recorded_at < ?').bind(cutoff),
    database.prepare('DELETE FROM daily_check_rollups WHERE day < ?').bind(cutoff.slice(0, 10)),
    database.prepare('DELETE FROM scheduler_runs WHERE started_at < ?').bind(cutoff),
    database
      .prepare("DELETE FROM notification_outbox WHERE created_at < ? AND status IN ('delivered', 'failed')")
      .bind(cutoff),
    database.prepare('UPDATE scheduler_lease SET last_pruned_at = ? WHERE id = 1').bind(now),
  ])
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

function createSchedulerLeaseGuard(database: D1Database, ownerId: string) {
  let lastRenewalAt = Date.now()
  let renewalInFlight: Promise<void> | null = null
  let leaseLost: Error | null = null

  const renew = async (force = false): Promise<void> => {
    if (leaseLost) throw leaseLost

    if (renewalInFlight) {
      await renewalInFlight
      return
    }

    if (!force && Date.now() - lastRenewalAt < LEASE_RENEW_INTERVAL_MS) {
      return
    }

    renewalInFlight = (async () => {
      const renewed = await renewSchedulerLease(database, new Date().toISOString(), ownerId)
      if (!renewed) {
        leaseLost = new Error('Scheduler lease lost during run')
        throw leaseLost
      }
      lastRenewalAt = Date.now()
    })()

    try {
      await renewalInFlight
    } finally {
      renewalInFlight = null
    }
  }

  const timerId = setInterval(() => {
    void renew(true).catch(() => undefined)
  }, LEASE_RENEW_INTERVAL_MS)

  return {
    ensure: renew,
    async stop() {
      clearInterval(timerId)
      if (renewalInFlight) {
        await renewalInFlight.catch(() => undefined)
      }
    },
  }
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
  notificationFetcher: Fetcher = fetcher,
  logger: ObservabilityLogger = console
): Promise<ScheduledCheckSummary> {
  const database = getWorkerDatabase(env)

  if (!database) {
    throw new Error('Missing PULSEFLARE_D1 binding')
  }

  const config = getRuntimeConfig(env)
  const remoteProbeUrl = getRemoteProbeUrl(env)
  const remoteProbeToken = getRemoteProbeToken(env)
  const runId = crypto.randomUUID()

  emitObservabilityEvent('info', 'scheduler.run.started', {
    runId,
    servicesConfigured: config.services.length,
  }, logger)

  if (!(await acquireSchedulerLease(database, checkedAt, runId))) {
    emitObservabilityEvent('info', 'scheduler.run.skipped', { runId, reason: 'lease_not_acquired' }, logger)
    return { servicesChecked: 0, upCount: 0, downCount: 0 }
  }

  const leaseGuard = createSchedulerLeaseGuard(database, runId)
  let runStarted = false

  try {
    await leaseGuard.ensure()
    await startSchedulerRun(database, runId, checkedAt)
    runStarted = true
    await syncServices(database, config)
    const runtimeStates = await listServiceRuntimeStates(database)

    let upCount = 0
    let downCount = 0
    const serviceResults = await runConfiguredChecksConcurrently(
      config.services,
      fetcher,
      remoteProbeUrl,
      remoteProbeToken,
      () => leaseGuard.ensure(),
      logger
    )

    for (const { service, result } of serviceResults) {
      await leaseGuard.ensure()
      const runtimeState = runtimeStates.get(service.id)
      const previousStatus = runtimeState?.previousStatus ?? null
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

      const existingOpenIncident = runtimeState?.openIncident ?? null
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
      ]

      const checkCountsByLocation = new Map<
        string,
        { upCount: number; downCount: number; latencies: number[] }
      >()

      for (const checkResult of result.checks) {
        const locationLabel = checkResult.locationLabel ?? 'default'
        const locationCounts = checkCountsByLocation.get(locationLabel) ?? {
          upCount: 0,
          downCount: 0,
          latencies: [],
        }
        locationCounts[checkResult.status === 'up' ? 'upCount' : 'downCount'] += 1

        if (typeof checkResult.latencyMs === 'number') {
          locationCounts.latencies.push(checkResult.latencyMs)
        }

        checkCountsByLocation.set(locationLabel, locationCounts)

        if (checkResult.status === 'down') {
          statements.push(
            prepareCheckResult(database, {
              ...checkResult,
              serviceId: service.id,
              recordedAt: checkedAt,
            })
          )
        }
      }

      for (const [locationLabel, counts] of checkCountsByLocation) {
        statements.push(
          prepareDailyCheckRollup(database, {
            serviceId: service.id,
            day: checkedAt.slice(0, 10),
            locationLabel,
            upCount: counts.upCount,
            downCount: counts.downCount,
            latencyMs:
              counts.latencies.length > 0
                ? Math.round(counts.latencies.reduce((sum, value) => sum + value, 0) / counts.latencies.length)
                : null,
            latencyAt: counts.latencies.length > 0 ? checkedAt : null,
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
            impact: service.impact,
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

      if (mutation.action === 'resolve' && existingOpenIncident) {
        emitObservabilityEvent(
          'info',
          'incident.resolved',
          { incidentId: existingOpenIncident.id, serviceId: service.id },
          logger
        )
      }

      if (mutation.action === 'open' && !suppressOpenNotification) {
        const persistedIncident = await findOpenIncident(database, service.id)
        if (!persistedIncident) {
          throw new Error(`Open incident was not persisted for service ${service.id}`)
        }

        emitObservabilityEvent(
          'info',
          'incident.opened',
          {
            incidentId: persistedIncident.id,
            serviceId: service.id,
            notificationsSuppressed: suppressOpenNotification,
          },
          logger
        )

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
      await leaseGuard.ensure()
      await dispatchPendingNotifications(database, config, notificationFetcher, new Date(checkedAt), secrets, logger)
    }

    await leaseGuard.ensure()
    await pruneHistoricalData(database, config.retentionDays ?? DEFAULT_RETENTION_DAYS, checkedAt)

    const summary = {
      servicesChecked: config.services.length,
      upCount,
      downCount,
    }
    await leaseGuard.ensure()
    await finishSchedulerRun(database, runId, checkedAt, summary)
    emitObservabilityEvent('info', 'scheduler.run.completed', { runId, ...summary }, logger)
    return summary
  } catch (error) {
    if (runStarted) {
      await failSchedulerRun(database, runId, new Date().toISOString(), error)
      emitObservabilityEvent(
        'error',
        'scheduler.run.failed',
        { runId, error: getObservabilityError(error) },
        logger
      )
    }
    throw error
  } finally {
    await leaseGuard.stop()
    await releaseSchedulerLease(database, new Date().toISOString(), runId)
  }
}
