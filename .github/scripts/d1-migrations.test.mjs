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

function execute(scenario, sql, json = false) {
  const args = [
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
  ]

  if (json) {
    args.push('--json')
  }

  return runWrangler(scenario, args)
}

function query(scenario, sql) {
  return JSON.parse(execute(scenario, sql, true))[0]?.results ?? []
}

function assertSchemaShape(scenario) {
  const expectedTables = [
    'check_results',
    'daily_check_rollups',
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
  const incidentColumns = query(scenario, "PRAGMA table_info('incidents')").map((row) => row.name)
  assert.ok(incidentColumns.includes('impact'))
  const leaseColumns = query(scenario, "PRAGMA table_info('scheduler_lease')").map((row) => row.name)
  assert.ok(leaseColumns.includes('last_pruned_at'))

  const indexNames = query(scenario, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name)
  assert.ok(indexNames.includes('incidents_one_open_per_service_idx'))
  assert.ok(indexNames.includes('notification_outbox_delivery_idx'))
  assert.ok(indexNames.includes('check_results_recorded_idx'))
  assert.ok(indexNames.includes('latency_points_recorded_idx'))
  assert.ok(indexNames.includes('daily_check_rollups_day_idx'))
}

const allMigrations = [
  '0001_initial.sql',
  '0002_reliability.sql',
  '0002_service_status_failure_state.sql',
  '0003_concurrency.sql',
  '0004_idempotency.sql',
  '0005_daily_rollups_and_incident_impact.sql',
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

  it('upgrades an existing database and backfills rollups without reapplying old migrations', () => {
    const scenario = createScenario()

    try {
      copyMigrations(scenario, allMigrations.slice(0, -1))
      applyMigrations(scenario)

      execute(scenario, "INSERT INTO services (id, name) VALUES ('api', 'API')")
      execute(
        scenario,
        "INSERT INTO check_results (id, service_id, recorded_at, status, reason, latency_ms, location_label) " +
          "VALUES ('check-1', 'api', '2026-04-25T08:00:00.000Z', 'up', 'ok', 20, 'region:iad')"
      )
      execute(
        scenario,
        "INSERT INTO check_results (id, service_id, recorded_at, status, reason, latency_ms, location_label) " +
          "VALUES ('check-2', 'api', '2026-04-25T08:01:00.000Z', 'down', 'failed', 40, 'region:iad')"
      )
      execute(
        scenario,
        "INSERT INTO incidents (id, service_id, status, latest_reason, opened_at) " +
          "VALUES ('incident-1', 'api', 'open', 'failed', '2026-04-25T08:01:00.000Z')"
      )

      const before = query(scenario, "SELECT name FROM sqlite_master WHERE type = 'index'").map((row) => row.name)
      assert.ok(before.includes('incidents_one_open_per_service_idx'))

      copyMigrations(scenario, ['0005_daily_rollups_and_incident_impact.sql'])
      applyMigrations(scenario)

      assertSchemaShape(scenario)
      assert.deepEqual(
        query(scenario, 'SELECT service_id, day, location_label, up_count, down_count, last_latency_ms FROM daily_check_rollups'),
        [{ service_id: 'api', day: '2026-04-25', location_label: 'region:iad', up_count: 1, down_count: 1, last_latency_ms: 40 }]
      )
      assert.deepEqual(query(scenario, 'SELECT impact FROM incidents WHERE id = \'incident-1\''), [{ impact: 'minor' }])
      const migrationRows = query(scenario, 'SELECT name FROM d1_migrations ORDER BY name').map((row) => row.name)
      assert.deepEqual(migrationRows, allMigrations)
    } finally {
      rmSync(scenario.root, { recursive: true, force: true })
    }
  })
})
