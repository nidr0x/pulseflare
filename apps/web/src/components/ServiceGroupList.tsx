import { memo } from 'react'

import type { ServiceRecord, SnapshotLoadState, UptimeWindowState } from '../lib/api'

type ServiceGroupListProps = {
  services: ServiceRecord[]
  loadState?: SnapshotLoadState
}

function areServiceRecordsEqual(left: ServiceRecord, right: ServiceRecord): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.group === right.group &&
    left.status === right.status &&
    left.uptimePercentage === right.uptimePercentage &&
    left.latencyMs === right.latencyMs &&
    left.notes === right.notes &&
    left.history.length === right.history.length &&
    left.history.every((state, index) => state === right.history[index]) &&
    left.historyDays?.length === right.historyDays?.length &&
    (left.historyDays ?? []).every((day, index) => day === right.historyDays?.[index]) &&
    left.locations.length === right.locations.length &&
    left.locations.every((location, index) => {
      const other = right.locations[index]
      return (
        other !== undefined &&
        location.label === other.label &&
        location.uptimePercentage === other.uptimePercentage &&
        location.latencyMs === other.latencyMs &&
        location.history.length === other.history.length &&
        location.history.every((state, historyIndex) => state === other.history[historyIndex])
      )
    })
  )
}

function areServiceGroupListPropsEqual(previous: ServiceGroupListProps, next: ServiceGroupListProps): boolean {
  const servicesEqual =
    previous.services.length === next.services.length &&
    previous.services.every((service, index) => {
      const nextService = next.services[index]
      return nextService !== undefined && areServiceRecordsEqual(service, nextService)
    })

  if (!servicesEqual) return false

  return previous.services.length > 0 || previous.loadState === next.loadState
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

function formatWindowLabel(value: UptimeWindowState): string {
  return value === 'up' ? 'Operational' : value === 'degraded' ? 'Degraded' : value === 'down' ? 'Outage' : 'No data'
}

function formatHistoryDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`))
}

function formatShortDate(value: string | undefined): string {
  if (!value) return 'Unknown date'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${value}T12:00:00Z`)
  )
}

function summarizeHistory(history: UptimeWindowState[]): Record<UptimeWindowState, number> {
  return history.reduce(
    (summary, state) => {
      summary[state] += 1
      return summary
    },
    { up: 0, degraded: 0, down: 0, unknown: 0 }
  )
}

export const ServiceGroupList = memo(function ServiceGroupList({
  services,
  loadState = 'ready',
}: ServiceGroupListProps) {
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
        <p>Each row shows current state, median regional response time, and a compact uptime timeline.</p>
      </div>

      <div className="service-groups">
        {groups.map(([groupName, groupServices]) => (
          <section className="service-group" key={groupName}>
            <div className="service-group__heading">
              <h3>{groupName}</h3>
              <p>{groupServices.length} service{groupServices.length === 1 ? '' : 's'}</p>
            </div>

            <ul className="service-list service-list--stacked" role="list">
              {groupServices.map((service) => {
                const locations = service.locations ?? []

                return (
                  <li className="service-row" key={service.id}>
                    <div className="service-row__top">
                      <div className="service-row__identity">
                        <h4>{service.name}</h4>
                      </div>
                      <div className="service-row__summary">
                        <strong>
                          {service.uptimePercentage === null ? '--' : formatUptime(service.uptimePercentage)}
                        </strong>
                        <span>{service.latencyMs === null ? '--' : `${service.latencyMs} ms median`}</span>
                        <span className={`service-badge service-badge--${service.status}`}>
                          {formatState(service.status)}
                        </span>
                      </div>
                    </div>

                    {(() => {
                      const historySummary = summarizeHistory(service.history)
                      const historyDays = service.historyDays ?? []
                      const startDay = historyDays[0]
                      const endDay = historyDays.at(-1)

                      return (
                        <figure className="uptime-chart">
                          <figcaption className="uptime-chart__summary">
                            <span>
                              {service.history.length}-day history · {formatShortDate(startDay)}–{formatShortDate(endDay)}
                            </span>
                            <span>
                              {historySummary.up} operational · {historySummary.degraded} degraded · {historySummary.down}{' '}
                              outages · {historySummary.unknown} no data
                            </span>
                          </figcaption>
                          <div className="uptime-chart__scroll" tabIndex={0} aria-label={`${service.name} uptime chart, scroll horizontally to inspect all days`}>
                            <ul className="uptime-strip" aria-label={`${service.name} daily uptime history`}>
                              {service.history.map((window, index) => {
                                const day = historyDays[index]
                                const label = `${day ? formatHistoryDate(day) : `Day ${index + 1}`}: ${formatWindowLabel(window)}`

                                return (
                                  <li className="uptime-strip__item" aria-label={label} title={label} key={`${service.id}-${day ?? index}`}>
                                    <time className="sr-only" dateTime={day}>{label}</time>
                                    <span
                                      aria-hidden="true"
                                      className={`uptime-strip__bar uptime-strip__bar--${formatWindowState(window)}`}
                                    />
                                  </li>
                                )
                              })}
                            </ul>
                          </div>
                          <div className="uptime-chart__axis" aria-hidden="true">
                            <span>{formatShortDate(startDay)}</span>
                            <span>Today</span>
                          </div>
                          <ul className="uptime-legend" aria-label="Uptime chart legend">
                            {([
                              ['up', 'Operational'],
                              ['degraded', 'Degraded'],
                              ['down', 'Outage'],
                              ['unknown', 'No data'],
                            ] as const).map(([state, label]) => (
                              <li key={state}>
                                <span className={`uptime-legend__swatch uptime-legend__swatch--${formatWindowState(state)}`} aria-hidden="true" />
                                {label}
                              </li>
                            ))}
                          </ul>
                        </figure>
                      )
                    })()}

                    {locations.length > 0 ? (
                      <div aria-label={`${service.name} regional health`} className="service-locations">
                        <span className="service-locations__label">Regional health</span>
                        {locations.map((location) => {
                          const latestState = location.history.at(-1) ?? 'unknown'

                          return (
                            <span
                              className={`service-location service-location--${formatWindowState(latestState)}`}
                              key={`${service.id}-${location.label}`}
                            >
                              <span>{location.label}</span>
                              <strong>
                                {location.uptimePercentage === null
                                  ? '--'
                                  : formatUptime(location.uptimePercentage)}
                              </strong>
                              <span>{location.latencyMs === null ? '--' : `${location.latencyMs} ms`}</span>
                            </span>
                          )
                        })}
                      </div>
                    ) : null}

                    <p className="service-row__notes">{service.notes}</p>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {services.length === 0 ? (
        <p className="service-row__notes" role={loadState === 'loading' ? 'status' : undefined}>
          {loadState === 'loading' || loadState === 'idle'
            ? 'Loading live service data…'
            : loadState === 'error'
              ? 'Service data could not be loaded. Try refreshing the status page.'
              : 'No services configured yet.'}
        </p>
      ) : null}
    </section>
  )
}, areServiceGroupListPropsEqual)
