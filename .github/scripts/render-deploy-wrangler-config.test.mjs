import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { renderDeployWranglerConfig } from './render-deploy-wrangler-config.mjs'

describe('renderDeployWranglerConfig', () => {
  it('renders deploy-specific values from the checked-in Wrangler config', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pulseflare-wrangler-'))
    const sourcePath = join(tempDir, 'wrangler.toml')
    const outputPath = join(tempDir, 'wrangler.deploy.toml')

    writeFileSync(
      sourcePath,
      [
        'name = "pulseflare-worker"',
        'main = "src/index.ts"',
        '',
        '[triggers]',
        'crons = ["* * * * *"]',
        '',
        '[[d1_databases]]',
        'database_name = "pulseflare_d1"',
        'database_id = "00000000-0000-0000-0000-000000000000"',
        '',
      ].join('\n')
    )

    renderDeployWranglerConfig({
      sourcePath,
      outputPath,
      workerName: 'pulseflare-status',
      databaseName: 'pulseflare-prod',
      databaseId: '11111111-1111-1111-1111-111111111111',
      checkCron: '*/5 * * * *',
      remoteProbeUrl: 'https://probes.example.com/run',
    })

    const rendered = readFileSync(outputPath, 'utf8')

    assert.match(rendered, /name = "pulseflare-status"/)
    assert.match(rendered, /database_name = "pulseflare-prod"/)
    assert.match(rendered, /database_id = "11111111-1111-1111-1111-111111111111"/)
    assert.match(rendered, /crons = \["\*\/5 \* \* \* \*"\]/)
    assert.match(rendered, /\[vars\]\nPULSEFLARE_REMOTE_PROBE_URL = "https:\/\/probes\.example\.com\/run"/)
  })

  it('rejects a non-HTTPS remote probe URL', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pulseflare-wrangler-'))
    const sourcePath = join(tempDir, 'wrangler.toml')
    const outputPath = join(tempDir, 'wrangler.deploy.toml')

    writeFileSync(
      sourcePath,
      [
        'name = "pulseflare-worker"',
        'main = "src/index.ts"',
        '',
        '[triggers]',
        'crons = ["* * * * *"]',
        '',
        '[[d1_databases]]',
        'database_name = "pulseflare_d1"',
        'database_id = "00000000-0000-0000-0000-000000000000"',
        '',
      ].join('\n')
    )

    assert.throws(
      () =>
        renderDeployWranglerConfig({
          sourcePath,
          outputPath,
          workerName: 'pulseflare-status',
          databaseName: 'pulseflare-prod',
          databaseId: '11111111-1111-1111-1111-111111111111',
          remoteProbeUrl: 'http://probes.example.com/run',
        }),
      /remoteProbeUrl must be a valid HTTPS URL/
    )
  })
})
