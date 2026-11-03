import { describe, expect, it, vi } from 'vitest'

import {
  emitObservabilityEvent,
  getObservabilityError,
  type ObservabilityLogger,
} from './observability'

function createLogger(): Record<keyof ObservabilityLogger, ReturnType<typeof vi.fn>> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe('structured observability', () => {
  it('preserves string reasons in probe failure logs', () => {
    const logger = createLogger()

    emitObservabilityEvent(
      'warn',
      'probe.failed',
      { serviceId: 'api', status: 'down', reason: getObservabilityError('HTTP 503') },
      logger as ObservabilityLogger,
      '2026-09-03T10:00:00.000Z'
    )

    expect(JSON.parse(logger.warn.mock.calls[0][0]).reason).toBe('HTTP 503')
  })

  it('emits one JSON event with stable metadata and fields', () => {
    const logger = createLogger()

    emitObservabilityEvent(
      'warn',
      'probe.failed',
      { serviceId: 'api', status: 'down', reason: 'HTTP 503' },
      logger as ObservabilityLogger,
      '2026-09-03T10:00:00.000Z'
    )

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toEqual({
      timestamp: '2026-09-03T10:00:00.000Z',
      component: 'pulseflare-worker',
      event: 'probe.failed',
      serviceId: 'api',
      status: 'down',
      reason: 'HTTP 503',
    })
  })
})
