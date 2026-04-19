import { HeroStatus } from '../components/HeroStatus'
import { IncidentTimeline } from '../components/IncidentTimeline'
import { ServiceGroupList } from '../components/ServiceGroupList'
import type { StatusSnapshot } from '../lib/api'

type HomePageProps = {
  snapshot: StatusSnapshot
}

export function HomePage({ snapshot }: HomePageProps) {
  return (
    <div className="page-stack">
      <HeroStatus product={snapshot.product} summary={snapshot.summary} />
      <ServiceGroupList services={snapshot.services} />
      <IncidentTimeline incidents={snapshot.incidents.slice(0, 2)} maintenance={snapshot.maintenance.slice(0, 1)} />
    </div>
  )
}
