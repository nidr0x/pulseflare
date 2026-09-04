import {
  formatDuration,
  getSnapshotFreshness,
  type SnapshotLoadState,
  type StatusSnapshot,
} from '../lib/api'

type HeroStatusProps = {
  product: StatusSnapshot['product']
  summary: StatusSnapshot['summary']
  loadState?: SnapshotLoadState
  now?: number
  onRetry?: () => void
}

function formatCheckedAt(value: string | null): string {
  if (!value) {
    return 'Awaiting first successful check'
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

export function HeroStatus({ product, summary, loadState = 'ready', now = Date.now(), onRetry }: HeroStatusProps) {
  const headline =
    loadState === 'error'
      ? 'Live status unavailable'
      : summary.status === 'operational'
      ? 'All systems operational'
      : summary.status === 'degraded'
        ? 'Some systems require attention'
        : 'Checking current status'
  const signalStatus = summary.status === 'unknown' ? 'degraded' : summary.status
  const healthySummary =
    loadState === 'error'
      ? 'Retrying automatically'
      : summary.totalCount > 0
        ? `${summary.upCount}/${summary.totalCount} services healthy`
        : 'No services reported yet'
  const freshness = getSnapshotFreshness(summary.checkedAt, now, summary.staleAfterMinutes)
  const lastUpdated = summary.checkedAt
    ? `Last updated ${formatCheckedAt(summary.checkedAt)}`
    : 'Last updated: awaiting first successful check'
  const freshnessLabel =
    freshness.state === 'stale'
      ? `Data is stale by ${formatDuration(freshness.staleByMs)}`
      : freshness.state === 'fresh' && freshness.ageMs !== null
        ? `Updated ${formatDuration(freshness.ageMs)} ago`
        : 'Awaiting first successful check'
  const showRefresh = Boolean(onRetry) && loadState !== 'loading' && (loadState === 'error' || freshness.state === 'stale')

  return (
    <section className="hero-status panel panel-hero">
      <p className="eyebrow">{product.name} status</p>
      <div className={`hero-status__signal hero-status__signal--${signalStatus}`} aria-hidden="true">
        <span className="hero-status__signal-dot" />
      </div>
      <h1>{headline}</h1>
      <p className="hero-status__copy">
        {loadState === 'error' ? 'The latest check results could not be retrieved.' : product.description}
      </p>
      <p className="hero-status__meta">
        {lastUpdated} · {freshnessLabel} · {healthySummary}
      </p>
      {showRefresh ? (
        <button className="status-retry" onClick={onRetry} type="button">
          Refresh status
        </button>
      ) : null}
    </section>
  )
}
