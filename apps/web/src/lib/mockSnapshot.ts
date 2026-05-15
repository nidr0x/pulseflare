import type { StatusSnapshot, UptimeWindowState } from './api'

function buildHistory(
  length: number,
  overrides: Array<{ index: number; state: UptimeWindowState }>
): UptimeWindowState[] {
  const history: UptimeWindowState[] = Array.from({ length }, () => 'up')

  for (const override of overrides) {
    if (override.index >= 0 && override.index < length) {
      history[override.index] = override.state
    }
  }

  return history
}

export const MOCK_STATUS_SNAPSHOT: StatusSnapshot = {
  product: {
    name: 'Pulseflare',
    strapline: 'Simple public uptime monitoring on Cloudflare.',
    description: 'Live service health, incident updates, and 90-day uptime history in one public page.',
  },
  summary: {
    status: 'operational',
    checkedAt: '2026-04-18T15:42:00.000Z',
    upCount: 5,
    downCount: 0,
    totalCount: 5,
  },
  services: [
    {
      id: 'edge-api',
      name: 'API',
      group: 'Core platform',
      target: 'api.pulseflare.dev',
      status: 'operational',
      uptimePercentage: 100,
      latencyMs: 118,
      history: buildHistory(90, []),
      notes: 'Primary public API health endpoint.',
    },
    {
      id: 'status-site',
      name: 'Dashboard',
      group: 'Core platform',
      target: 'status.pulseflare.dev',
      status: 'operational',
      uptimePercentage: 100,
      latencyMs: 84,
      history: buildHistory(90, []),
      notes: 'Public status page and cached summaries.',
    },
    {
      id: 'checks-engine',
      name: 'Heartbeat app',
      group: 'Monitoring',
      target: 'checks.pulseflare.dev',
      status: 'operational',
      uptimePercentage: 99.96,
      latencyMs: 147,
      history: buildHistory(90, [{ index: 17, state: 'degraded' }]),
      notes: 'Scheduled probe fleet and state fan-out.',
    },
    {
      id: 'alerts-pipeline',
      name: 'Monitoring Engine',
      group: 'Monitoring',
      target: 'alerts.pulseflare.dev',
      status: 'operational',
      uptimePercentage: 99.87,
      latencyMs: 231,
      history: buildHistory(90, [
        { index: 65, state: 'degraded' },
        { index: 66, state: 'degraded' },
        { index: 67, state: 'down' },
        { index: 68, state: 'degraded' },
      ]),
      notes: 'Recent alert delivery slowdown has recovered and is being watched.',
    },
    {
      id: 'analytics-export',
      name: 'Website',
      group: 'Public web',
      target: 'www.pulseflare.dev',
      status: 'operational',
      uptimePercentage: 99.93,
      latencyMs: 164,
      history: buildHistory(90, [{ index: 22, state: 'degraded' }]),
      notes: 'Marketing site and docs landing pages.',
    },
  ],
  incidents: [
    {
      id: 'inc-241',
      title: 'Webhook notifications delayed for some destinations',
      status: 'monitoring',
      impact: 'minor',
      startedAt: '2026-04-18T14:05:00.000Z',
      summary:
        'Retries are succeeding, but delivery times are elevated while the queue drains after a regional backlog.',
      services: ['alerts-pipeline'],
    },
    {
      id: 'inc-238',
      title: 'Regional probe saturation in Frankfurt',
      status: 'resolved',
      impact: 'major',
      startedAt: '2026-04-17T08:12:00.000Z',
      resolvedAt: '2026-04-17T09:01:00.000Z',
      summary:
        'Some checks reported false negatives while load was shifted away from one probe cluster.',
      services: ['checks-engine', 'edge-api'],
    },
  ],
  maintenance: [
    {
      id: 'mnt-31',
      title: 'D1 compaction window',
      body: 'Reporting exports may trail by up to 10 minutes while historical indexes are rebuilt.',
      start: '2026-04-20T22:00:00.000Z',
      end: '2026-04-20T23:30:00.000Z',
      status: 'scheduled',
      services: ['analytics-export'],
    },
    {
      id: 'mnt-32',
      title: 'Webhook delivery certificate rollover',
      body: 'Callbacks continue normally, but some destinations may show a brief TLS re-negotiation.',
      start: '2026-04-23T05:00:00.000Z',
      end: '2026-04-23T05:30:00.000Z',
      status: 'completed',
      services: ['alerts-pipeline'],
    },
  ],
}
