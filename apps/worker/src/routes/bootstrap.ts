import { getBootstrapToken, getWorkerDatabase } from '../config'
import { countServices, ensureBootstrapSchema, getRuntimeConfig, syncServices } from '../install'

export async function handleBootstrapInstall(request: Request, env: unknown): Promise<Response> {
  const expectedToken = getBootstrapToken(env)
  const providedToken = new URL(request.url).searchParams.get('token')

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

  if (initialCount > 0) {
    return Response.json({
      created: false,
      seededServices: 0,
      totalServices: initialCount,
    })
  }

  await syncServices(database, config)

  const totalServices = await countServices(database)

  return Response.json({
    created: true,
    seededServices: totalServices - initialCount,
    totalServices,
  })
}
