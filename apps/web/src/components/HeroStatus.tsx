import type { SnapshotLoadState, StatusSnapshot } from '../lib/api'

type HeroStatusProps = {
  product: StatusSnapshot['product']
  summary: StatusSnapshot['summary']
  loadState?: SnapshotLoadState
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

export function HeroStatus({ product, summary, loadState = 'ready' }: HeroStatusProps) {
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
        Last checked {formatCheckedAt(summary.checkedAt)} · {healthySummary}
      </p>
    </section>
  )
}
