import { describe, expect, it } from 'vitest'

import worker from '../index'

describe('/api/public/summary', () => {
  it('returns a summary payload', async () => {
    const responseTimeBefore = Date.now()
    const response = await worker.fetch(
      new Request('https://example.com/api/public/summary'),
      {
        PULSEFLARE_D1: {
          prepare() {
            throw new Error('summary route should not query D1 yet')
          },
        },
      } as never,
      {} as ExecutionContext
    )
    const payload = (await response.json()) as {
      status: string
      upCount: number
      downCount: number
      totalCount: number
      checkedAt: string
    }

    expect(response.status).toBe(200)
    expect(payload.status).toBe('operational')
    expect(payload.upCount).toBe(0)
    expect(payload.downCount).toBe(0)
    expect(payload.totalCount).toBe(0)
    expect(Number.isNaN(Date.parse(payload.checkedAt))).toBe(false)
    expect(Date.parse(payload.checkedAt)).toBeGreaterThanOrEqual(responseTimeBefore)
  })
})
