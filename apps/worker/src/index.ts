import { handleBootstrapInstall } from './routes/bootstrap'
import { getWorkerAssets } from './config'
import { runScheduledChecks } from './domain/scheduler'
import {
  handlePublicIncidents,
  handlePublicMaintenance,
  handlePublicRss,
  handlePublicServices,
  handlePublicSnapshot,
  handlePublicSummary,
} from './routes/public'

const worker = {
  async fetch(request: Request, env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/install/bootstrap') {
      return handleBootstrapInstall(request, env)
    }

    if (url.pathname === '/api/public/summary') {
      return handlePublicSummary(env)
    }

    if (url.pathname === '/api/public/snapshot') {
      return handlePublicSnapshot(env)
    }

    if (url.pathname === '/api/public/services') {
      return handlePublicServices(env)
    }

    if (url.pathname === '/api/public/incidents') {
      return handlePublicIncidents(env)
    }

    if (url.pathname === '/api/public/maintenance') {
      return handlePublicMaintenance(env)
    }

    if (url.pathname === '/feeds/incidents.xml' || url.pathname === '/rss' || url.pathname === '/feeds/incidents') {
      return handlePublicRss(env, request)
    }

    const assets = getWorkerAssets(env)

    if (assets) {
      return assets.fetch(request)
    }

    return new Response('Not found', { status: 404 })
  },
  async scheduled(
    _controller: ScheduledController,
    env: unknown,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runScheduledChecks(env))
  },
}

export default worker
