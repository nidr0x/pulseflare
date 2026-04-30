import { HeroStatus } from '../components/HeroStatus'
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
    </div>
  )
}
