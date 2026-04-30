import type { IncidentRecord, MaintenanceRecord } from '../lib/api'

type IncidentTimelineProps = {
  incidents: IncidentRecord[]
  maintenance?: MaintenanceRecord[]
  selectedService?: string
  title?: string
  eyebrow?: string
  maxEntries?: number
}

type TimelineEntry =
  | (IncidentRecord & { entryType: 'incident'; sortAt: string })
  | ({
      id: string
      title: string
      status: MaintenanceRecord['status']
      impact: 'maintenance'
      startedAt: string
      resolvedAt?: string
      summary: string
      services: string[]
      entryType: 'maintenance'
      sortAt: string
    })

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

function matchesService(services: string[], selectedService: string | undefined): boolean {
  if (!selectedService || selectedService === 'all') {
    return true
  }

  return services.includes(selectedService)
}

export function filterEntriesByService<T extends { services: string[] }>(
  entries: T[],
  selectedService: string | undefined
): T[] {
  return entries.filter((entry) => matchesService(entry.services, selectedService))
}

function getMaintenanceSortAt(entry: MaintenanceRecord): string {
  if (entry.status === 'completed') {
    return entry.end ?? entry.start
  }

  return entry.start
}

export function mergeTimelineEntries(
  incidents: IncidentRecord[],
  maintenance: MaintenanceRecord[]
): TimelineEntry[] {
  return [
    ...incidents.map((incident) => ({
      ...incident,
      entryType: 'incident' as const,
      sortAt: incident.startedAt,
    })),
    ...maintenance.map((entry) => ({
      id: entry.id,
      title: entry.title,
      status: entry.status,
      impact: 'maintenance' as const,
      startedAt: entry.start,
      resolvedAt: entry.status === 'completed' ? entry.end : undefined,
      summary: entry.body,
      services: entry.services,
      entryType: 'maintenance' as const,
      sortAt: getMaintenanceSortAt(entry),
    })),
  ].sort((left, right) => Date.parse(right.sortAt) - Date.parse(left.sortAt))
}

export function IncidentTimeline({
  incidents,
  maintenance = [],
  selectedService,
  title = 'Recent incidents',
  eyebrow = 'Incident log',
  maxEntries,
}: IncidentTimelineProps) {
  const visibleIncidents = filterEntriesByService(incidents, selectedService)
  const visibleMaintenance = filterEntriesByService(maintenance, selectedService)
  const entries = mergeTimelineEntries(visibleIncidents, visibleMaintenance)
  const visibleEntries = typeof maxEntries === 'number' ? entries.slice(0, maxEntries) : entries

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2>{title}</h2>
        </div>
        <p>Operator notes, maintenance windows, and recovery milestones share one timeline language.</p>
      </div>

      <div className="timeline">
        {visibleEntries.map((entry) => (
          <article className="timeline-entry" key={entry.id}>
            <div className={`timeline-entry__marker timeline-entry__marker--${entry.impact}`} />
            <div className="timeline-entry__content">
              <div className="timeline-entry__header">
                <h3>{entry.title}</h3>
                <span className={`timeline-tag timeline-tag--${entry.status}`}>{entry.status}</span>
              </div>
              <p className="timeline-entry__time">
                {entry.entryType === 'maintenance' ? 'Window starts ' : 'Started '}
                {formatTimestamp(entry.startedAt)}
              </p>
              <p>{entry.summary}</p>
              {entry.resolvedAt ? (
                <p className="timeline-entry__footnote">
                  {entry.entryType === 'maintenance' ? 'Ended ' : 'Resolved '}
                  {formatTimestamp(entry.resolvedAt)}
                </p>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
