export type IncidentState = 'open' | 'resolved'

export type IncidentMutation =
  | { action: 'open'; status: IncidentState; latestReason: string | null }
  | { action: 'resolve'; status: IncidentState; latestReason: string | null }
  | { action: 'noop'; status: IncidentState | null; latestReason: string | null }

export function deriveIncidentMutation(input: {
  currentStatus: 'up' | 'down'
  currentReason?: string | null
  hasOpenIncident: boolean
}): IncidentMutation {
  if (input.currentStatus === 'down' && !input.hasOpenIncident) {
    return {
      action: 'open',
      status: 'open',
      latestReason: input.currentReason ?? null,
    }
  }

  if (input.currentStatus === 'up' && input.hasOpenIncident) {
    return {
      action: 'resolve',
      status: 'resolved',
      latestReason: input.currentReason ?? null,
    }
  }

  return {
    action: 'noop',
    status: input.hasOpenIncident ? 'open' : null,
    latestReason: input.currentReason ?? null,
  }
}
