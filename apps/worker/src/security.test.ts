import { describe, expect, it } from 'vitest'

import { withSecurityHeaders } from './security'

describe('security response headers', () => {
  it('adds browser hardening headers without dropping existing headers', async () => {
    const response = withSecurityHeaders(
      new Response('ok', {
        headers: { 'cache-control': 'public, max-age=30' },
      })
    )

    expect(response.headers.get('cache-control')).toBe('public, max-age=30')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain('https://fonts.googleapis.com')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.text()).resolves.toBe('ok')
  })
})
