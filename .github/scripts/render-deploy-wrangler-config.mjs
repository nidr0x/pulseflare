import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function replaceSingle(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label} in Wrangler config`)
  }

  return source.replace(pattern, replacement)
}

export function renderDeployWranglerConfig({
  sourcePath = 'apps/worker/wrangler.toml',
  outputPath = 'apps/worker/wrangler.deploy.toml',
  workerName,
  databaseName,
  databaseId,
  checkCron = '* * * * *',
} = {}) {
  if (!workerName || !databaseName || !databaseId) {
    throw new Error('workerName, databaseName, and databaseId are required')
  }

  let config = readFileSync(sourcePath, 'utf8')

  config = replaceSingle(config, /^name = ".*"$/m, `name = "${workerName}"`, 'worker name')
  config = replaceSingle(config, /^database_name = ".*"$/m, `database_name = "${databaseName}"`, 'D1 database name')
  config = replaceSingle(config, /^database_id = ".*"$/m, `database_id = "${databaseId}"`, 'D1 database id')
  config = replaceSingle(config, /^crons = \[".*"\]$/m, `crons = ["${checkCron}"]`, 'cron trigger')

  writeFileSync(outputPath, config)

  return config
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  renderDeployWranglerConfig({
    workerName: process.env.PULSEFLARE_WORKER_NAME_RENDERED,
    databaseName: process.env.PULSEFLARE_D1_NAME_RENDERED,
    databaseId: process.env.PULSEFLARE_D1_ID_RENDERED,
    checkCron: process.env.PULSEFLARE_CHECK_CRON_RENDERED || '* * * * *',
  })
}
