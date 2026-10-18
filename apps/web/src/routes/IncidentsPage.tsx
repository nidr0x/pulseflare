import { useState } from 'react'

import { IncidentTimeline } from '../components/IncidentTimeline'
import { EMPTY_INCIDENT_PAGE_DATA, type IncidentPageData, type SnapshotLoadState, type StatusSnapshot } from '../lib/api'

type IncidentsPageProps = {
  data?: IncidentPageData
  snapshot?: StatusSnapshot
  loadState?: SnapshotLoadState
  onRetry?: () => void
}

export function IncidentsPage({ data: suppliedData, snapshot, loadState = 'ready', onRetry = () => undefined }: IncidentsPageProps) {
  const [selectedService, setSelectedService] = useState<string>('all')
  const data = suppliedData ?? (snapshot
    ? {
        product: snapshot.product,
        services: snapshot.services.map(({ id, name }) => ({ id, name })),
        incidents: snapshot.incidents,
        maintenance: snapshot.maintenance,
      }
    : EMPTY_INCIDENT_PAGE_DATA)

  return (
    <div className="page-stack">
      <section className="panel panel-header">
        <div className="section-heading">
          <div>
            <p className="eyebrow">History</p>
            <h1>Incidents & Maintenance</h1>
          </div>
          <p>Filter the public log by service while keeping incidents and scheduled work in one place.</p>
        </div>

        <div className="filter-row" role="group" aria-label="Filter incidents by service">
          <button
            aria-pressed={selectedService === 'all'}
            className={selectedService === 'all' ? 'filter-chip filter-chip--active' : 'filter-chip'}
            onClick={() => setSelectedService('all')}
            type="button"
          >
            All services
          </button>

          {data.services.map((service) => (
            <button
              aria-pressed={selectedService === service.id}
              className={selectedService === service.id ? 'filter-chip filter-chip--active' : 'filter-chip'}
              key={service.id}
              onClick={() => setSelectedService(service.id)}
              type="button"
            >
              {service.name}
            </button>
          ))}
        </div>
      </section>

      <IncidentTimeline
        incidents={data.incidents}
        maintenance={data.maintenance}
        services={data.services}
        selectedService={selectedService}
        loadState={loadState}
        onRetry={onRetry}
        title="Full incident history"
        eyebrow="Activity"
      />
    </div>
  )
}
