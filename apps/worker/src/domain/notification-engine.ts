import type { StatusConfig, StatusNotificationProvider } from '@pulseflare/schema'

import type { IncidentMutation } from './incident-engine'
import { emitObservabilityEvent, getObservabilityError, type ObservabilityLogger } from '../observability'

export type NotificationDispatch = {
  providerId: string
  event: 'incident_opened' | 'incident_resolved'
}

type NotificationEvent = NotificationDispatch['event']

type NotificationPayload = {
  event: NotificationEvent
  incidentId: string
  serviceId: string
  serviceName?: string
  reason: string | null
  occurredAt: string
  status: 'open' | 'resolved'
}

type NotificationOutboxRow = {
  id: string
  provider_id: string
  event: NotificationEvent
  incident_id: string
  service_id: string
  payload_json: string
  attempts: number
}

const MAX_NOTIFICATION_ATTEMPTS = 5
const NOTIFICATION_BATCH_SIZE = 20
const NOTIFICATION_CLAIM_MS = 2 * 60_000

export function buildNotificationDispatches(
  mutation: IncidentMutation,
  providers: StatusNotificationProvider[]
): NotificationDispatch[] {
  if (mutation.action === 'noop') {
    return []
  }

  const event = mutation.action === 'open' ? 'incident_opened' : 'incident_resolved'

  return providers.map((provider) => ({
    providerId: provider.id,
    event,
  }))
}

type NotificationPayloadContext = {
  event: NotificationDispatch['event']
  serviceId: string
  serviceName: string
  status: 'up' | 'down'
  reason: string | null
  checkedAt: string
}

function interpolateTemplateValue(value: unknown, context: NotificationPayloadContext): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll('$EVENT', context.event)
      .replaceAll('$SERVICE_ID', context.serviceId)
      .replaceAll('$SERVICE_NAME', context.serviceName)
      .replaceAll('$STATUS', context.status)
      .replaceAll('$REASON', context.reason ?? '')
      .replaceAll('$CHECKED_AT', context.checkedAt)
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateTemplateValue(item, context))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateTemplateValue(item, context)])
    )
  }

  return value
}

function buildProviderBody(
  provider: StatusNotificationProvider,
  context: NotificationPayloadContext
): Record<string, unknown> {
  if (provider.bodyTemplate) {
    return interpolateTemplateValue(provider.bodyTemplate, context) as Record<string, unknown>
  }

  return {
    event: context.event,
    serviceId: context.serviceId,
    serviceName: context.serviceName,
    status: context.status,
    reason: context.reason,
    checkedAt: context.checkedAt,
  }
}

export async function dispatchNotification(
  provider: StatusNotificationProvider,
  context: NotificationPayloadContext,
  fetcher: typeof fetch = globalThis.fetch
): Promise<void> {
  const method = provider.method ?? 'POST'
  const body = buildProviderBody(provider, context)
  const headers = new Headers(provider.headers)

  if (method === 'GET') {
    const url = new URL(provider.url)
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
      }
    }

    await fetcher(url.toString(), { method: 'GET', headers })
    return
  }

  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  await fetcher(provider.url, {
    method,
    headers,
    body: JSON.stringify(body),
  })
}

export function prepareNotificationDispatches(
  database: D1Database,
  config: StatusConfig,
  input: {
    mutation: IncidentMutation
    incidentId: string
    serviceId: string
    serviceName?: string
    occurredAt: string
  }
): D1PreparedStatement[] {
  const dispatches = buildNotificationDispatches(input.mutation, config.notifications.providers)

  if (dispatches.length === 0) {
    return []
  }

  const status = input.mutation.action === 'open' ? 'open' : 'resolved'
  const gracePeriodMinutes = config.notifications.gracePeriodMinutes ?? 0
  const nextAttemptAt = new Date(
    Date.parse(input.occurredAt) + (status === 'open' ? gracePeriodMinutes * 60_000 : 0)
  ).toISOString()
  const payload: NotificationPayload = {
    event: dispatches[0].event,
    incidentId: input.incidentId,
    serviceId: input.serviceId,
    serviceName: input.serviceName ?? input.serviceId,
    reason: input.mutation.latestReason,
    occurredAt: input.occurredAt,
    status,
  }

  return dispatches.map((dispatch) =>
    database
      .prepare(
        `
          INSERT INTO notification_outbox (
            id, provider_id, event, incident_id, service_id, payload_json,
            status, attempts, next_attempt_at, last_error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?)
          ON CONFLICT DO NOTHING
        `
      )
      .bind(
        crypto.randomUUID(),
        dispatch.providerId,
        dispatch.event,
        input.incidentId,
        input.serviceId,
        JSON.stringify({ ...payload, event: dispatch.event }),
        nextAttemptAt,
        input.occurredAt
      )
  )
}

export async function enqueueNotificationDispatches(
  database: D1Database,
  config: StatusConfig,
  input: {
    mutation: IncidentMutation
    incidentId: string
    serviceId: string
    occurredAt: string
  }
): Promise<void> {
  const statements = prepareNotificationDispatches(database, config, input)

  if (statements.length > 0) {
    await database.batch(statements)
  }
}

export function prepareCancelPendingIncidentNotifications(
  database: D1Database,
  incidentId: string
): D1PreparedStatement {
  return database
    .prepare(
      `
        UPDATE notification_outbox
        SET status = 'failed', last_error = 'Incident resolved during notification grace period',
            claimed_by = NULL, claimed_until = NULL
        WHERE incident_id = ? AND event = 'incident_opened' AND status IN ('pending', 'retrying')
      `
    )
    .bind(incidentId)
}

export async function cancelPendingIncidentNotifications(
  database: D1Database,
  incidentId: string
): Promise<void> {
  await prepareCancelPendingIncidentNotifications(database, incidentId).run()
}

function getProvider(providers: StatusNotificationProvider[], providerId: string): StatusNotificationProvider | undefined {
  return providers.find((provider) => provider.id === providerId)
}

function getWebhookBody(provider: StatusNotificationProvider, payload: NotificationPayload): string | undefined {
  if (provider.method === 'GET') {
    return undefined
  }

  if (!provider.bodyTemplate) {
    return JSON.stringify(payload)
  }

  return JSON.stringify(
    buildProviderBody(provider, {
      event: payload.event,
      serviceId: payload.serviceId,
      serviceName: payload.serviceName ?? payload.serviceId,
      status: payload.status === 'open' ? 'down' : 'up',
      reason: payload.reason,
      checkedAt: payload.occurredAt,
    })
  )
}

async function deliverNotification(
  provider: StatusNotificationProvider,
  payload: NotificationPayload,
  fetcher: typeof fetch,
  secrets: Record<string, string>
): Promise<void> {
  const method = provider.method ?? 'POST'
  const headers = new Headers(provider.headers)

  if (provider.secretName) {
    const secret = secrets[provider.secretName]

    if (!secret) {
      throw new Error(`Missing notification secret: ${provider.secretName}`)
    }

    headers.set(
      provider.secretHeader ?? 'authorization',
      `${provider.secretPrefix ?? 'Bearer '}${secret}`
    )
  }

  if (method !== 'GET' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  const requestUrl = new URL(provider.url)
  if (method === 'GET') {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== null) {
        requestUrl.searchParams.set(key, String(value))
      }
    }
  }

  const response = await fetcher(requestUrl.toString(), {
    method,
    headers,
    body: getWebhookBody(provider, payload),
  })

  if (!response.ok) {
    throw new Error(`Webhook returned HTTP ${response.status}`)
  }
}

function getRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 2 ** Math.max(0, attempts - 1) * 60_000)
}

async function markNotificationFailure(
  database: D1Database,
  row: NotificationOutboxRow,
  error: unknown,
  now: Date,
  claimId: string
): Promise<{ status: 'retrying' | 'failed'; attempts: number }> {
  const attempts = row.attempts + 1
  const status = attempts >= MAX_NOTIFICATION_ATTEMPTS ? 'failed' : 'retrying'
  const reason = error instanceof Error ? error.message.slice(0, 500) : 'Unknown notification delivery error'
  const nextAttemptAt = new Date(now.getTime() + getRetryDelayMs(attempts)).toISOString()

  await database
    .prepare(
      `
        UPDATE notification_outbox
        SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?,
            claimed_by = NULL, claimed_until = NULL
        WHERE id = ? AND claimed_by = ?
      `
    )
    .bind(status, attempts, nextAttemptAt, reason, row.id, claimId)
    .run()

  return { status, attempts }
}

async function claimNotification(
  database: D1Database,
  rowId: string,
  claimId: string,
  now: Date
): Promise<boolean> {
  const claimedUntil = new Date(now.getTime() + NOTIFICATION_CLAIM_MS).toISOString()
  const result = (await database
    .prepare(
      `
        UPDATE notification_outbox
        SET claimed_by = ?, claimed_until = ?
        WHERE id = ?
          AND status IN ('pending', 'retrying')
          AND next_attempt_at <= ?
          AND (claimed_until IS NULL OR claimed_until <= ?)
      `
    )
    .bind(claimId, claimedUntil, rowId, now.toISOString(), now.toISOString())
    .run()) as { meta?: { changes?: number } } | undefined

  return result?.meta?.changes === undefined || result.meta.changes > 0
}

export async function dispatchPendingNotifications(
  database: D1Database,
  config: StatusConfig,
  fetcher: typeof fetch = globalThis.fetch,
  now = new Date(),
  secrets: Record<string, string> = {},
  logger: ObservabilityLogger = console
): Promise<void> {
  const result = (await database
    .prepare(
      `
        SELECT id, provider_id, event, incident_id, service_id, payload_json, attempts
        FROM notification_outbox
        WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ?
          AND (claimed_until IS NULL OR claimed_until <= ?)
        ORDER BY created_at ASC
        LIMIT ?
      `
    )
    .bind(now.toISOString(), now.toISOString(), NOTIFICATION_BATCH_SIZE)
    .all()) as { results?: NotificationOutboxRow[] }

  const claimId = crypto.randomUUID()

  for (const row of result.results ?? []) {
    if (!(await claimNotification(database, row.id, claimId, now))) {
      continue
    }

    const provider = getProvider(config.notifications.providers, row.provider_id)

    if (!provider) {
      const failure = await markNotificationFailure(
        database,
        row,
        new Error('Notification provider is not configured'),
        now,
        claimId
      )
      emitObservabilityEvent(
        'error',
        'notification.failed',
        {
          providerId: row.provider_id,
          notificationEvent: row.event,
          incidentId: row.incident_id,
          attempts: failure.attempts,
          status: failure.status,
          error: 'Notification provider is not configured',
        },
        logger
      )
      continue
    }

    try {
      await deliverNotification(provider, JSON.parse(row.payload_json) as NotificationPayload, fetcher, secrets)
      await database
        .prepare(
          `
            UPDATE notification_outbox
            SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_error = NULL,
                claimed_by = NULL, claimed_until = NULL
            WHERE id = ? AND claimed_by = ?
          `
        )
        .bind(now.toISOString(), row.id, claimId)
        .run()
      emitObservabilityEvent(
        'info',
        'notification.delivered',
        {
          providerId: row.provider_id,
          notificationEvent: row.event,
          incidentId: row.incident_id,
          attempts: row.attempts + 1,
        },
        logger
      )
    } catch (error) {
      const failure = await markNotificationFailure(database, row, error, now, claimId)
      emitObservabilityEvent(
        'error',
        'notification.failed',
        {
          providerId: row.provider_id,
          notificationEvent: row.event,
          incidentId: row.incident_id,
          attempts: failure.attempts,
          status: failure.status,
          error: getObservabilityError(error),
        },
        logger
      )
    }
  }
}
