import { handleBootstrapInstall } from './routes/bootstrap'
import { getWorkerAssets } from './config'
import { handlePublicSummary } from './routes/public'

const worker = {
  async fetch(request: Request, env: unknown, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/install/bootstrap') {
      return handleBootstrapInstall(request, env)
    }

    if (url.pathname === '/api/public/summary') {
      return handlePublicSummary()
    }

    const assets = getWorkerAssets(env)

    if (assets) {
      return assets.fetch(request)
    }

    return new Response('Not found', { status: 404 })
  },
}

export default worker
