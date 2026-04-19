import { appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function runWrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function parseTrailingJson(output) {
  const match = output.match(/\{[\s\S]*"d1_databases"[\s\S]*\}\s*$/)

  if (!match) {
    throw new Error(`Could not find D1 JSON payload in output:\n${output}`)
  }

  return JSON.parse(match[0])
}

const workerName = process.env.PULSEFLARE_WORKER_NAME || 'pulseflare-status'
const databaseName = process.env.PULSEFLARE_D1_NAME || 'pulseflare-d1'

const listedDatabases = JSON.parse(runWrangler(['d1', 'list', '--json']))
let database = listedDatabases.find((entry) => entry.name === databaseName)

if (!database) {
  const createOutput = runWrangler(['d1', 'create', databaseName])
  const payload = parseTrailingJson(createOutput)
  database = payload.d1_databases.find((entry) => entry.database_name === databaseName)
}

if (!database?.uuid && !database?.database_id) {
  throw new Error(`Unable to resolve a D1 database id for ${databaseName}`)
}

const databaseId = database.database_id ?? database.uuid
const githubOutput = process.env.GITHUB_OUTPUT

if (!githubOutput) {
  throw new Error('GITHUB_OUTPUT is not set')
}

appendFileSync(githubOutput, `worker_name=${workerName}\n`)
appendFileSync(githubOutput, `database_name=${databaseName}\n`)
appendFileSync(githubOutput, `database_id=${databaseId}\n`)
