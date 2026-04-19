import { useState } from 'react'

import { IncidentTimeline } from '../components/IncidentTimeline'
import type { StatusSnapshot } from '../lib/api'

type IncidentsPageProps = {
  snapshot: StatusSnapshot
}

export function IncidentsPage({ snapshot }: IncidentsPageProps) {
  const [selectedService, setSelectedService] = useState<string>('all')

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

        <div className="filter-row" aria-label="Service filter">
          <button
            className={selectedService === 'all' ? 'filter-chip filter-chip--active' : 'filter-chip'}
            onClick={() => setSelectedService('all')}
            type="button"
          >
            All services
          </button>

          {snapshot.services.map((service) => (
            <button
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
        incidents={snapshot.incidents}
        maintenance={snapshot.maintenance}
        selectedService={selectedService}
        title="Full incident history"
        eyebrow="Activity"
      />
    </div>
  )
}
