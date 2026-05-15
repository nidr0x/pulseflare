import type { ServiceRecord, UptimeWindowState } from '../lib/api'

type ServiceGroupListProps = {
  services: ServiceRecord[]
}

function formatState(state: ServiceRecord['status']): string {
  return state === 'operational'
    ? 'Operational'
    : state === 'degraded'
      ? 'Degraded'
      : state === 'unknown'
        ? 'Waiting'
        : 'Outage'
}

function formatUptime(value: number): string {
  return `${value.toFixed(2)}%`
}

function formatWindowState(value: UptimeWindowState): string {
  return value === 'up' ? 'up' : value === 'degraded' ? 'degraded' : value === 'unknown' ? 'unknown' : 'down'
}

export function ServiceGroupList({ services }: ServiceGroupListProps) {
  const groups = Array.from(
    services.reduce((map, service) => {
      const key = service.group ?? 'Other'
      const current = map.get(key)
      if (current) {
        current.push(service)
      } else {
        map.set(key, [service])
      }
      return map
    }, new Map<string, ServiceRecord[]>())
  )

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Live status</p>
          <h2>Uptime over the last 90 days</h2>
        </div>
        <p>Each row shows current state, latest response time, and a compact uptime timeline.</p>
      </div>

      <div className="service-groups">
        {groups.map(([groupName, groupServices]) => (
          <section className="service-group" key={groupName}>
            <div className="service-group__heading">
              <h3>{groupName}</h3>
              <p>{groupServices.length} service{groupServices.length === 1 ? '' : 's'}</p>
            </div>

            <ul className="service-list service-list--stacked" role="list">
              {groupServices.map((service) => (
                <li className="service-row" key={service.id}>
                  <div className="service-row__top">
                    <div className="service-row__identity">
                      <h4>{service.name}</h4>
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
        ))}
      </div>
    </section>
  )
}
