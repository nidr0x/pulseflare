import type { StatusService } from '@pulseflare/schema'

import { getWorkerDatabase } from '../config'
import { ensureBootstrapSchema, getRuntimeConfig, syncServices } from '../install'
import { runConfiguredCheck, type CheckRunResult } from './check-runner'
import { deriveIncidentMutation } from './incident-engine'

type Fetcher = typeof fetch

type OpenIncidentRow = {
  id: string
  status: 'open'
  latest_reason: string | null
}

export type ScheduledCheckSummary = {
  servicesChecked: number
  upCount: number
  downCount: number
}

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

async function upsertServiceStatus(
  database: D1Database,
  input: { serviceId: string; status: 'up' | 'down'; latestReason: string | null; checkedAt: string }
): Promise<void> {
  await database
    .prepare(
      `
        INSERT INTO service_status (service_id, current_status, latest_reason, checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(service_id) DO UPDATE SET
          current_status = excluded.current_status,
          latest_reason = excluded.latest_reason,
          checked_at = excluded.checked_at
      `
    )
    .bind(input.serviceId, input.status, input.latestReason, input.checkedAt)
    .run()
}

async function writeLatencyPoint(
  database: D1Database,
  input: { serviceId: string; recordedAt: string; latencyMs: number }
): Promise<void> {
  await database
    .prepare(
      `
        INSERT INTO latency_points (id, service_id, recorded_at, latency_ms, location_label)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .bind(crypto.randomUUID(), input.serviceId, input.recordedAt, input.latencyMs, 'default')
    .run()
}

async function openIncident(
  database: D1Database,
  input: { serviceId: string; latestReason: string | null; openedAt: string }
): Promise<void> {
  await database
    .prepare(
      `
        INSERT INTO incidents (id, service_id, status, latest_reason, opened_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, NULL)
      `
    )
    .bind(crypto.randomUUID(), input.serviceId, 'open', input.latestReason, input.openedAt)
    .run()
}

async function resolveIncident(
  database: D1Database,
  input: { serviceId: string; latestReason: string | null; resolvedAt: string }
): Promise<void> {
  await database
    .prepare(
      `
        UPDATE incidents
        SET status = 'resolved', latest_reason = ?, resolved_at = ?
        WHERE service_id = ? AND status = 'open'
      `
    )
    .bind(input.latestReason, input.resolvedAt, input.serviceId)
    .run()
}

function summarizeServiceResults(results: CheckRunResult[]): { status: 'up' | 'down'; reason: string; latencyMs?: number } {
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

async function runServiceChecks(service: StatusService, fetcher: Fetcher): Promise<ReturnType<typeof summarizeServiceResults>> {
  const results: CheckRunResult[] = []

  for (const check of service.checks) {
    results.push(await runConfiguredCheck(check, fetcher))
  }

  return summarizeServiceResults(results)
}

export async function runScheduledChecks(
  env: unknown,
  fetcher: Fetcher = globalThis.fetch,
  checkedAt = new Date().toISOString()
): Promise<ScheduledCheckSummary> {
  const database = getWorkerDatabase(env)

  if (!database) {
    throw new Error('Missing PULSEFLARE_D1 binding')
  }

  const config = getRuntimeConfig(env)

  await ensureBootstrapSchema(database)
  await syncServices(database, config)

  let upCount = 0
  let downCount = 0

  for (const service of config.services) {
    const result = await runServiceChecks(service, fetcher)

    if (result.status === 'up') {
      upCount += 1
    } else {
      downCount += 1
    }

    await upsertServiceStatus(database, {
      serviceId: service.id,
      status: result.status,
      latestReason: result.reason,
      checkedAt,
    })

    if (typeof result.latencyMs === 'number') {
      await writeLatencyPoint(database, {
        serviceId: service.id,
        recordedAt: checkedAt,
        latencyMs: result.latencyMs,
      })
    }

    const existingOpenIncident = await findOpenIncident(database, service.id)
    const mutation = deriveIncidentMutation({
      currentStatus: result.status,
      currentReason: result.reason,
      hasOpenIncident: Boolean(existingOpenIncident),
    })

    if (mutation.action === 'open') {
      await openIncident(database, {
        serviceId: service.id,
        latestReason: mutation.latestReason,
        openedAt: checkedAt,
      })
    }

    if (mutation.action === 'resolve') {
      await resolveIncident(database, {
        serviceId: service.id,
        latestReason: mutation.latestReason,
        resolvedAt: checkedAt,
      })
    }
  }

  return {
    servicesChecked: config.services.length,
    upCount,
    downCount,
  }
}
