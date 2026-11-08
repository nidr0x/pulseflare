import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { applyMigrationsAndDeploy, getWranglerConfig } from './deploy.mjs'

describe('Cloudflare deploy command', () => {
  it('uses the generated private config when present, otherwise the button config', () => {
    assert.equal(getWranglerConfig((path) => path === 'apps/worker/wrangler.deploy.toml'), 'apps/worker/wrangler.deploy.toml')
    assert.equal(getWranglerConfig(() => false), 'wrangler.toml')
  })

  it('applies migrations by binding name before deploying with the same config', () => {
    const commands = []

    applyMigrationsAndDeploy('wrangler.toml', (args) => commands.push(args))

    assert.deepEqual(commands, [
      ['d1', 'migrations', 'apply', 'PULSEFLARE_D1', '--remote', '--config', 'wrangler.toml'],
      ['deploy', '--config', 'wrangler.toml'],
    ])
  })
})
