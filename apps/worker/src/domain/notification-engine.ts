import type { StatusNotificationProvider } from '@pulseflare/schema'

import type { IncidentMutation } from './incident-engine'

export type NotificationDispatch = {
  providerId: string
  event: 'incident_opened' | 'incident_resolved'
}

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
