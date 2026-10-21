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
})
