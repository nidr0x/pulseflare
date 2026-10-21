/**
 * Edge cache helpers for public API responses. The worker-level Cache API
 * (`caches.default`) stores normalized GET keys per origin so repeated public
 * reads do not multiply D1 queries; failures are never fatal to the response.
 */

export const PUBLIC_CACHEABLE_ROUTES = [
  '/api/public/summary',
  '/api/public/snapshot',
  '/api/public/services',
  '/api/public/incidents',
  '/api/public/maintenance',
] as const

export function getDefaultCache(): Cache | undefined {
  try {
    return typeof caches === 'undefined' ? undefined : caches.default
  } catch {
    return undefined
  }
}

export function readFromEdgeCache(cache: Cache, key: Request): Promise<Response | undefined> {
  return cache.match(key).catch(() => undefined)
}

export function storeInEdgeCache(
  cache: Cache,
  ctx: ExecutionContext,
  key: Request,
  response: Response
): void {
  const put = cache.put(key, response.clone()).catch(() => undefined)

  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(put)
  }
}

/**
 * Delete every cacheable public route key for the given origin. Used after a
 * successful bootstrap so the first visitors do not receive the pre-install
 * empty snapshot for up to the cache TTL. Cache deletes are same-colo only;
 * other colos age out naturally over the TTL window.
 */
export async function purgePublicRouteCache(origin: string): Promise<void> {
  const cache = getDefaultCache()

  if (!cache) {
    return
  }

  const deletes = PUBLIC_CACHEABLE_ROUTES.map((pathname) =>
    cache.delete(new Request(`${origin}${pathname}`, { method: 'GET' })).catch(() => undefined)
  )

  await Promise.all(deletes)
}
