import type { ServiceRecord, UptimeWindowState } from '../lib/api'

type ServiceGroupListProps = {
  services: ServiceRecord[]
}

function formatState(state: ServiceRecord['status']): string {
  return state === 'operational' ? 'Operational' : state === 'degraded' ? 'Degraded' : 'Outage'
}

function formatUptime(value: number): string {
  return `${value.toFixed(2)}%`
}

function formatWindowState(value: UptimeWindowState): string {
  return value === 'up' ? 'up' : value === 'degraded' ? 'degraded' : 'down'
}

export function ServiceGroupList({ services }: ServiceGroupListProps) {
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Live status</p>
          <h2>Uptime over the last 90 days</h2>
        </div>
        <p>Each row shows current state, latest response time, and a compact uptime timeline.</p>
      </div>

      <ul className="service-list service-list--stacked" role="list">
        {services.map((service) => (
          <li className="service-row" key={service.id}>
            <div className="service-row__top">
              <div className="service-row__identity">
                <h3>{service.name}</h3>
                <p>{service.target}</p>
              </div>
              <div className="service-row__summary">
                <strong>{formatUptime(service.uptimePercentage)}</strong>
                <span>{service.latencyMs} ms</span>
                <span className={`service-badge service-badge--${service.status}`}>{formatState(service.status)}</span>
              </div>
            </div>

            <div aria-label={`${service.name} uptime history`} className="uptime-strip" role="img">
              {service.history.map((window, index) => (
                <span
                  className={`uptime-strip__bar uptime-strip__bar--${formatWindowState(window)}`}
                  key={`${service.id}-${index}`}
                />
              ))}
            </div>

            <p className="service-row__notes">{service.notes}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
