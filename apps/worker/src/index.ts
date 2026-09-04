import { handleBootstrapInstall } from './routes/bootstrap'
import { getWorkerAssets } from './config'
import { getObservabilityError, emitObservabilityEvent } from './observability'
import { withSecurityHeaders } from './security'
import { runScheduledChecks } from './domain/scheduler'
import {
  handlePublicIncidents,
  handlePublicMaintenance,
  handlePublicServices,
  handlePublicSnapshot,
  handlePublicSummary,
  handleHealth,
} from './routes/public'

const worker = {
  async fetch(request: Request, env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/install/bootstrap') {
      return withSecurityHeaders(await handleBootstrapInstall(request, env))
    }

    if (url.pathname === '/api/public/summary') {
      return withSecurityHeaders(await handlePublicSummary(env))
    }

    if (url.pathname === '/api/public/snapshot') {
      return withSecurityHeaders(await handlePublicSnapshot(env))
    }

    if (url.pathname === '/api/health') {
      return withSecurityHeaders(await handleHealth(env))
    }

    if (url.pathname === '/api/public/services') {
      return withSecurityHeaders(await handlePublicServices(env))
    }

    if (url.pathname === '/api/public/incidents') {
      return withSecurityHeaders(await handlePublicIncidents(env))
    }

    if (url.pathname === '/api/public/maintenance') {
      return withSecurityHeaders(await handlePublicMaintenance(env))
    }

    const assets = getWorkerAssets(env)

    if (assets) {
      return withSecurityHeaders(await assets.fetch(request))
    }

    return withSecurityHeaders(new Response('Not found', { status: 404 }))
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
