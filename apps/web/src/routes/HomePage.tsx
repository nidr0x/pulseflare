import { HeroStatus } from '../components/HeroStatus'
import { MaintenanceBanner } from '../components/MaintenanceBanner'
import { ServiceGroupList } from '../components/ServiceGroupList'
import type { SnapshotLoadState, StatusSnapshot } from '../lib/api'

type HomePageProps = {
  snapshot: StatusSnapshot
  loadState?: SnapshotLoadState
}

export function HomePage({ snapshot, loadState = 'ready' }: HomePageProps) {
  return (
    <div className="page-stack">
      <MaintenanceBanner maintenance={snapshot.maintenance} />
      <HeroStatus loadState={loadState} product={snapshot.product} summary={snapshot.summary} />
      <ServiceGroupList services={snapshot.services} />
    </div>
  )
}
