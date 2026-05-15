import type { MaintenanceRecord } from '../lib/api'

type MaintenanceBannerProps = {
  maintenance: MaintenanceRecord[]
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

export function MaintenanceBanner({ maintenance }: MaintenanceBannerProps) {
  const entries = maintenance
    .filter((entry) => entry.status === 'scheduled' || entry.status === 'in_progress')
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))

  if (entries.length === 0) {
    return null
  }

  return (
    <section className="panel maintenance-banner">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Maintenance</p>
          <h2>Upcoming maintenance</h2>
        </div>
        <p>Scheduled work stays visible on the status page without mixing it into the uptime rows.</p>
      </div>

      <div className="maintenance-banner__list">
        {entries.map((entry) => (
          <article className="maintenance-banner__entry" key={entry.id}>
            <div className="maintenance-banner__header">
              <h3>{entry.title}</h3>
              <span className={`timeline-tag timeline-tag--${entry.status}`}>{entry.status}</span>
            </div>
            <p className="maintenance-banner__time">
              {entry.status === 'in_progress' ? 'In progress since ' : 'Starts '}
              {formatTimestamp(entry.start)}
            </p>
            <p>{entry.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
