import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function replaceSingle(source, pattern, replacement, label) {
  if (!pattern.test(source)) {
    throw new Error(`Could not find ${label} in Wrangler config`)
  }

  return source.replace(pattern, replacement)
}

function addRemoteProbeUrl(config, remoteProbeUrl) {
  if (!remoteProbeUrl) {
    return config
  }

  try {
    if (new URL(remoteProbeUrl).protocol !== 'https:') {
      throw new Error()
    }
  } catch {
    throw new Error('remoteProbeUrl must be a valid HTTPS URL')
  }

  const variable = `PULSEFLARE_REMOTE_PROBE_URL = ${JSON.stringify(remoteProbeUrl)}`
  const lines = config.trimEnd().split(/\r?\n/)
  const varsIndex = lines.findIndex((line) => line.trim() === '[vars]')

  if (varsIndex >= 0) {
    const nextTableIndex = lines.findIndex((line, index) => index > varsIndex && line.startsWith('['))
    lines.splice(nextTableIndex >= 0 ? nextTableIndex : lines.length, 0, variable)
    return `${lines.join('\n')}\n`
  }

  const firstTableIndex = lines.findIndex((line) => line.startsWith('['))
  const varsBlock = ['[vars]', variable, '']
  lines.splice(firstTableIndex >= 0 ? firstTableIndex : lines.length, 0, ...varsBlock)
  return `${lines.join('\n')}\n`
}

export function renderDeployWranglerConfig({
  sourcePath = 'apps/worker/wrangler.toml',
  outputPath = 'apps/worker/wrangler.deploy.toml',
  workerName,
  databaseName,
  databaseId,
  checkCron = '* * * * *',
  remoteProbeUrl,
} = {}) {
  if (!workerName || !databaseName || !databaseId) {
    throw new Error('workerName, databaseName, and databaseId are required')
  }

  let config = readFileSync(sourcePath, 'utf8')

  config = replaceSingle(config, /^name = ".*"$/m, `name = "${workerName}"`, 'worker name')
  config = replaceSingle(config, /^database_name = ".*"$/m, `database_name = "${databaseName}"`, 'D1 database name')
  config = replaceSingle(config, /^database_id = ".*"$/m, `database_id = "${databaseId}"`, 'D1 database id')
  config = replaceSingle(config, /^crons = \[".*"\]$/m, `crons = ["${checkCron}"]`, 'cron trigger')
  config = addRemoteProbeUrl(config, remoteProbeUrl)

  writeFileSync(outputPath, config)

  return config
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  renderDeployWranglerConfig({
    workerName: process.env.PULSEFLARE_WORKER_NAME_RENDERED,
    databaseName: process.env.PULSEFLARE_D1_NAME_RENDERED,
    databaseId: process.env.PULSEFLARE_D1_ID_RENDERED,
    checkCron: process.env.PULSEFLARE_CHECK_CRON_RENDERED || '* * * * *',
    remoteProbeUrl: process.env.PULSEFLARE_REMOTE_PROBE_URL_RENDERED,
  })
}
