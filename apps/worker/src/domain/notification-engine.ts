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
