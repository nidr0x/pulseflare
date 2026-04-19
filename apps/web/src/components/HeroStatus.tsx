import type { StatusSnapshot } from '../lib/api'

type HeroStatusProps = {
  product: StatusSnapshot['product']
  summary: StatusSnapshot['summary']
}

function formatCheckedAt(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value))
}

export function HeroStatus({ product, summary }: HeroStatusProps) {
  const headline =
    summary.status === 'operational' ? 'All systems operational' : 'Some systems require attention'

  return (
    <section className="hero-status panel panel-hero">
      <p className="eyebrow">{product.name} status</p>
      <div className={`hero-status__signal hero-status__signal--${summary.status}`} aria-hidden="true">
        <span className="hero-status__signal-dot" />
      </div>
      <h1>{headline}</h1>
      <p className="hero-status__copy">{product.description}</p>
      <p className="hero-status__meta">
        Last checked {formatCheckedAt(summary.checkedAt)} · {summary.upCount}/{summary.totalCount} services healthy
      </p>
    </section>
  )
}
