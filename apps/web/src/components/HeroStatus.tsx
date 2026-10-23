import { useEffect, useState } from 'react'

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

  const checkedAt = new Date(value)

  if (Number.isNaN(checkedAt.getTime())) {
    return 'an unknown time'
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(checkedAt)
}

export function HeroStatus({ product, summary, loadState = 'ready', now, onRetry }: HeroStatusProps) {
  const [clockNow, setClockNow] = useState(() => now ?? Date.now())

  useEffect(() => {
    if (now !== undefined) {
      setClockNow(now)
      return
    }

    const intervalId = window.setInterval(() => setClockNow(Date.now()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [now])

  const freshness = getSnapshotFreshness(summary.checkedAt, clockNow, summary.staleAfterMinutes)
  const isStale = freshness.state === 'stale'
  const headline =
    loadState === 'error'
      ? 'Live status unavailable'
      : isStale
        ? 'Status data is stale'
        : summary.status === 'operational'
          ? 'All systems operational'
          : summary.status === 'degraded'
            ? 'Some systems require attention'
            : 'Checking current status'
  const signalStatus = loadState === 'error' || isStale ? 'unknown' : summary.status
  const statusSummary =
    loadState === 'error'
      ? 'Retrying automatically'
      : isStale
        ? 'Awaiting fresh check results'
        : summary.totalCount > 0
          ? `${summary.upCount}/${summary.totalCount} services healthy`
          : 'No services reported yet'
  const lastUpdated = summary.checkedAt
    ? `Last updated ${formatCheckedAt(summary.checkedAt)}`
    : 'Last updated: awaiting first successful check'
  const freshnessLabel =
    isStale
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
        {lastUpdated} · {freshnessLabel} · {statusSummary}
      </p>
      {showRefresh ? (
        <button className="status-retry" onClick={onRetry} type="button">
          Refresh status
        </button>
      ) : null}
    </section>
  )
}
