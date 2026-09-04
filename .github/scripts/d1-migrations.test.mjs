import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceMigrationsDirectory = join(repositoryRoot, 'apps/worker/migrations')
const wranglerPath = join(
  repositoryRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
)

function createScenario() {
  const root = mkdtempSync(join(tmpdir(), 'pulseflare-d1-'))
  const migrationsDirectory = join(root, 'migrations')
  const persistDirectory = join(root, 'state')
  const configPath = join(root, 'wrangler.toml')

  mkdirSync(migrationsDirectory)
  writeFileSync(
    configPath,
    [
      'name = "pulseflare-d1-integration-test"',
      'compatibility_date = "2026-04-18"',
      '',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "pulseflare_d1_integration_test"',
      'database_id = "00000000-0000-0000-0000-000000000000"',
      `migrations_dir = ${JSON.stringify(migrationsDirectory)}`,
      '',
    ].join('\n')
  )

  return { root, migrationsDirectory, persistDirectory, configPath }
}

function runWrangler(scenario, args) {
  return execFileSync(wranglerPath, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(scenario.root, 'wrangler.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function copyMigrations(scenario, names) {
  for (const name of names) {
    cpSync(join(sourceMigrationsDirectory, name), join(scenario.migrationsDirectory, name))
  }
}

function applyMigrations(scenario) {
  runWrangler(scenario, [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--local',
    '--persist-to',
    scenario.persistDirectory,
    '--config',
    scenario.configPath,
  ])
}

function query(scenario, sql) {
  const output = runWrangler(scenario, [
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    scenario.persistDirectory,
    '--config',
    scenario.configPath,
    '--command',
    sql,
    '--json',
  ])

  return JSON.parse(output)[0]?.results ?? []
}

function assertSchemaShape(scenario) {
  const expectedTables = [
    'check_results',
    'incidents',
    'latency_points',
    'notification_outbox',
    'scheduler_lease',
    'scheduler_runs',
    'service_status',
    'services',
  ]
  const tableNames = query(scenario, "SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name)
    .filter((name) => expectedTables.includes(name))
    .sort()

  assert.deepEqual(tableNames, expectedTables.slice().sort())

  const outboxColumns = query(scenario, "PRAGMA table_info('notification_outbox')").map((row) => row.name)
  assert.ok(outboxColumns.includes('claimed_by'))
  assert.ok(outboxColumns.includes('claimed_until'))

  const indexNames = query(scenario, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name)
  assert.ok(indexNames.includes('incidents_one_open_per_service_idx'))
  assert.ok(indexNames.includes('notification_outbox_delivery_idx'))
}

const allMigrations = [
  '0001_initial.sql',
  '0002_reliability.sql',
  '0002_service_status_failure_state.sql',
  '0003_concurrency.sql',
  '0004_idempotency.sql',
]

describe('D1 migrations', () => {
  it('builds the complete schema from an empty local database', () => {
    const scenario = createScenario()

    try {
      copyMigrations(scenario, allMigrations)
      applyMigrations(scenario)
      assertSchemaShape(scenario)
    } finally {
      rmSync(scenario.root, { recursive: true, force: true })
    }
  })

  it('upgrades a pre-idempotency database without reapplying old migrations', () => {
    const scenario = createScenario()

    try {
      copyMigrations(scenario, allMigrations.slice(0, -1))
      applyMigrations(scenario)

      const before = query(scenario, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name)
      assert.ok(!before.includes('incidents_one_open_per_service_idx'))

      copyMigrations(scenario, ['0004_idempotency.sql'])
      applyMigrations(scenario)

      assertSchemaShape(scenario)
      const migrationRows = query(scenario, 'SELECT name FROM d1_migrations ORDER BY name').map((row) => row.name)
      assert.deepEqual(migrationRows, allMigrations)
    } finally {
      rmSync(scenario.root, { recursive: true, force: true })
    }
  })
})
