import { getBootstrapToken, getWorkerDatabase } from '../config'
import { countServices, ensureBootstrapSchema, getRuntimeConfig, syncServices } from '../install'

export async function handleBootstrapInstall(request: Request, env: unknown): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'POST' },
    })
  }

  const expectedToken = getBootstrapToken(env)
  const authorization = request.headers.get('authorization')
  const providedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined

  if (!expectedToken || providedToken !== expectedToken) {
    return Response.json({ error: 'Unauthorized bootstrap request' }, { status: 401 })
  }

  const database = getWorkerDatabase(env)

  if (!database) {
    return Response.json({ error: 'Missing PULSEFLARE_D1 binding' }, { status: 500 })
  }

  const config = getRuntimeConfig(env)

  await ensureBootstrapSchema(database)

  const initialCount = await countServices(database)
  await syncServices(database, config)

  const totalServices = await countServices(database)

  return Response.json({
    created: initialCount === 0,
    seededServices: Math.max(0, totalServices - initialCount),
    totalServices,
  })
}
