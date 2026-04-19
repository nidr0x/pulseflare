import type { StatusCheck } from '@pulseflare/schema'

export type CheckRunResult = {
  status: 'up' | 'down'
  reason: string
}

export function evaluateConfiguredCheck(check: StatusCheck): CheckRunResult {
  if (check.type === 'http') {
    return {
      status: 'up',
      reason: `${check.method ?? 'GET'} ${check.url}`,
    }
  }

  return {
    status: 'up',
    reason: check.target,
  }
}
