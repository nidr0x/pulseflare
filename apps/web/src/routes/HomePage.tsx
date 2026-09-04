import { HeroStatus } from '../components/HeroStatus'
import { MaintenanceBanner } from '../components/MaintenanceBanner'
import { ServiceGroupList } from '../components/ServiceGroupList'
import type { SnapshotLoadState, StatusSnapshot } from '../lib/api'

type HomePageProps = {
  snapshot: StatusSnapshot
  loadState?: SnapshotLoadState
  now?: number
  onRetry?: () => void
}

export function HomePage({ snapshot, loadState = 'ready', now, onRetry }: HomePageProps) {
  return (
    <div className="page-stack">
      <MaintenanceBanner maintenance={snapshot.maintenance} />
      <HeroStatus loadState={loadState} now={now} onRetry={onRetry} product={snapshot.product} summary={snapshot.summary} />
      <ServiceGroupList services={snapshot.services} />
    </div>
  )
}
