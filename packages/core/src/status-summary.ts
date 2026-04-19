export type ServiceStatusSnapshot = {
  id: string
  name: string
  status: 'up' | 'down'
}

export type SummaryStatus = 'operational' | 'degraded'

export type StatusSummary = {
  status: SummaryStatus
  upCount: number
  downCount: number
  totalCount: number
}

export function buildSummary(services: ServiceStatusSnapshot[]): StatusSummary {
  const upCount = services.filter((service) => service.status === 'up').length
  const downCount = services.length - upCount

  return {
    status: downCount === 0 ? 'operational' : 'degraded',
    upCount,
    downCount,
    totalCount: services.length,
  }
}
