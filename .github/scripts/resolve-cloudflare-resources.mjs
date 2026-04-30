import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function requireEnv(env, name) {
  const value = env[name]

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Add it to this repository's GitHub Actions secrets or variables before deploying.`
    )
  }

  return value
}

function runWrangler(args, env = process.env) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function parseTrailingJson(output) {
  const match = output.match(/\{[\s\S]*"d1_databases"[\s\S]*\}\s*$/)

  if (!match) {
    throw new Error(`Could not find D1 JSON payload in output:\n${output}`)
  }

  return JSON.parse(match[0])
}

export async function resolveCloudflareResources({
  env = process.env,
  runWrangler: wrangler = (args) => runWrangler(args, env),
  writeOutput = appendFileSync,
} = {}) {
  requireEnv(env, 'CLOUDFLARE_API_TOKEN')
  requireEnv(env, 'CLOUDFLARE_ACCOUNT_ID')

  const workerName = env.PULSEFLARE_WORKER_NAME || 'pulseflare-status'
  const databaseName = env.PULSEFLARE_D1_NAME || 'pulseflare-d1'

  const listedDatabases = JSON.parse(wrangler(['d1', 'list', '--json']))
  let database = listedDatabases.find((entry) => entry.name === databaseName)

  if (!database) {
    const createOutput = wrangler(['d1', 'create', databaseName])
    const payload = parseTrailingJson(createOutput)
    database = payload.d1_databases.find((entry) => entry.database_name === databaseName)
  }

  if (!database?.uuid && !database?.database_id) {
    throw new Error(`Unable to resolve a D1 database id for ${databaseName}`)
  }

  const databaseId = database.database_id ?? database.uuid
  const githubOutput = env.GITHUB_OUTPUT

  if (!githubOutput) {
    throw new Error('GITHUB_OUTPUT is not set')
  }

  writeOutput(githubOutput, `worker_name=${workerName}\n`)
  writeOutput(githubOutput, `database_name=${databaseName}\n`)
  writeOutput(githubOutput, `database_id=${databaseId}\n`)

  return {
    workerName,
    databaseName,
    databaseId,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await resolveCloudflareResources()
}
