import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseTrailingJson, resolveCloudflareResources } from './resolve-cloudflare-resources.mjs'

describe('parseTrailingJson', () => {
  it('parses wrangler create output that ends with a D1 JSON payload', () => {
    const payload = parseTrailingJson(`
      Created pulseflare-d1
      {
        "d1_databases": [
          { "database_name": "pulseflare-d1", "database_id": "db-123" }
        ]
      }
    `)

    assert.equal(payload.d1_databases[0].database_id, 'db-123')
  })
})

describe('resolveCloudflareResources', () => {
  it('fails before calling wrangler when required Cloudflare credentials are missing', async () => {
    await assert.rejects(
      resolveCloudflareResources({
        env: {},
        runWrangler() {
          throw new Error('wrangler should not run')
        },
        writeOutput() {},
      }),
      /Missing required environment variable: CLOUDFLARE_API_TOKEN/
    )
  })

  it('reuses an existing D1 database from wrangler list output', async () => {
    const writes = []
    const wranglerCalls = []

    await resolveCloudflareResources({
      env: {
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        GITHUB_OUTPUT: 'github-output',
      },
      runWrangler(args) {
        wranglerCalls.push(args)
        return JSON.stringify([{ name: 'pulseflare-d1', uuid: 'existing-db' }])
      },
      writeOutput(_path, value) {
        writes.push(value)
      },
    })

    assert.deepEqual(wranglerCalls, [['d1', 'list', '--json']])
    assert.equal(writes.join(''), 'worker_name=pulseflare-status\ndatabase_name=pulseflare-d1\ndatabase_id=existing-db\n')
  })

  it('creates D1 when it is not present yet', async () => {
    const wranglerCalls = []
    const writes = []

    await resolveCloudflareResources({
      env: {
        CLOUDFLARE_API_TOKEN: 'token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        GITHUB_OUTPUT: 'github-output',
      },
      runWrangler(args) {
        wranglerCalls.push(args)

        if (args[1] === 'list') {
          return '[]'
        }

        return '{ "d1_databases": [{ "database_name": "pulseflare-d1", "database_id": "created-db" }] }'
      },
      writeOutput(_path, value) {
        writes.push(value)
      },
    })

    assert.deepEqual(wranglerCalls, [
      ['d1', 'list', '--json'],
      ['d1', 'create', 'pulseflare-d1'],
    ])
    assert.equal(writes.at(-1), 'database_id=created-db\n')
  })
})
