import { HeroStatus } from '../components/HeroStatus'
import { MaintenanceBanner } from '../components/MaintenanceBanner'
import { ServiceGroupList } from '../components/ServiceGroupList'
import type { StatusSnapshot } from '../lib/api'

type HomePageProps = {
  snapshot: StatusSnapshot
}

export function HomePage({ snapshot }: HomePageProps) {
  return (
    <div className="page-stack">
      <HeroStatus product={snapshot.product} summary={snapshot.summary} />
      <MaintenanceBanner maintenance={snapshot.maintenance} />
      <ServiceGroupList services={snapshot.services} />
    </div>
  )
}
