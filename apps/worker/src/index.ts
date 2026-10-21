import { handleBootstrapInstall } from './routes/bootstrap'
import { getWorkerAssets } from './config'
import { getObservabilityError, emitObservabilityEvent } from './observability'
import { withSecurityHeaders } from './security'
import { runScheduledChecks } from './domain/scheduler'
import {
  getDefaultCache,
  purgePublicRouteCache,
  readFromEdgeCache,
  storeInEdgeCache,
} from './edge-cache'
import {
  handlePublicIncidents,
  handlePublicMaintenance,
  handlePublicServices,
  handlePublicSnapshot,
  handlePublicSummary,
  handleHealth,
} from './routes/public'

type PublicRoute = {
  handler: (env: unknown) => Promise<Response>
  cache: boolean
}

const PUBLIC_ROUTES = new Map<string, PublicRoute>([
  ['/api/public/summary', { handler: handlePublicSummary, cache: true }],
  ['/api/public/snapshot', { handler: handlePublicSnapshot, cache: true }],
  ['/api/public/services', { handler: handlePublicServices, cache: true }],
  ['/api/public/incidents', { handler: handlePublicIncidents, cache: true }],
  ['/api/public/maintenance', { handler: handlePublicMaintenance, cache: true }],
  ['/api/health', { handler: handleHealth, cache: false }],
])

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: 'Method Not Allowed' },
    {
      status: 405,
      headers: { allow },
    }
  )
}

function asHeadResponse(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function handleApiRequest(
  request: Request,
  env: unknown,
  ctx: ExecutionContext
): Promise<Response> {
  const { pathname } = new URL(request.url)

  if (pathname === '/api/install/bootstrap') {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST')
    }

    const bootstrapResponse = await handleBootstrapInstall(request, env)

    if (bootstrapResponse.ok) {
      await purgePublicRouteCache(new URL(request.url).origin)
    }

    return bootstrapResponse
  }

  const route = PUBLIC_ROUTES.get(pathname)

  if (!route) {
    return Response.json({ error: 'Not Found' }, { status: 404 })
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed('GET, HEAD')
  }

  const cache = route.cache ? getDefaultCache() : undefined
  // Public handlers ignore query strings; normalize the key so arbitrary
  // query parameters cannot bypass the edge cache and multiply D1 reads.
  const cacheKey = cache
    ? new Request(`${new URL(request.url).origin}${pathname}`, { method: 'GET' })
    : undefined

  if (cache && cacheKey) {
    const cached = await readFromEdgeCache(cache, cacheKey)

    if (cached) {
      return request.method === 'HEAD' ? asHeadResponse(cached) : cached
    }
  }

  const response = await route.handler(env)

  if (request.method === 'HEAD') {
    return asHeadResponse(response)
  }

  if (cache && cacheKey && response.ok) {
    storeInEdgeCache(cache, ctx, cacheKey, response)
  }

  return response
}

const worker = {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return withSecurityHeaders(await handleApiRequest(request, env, ctx))
      }

      const assets = getWorkerAssets(env)

      if (assets) {
        return withSecurityHeaders(await assets.fetch(request))
      }

      return withSecurityHeaders(new Response('Not found', { status: 404 }))
    } catch (error) {
      const requestId = crypto.randomUUID()

      emitObservabilityEvent('error', 'request.failed', {
        requestId,
        method: request.method,
        path: url.pathname,
        error: getObservabilityError(error),
      })

      return withSecurityHeaders(
        Response.json({ error: 'Internal Server Error', requestId }, { status: 500 })
      )
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      runScheduledChecks(env).catch((error) => {
        emitObservabilityEvent('error', 'scheduler.execution_failed', {
          error: getObservabilityError(error),
        })
      })
    )
  },
}

export default worker
