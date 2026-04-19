import type { IncidentRecord, MaintenanceRecord } from '../lib/api'

type IncidentTimelineProps = {
  incidents: IncidentRecord[]
  maintenance?: MaintenanceRecord[]
  selectedService?: string
  title?: string
  eyebrow?: string
}

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

export function IncidentTimeline({
  incidents,
  maintenance = [],
  selectedService,
  title = 'Recent incidents',
  eyebrow = 'Incident log',
}: IncidentTimelineProps) {
  const visibleIncidents = filterEntriesByService(incidents, selectedService)
  const visibleMaintenance = filterEntriesByService(maintenance, selectedService)

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
        {visibleIncidents.map((incident) => (
          <article className="timeline-entry" key={incident.id}>
            <div className={`timeline-entry__marker timeline-entry__marker--${incident.impact}`} />
            <div className="timeline-entry__content">
              <div className="timeline-entry__header">
                <h3>{incident.title}</h3>
                <span className={`timeline-tag timeline-tag--${incident.status}`}>{incident.status}</span>
              </div>
              <p className="timeline-entry__time">Started {formatTimestamp(incident.startedAt)}</p>
              <p>{incident.summary}</p>
              {incident.resolvedAt ? (
                <p className="timeline-entry__footnote">Resolved {formatTimestamp(incident.resolvedAt)}</p>
              ) : null}
            </div>
          </article>
        ))}

        {visibleMaintenance.map((entry) => (
          <article className="timeline-entry" key={entry.id}>
            <div className="timeline-entry__marker timeline-entry__marker--maintenance" />
            <div className="timeline-entry__content">
              <div className="timeline-entry__header">
                <h3>{entry.title}</h3>
                <span className="timeline-tag timeline-tag--scheduled">Scheduled</span>
              </div>
              <p className="timeline-entry__time">{entry.window}</p>
              <p>{entry.summary}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
