import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PRIVATE_WRANGLER_CONFIG = 'apps/worker/wrangler.deploy.toml'

export function getWranglerConfig(fileExists = existsSync) {
  return fileExists(PRIVATE_WRANGLER_CONFIG) ? PRIVATE_WRANGLER_CONFIG : 'wrangler.toml'
}

export function applyMigrationsAndDeploy(configPath, runWrangler) {
  runWrangler(['d1', 'migrations', 'apply', 'PULSEFLARE_D1', '--remote', '--config', configPath])
  runWrangler(['deploy', '--config', configPath])
}

function runWrangler(args) {
  execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit' })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyMigrationsAndDeploy(getWranglerConfig(), runWrangler)
}
