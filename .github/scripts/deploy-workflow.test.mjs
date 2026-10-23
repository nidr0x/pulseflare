import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const WORKFLOW_PATH = new URL('../workflows/deploy.yml', import.meta.url)

describe('deploy workflow', () => {
  it('queues overlapping deploys with a ref-scoped concurrency group', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
    const lines = workflow.split('\n')

    const concurrencyIndex = lines.findIndex((line) => line === 'concurrency:')

    assert.ok(concurrencyIndex >= 0, 'top-level concurrency: block is required')
    assert.ok(
      lines.slice(0, concurrencyIndex - 1).some((line) => line.startsWith('on:')),
      'concurrency should be a top-level setting next to on:'
    )

    const body = lines.slice(concurrencyIndex + 1, concurrencyIndex + 4)
    assert.equal(body[0], '  group: deploy-${{ github.ref }}')
    assert.equal(body[1], '  cancel-in-progress: false')

    assert.ok(
      lines.every((line) => !line.includes('cancel-in-progress: true')),
      'deploys must queue sequentially instead of cancelling an in-flight deploy'
    )
  })

  it('builds web assets in the deploy job after installing dependencies', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
    const lines = workflow.split('\n')
    const deployJobIndex = lines.findIndex((line) => line === '  deploy:')

    assert.ok(deployJobIndex >= 0, 'deploy job is required')

    const nextJobIndex = lines.findIndex(
      (line, index) => index > deployJobIndex && /^  [A-Za-z0-9_-]+:$/.test(line)
    )
    const deployJobLines = lines.slice(
      deployJobIndex + 1,
      nextJobIndex < 0 ? lines.length : nextJobIndex
    )
    const installIndex = deployJobLines.findIndex((line) => line.trim() === 'run: npm ci')
    const webBuildIndex = deployJobLines.findIndex(
      (line) => line.trim() === 'run: npm run build --workspace @pulseflare/web'
    )
    const workerDeployIndex = deployJobLines.findIndex(
      (line) => line.trim() === 'run: npx wrangler deploy --config apps/worker/wrangler.deploy.toml'
    )

    assert.ok(installIndex >= 0, 'deploy job must install dependencies')
    assert.ok(webBuildIndex > installIndex, 'web assets must build after dependency installation')
    assert.ok(workerDeployIndex > webBuildIndex, 'web assets must build before deploying the Worker')
  })
})
