import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'
import type { StatusConfig } from '@pulseflare/schema'

import { BOOTSTRAP_SCHEMA_SQL, syncServices } from './install'
import { BASE_SCHEMA_SQL } from './schema'

describe('BASE_SCHEMA_SQL', () => {
  it('matches the checked-in D1 migration', () => {
    const migrationPath = fileURLToPath(new URL('../migrations/0001_initial.sql', import.meta.url).toString())
    const migrationSql = readFileSync(migrationPath, 'utf8').trim()

    expect(BASE_SCHEMA_SQL.trim()).toBe(migrationSql)
  })
})

type TableFingerprint = {
  columns: Record<
    string,
    { type: string; notNull: boolean; default: string | number | null; pk: number }
  >
  foreignKeys: Array<{ references: string; onDelete: string }>
}

type SchemaFingerprint = {
  tables: Record<string, TableFingerprint>
  indexes: Record<
    string,
    { table: string; unique: boolean; columns: string[]; partial: boolean; sql: string }
  >
}

function fingerprintSchema(database: DatabaseSync): SchemaFingerprint {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  const indexes = database
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .all() as Array<{ name: string; tbl_name: string; sql: string }>

  const fingerprint: SchemaFingerprint = { tables: {}, indexes: {} }

  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA table_info('${name}')`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>

    fingerprint.tables[name] = {
      columns: Object.fromEntries(
        columns.map((column) => [
          column.name,
          {
            type: column.type,
            notNull: column.notnull === 1,
            default: column.dflt_value
              ? String(column.dflt_value).replace(/^'|'$/g, '')
              : null,
            pk: column.pk,
          },
        ])
      ),
      foreignKeys: (
        database.prepare(`PRAGMA foreign_key_list('${name}')`).all() as Array<{
          table: string
          on_delete: string
        }>
      ).map((foreignKey) => ({ references: foreignKey.table, onDelete: foreignKey.on_delete })),
    }
  }

  for (const index of indexes) {
    const columns = (database.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{
      name: string
    }>).map((column) => column.name)
    const meta = (
      database.prepare(`PRAGMA index_list('${index.tbl_name}')`).all() as Array<{
        name: string
        unique: number
        partial: number
      }>
    ).find((entry) => entry.name === index.name)

    fingerprint.indexes[index.name] = {
      table: index.tbl_name,
      unique: meta?.unique === 1,
      columns,
      partial: meta?.partial === 1,
      sql: index.sql.replace(/\s+/g, ' ').trim(),
    }
  }

  return fingerprint
}

function applyBootstrapSchema(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec(BOOTSTRAP_SCHEMA_SQL)
  return database
}

function applyMigrations(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url).toString())
  const files = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()

  for (const file of files) {
    database.exec(readFileSync(`${migrationsDirectory}${file}`, 'utf8'))
  }

  return database
}

describe('bootstrap schema parity', () => {
  it('creates the same schema as applying every migration in order', () => {
    const bootstrapped = fingerprintSchema(applyBootstrapSchema())
    const migrated = fingerprintSchema(applyMigrations())

    expect(bootstrapped).toEqual(migrated)
  })
})

describe('migration files', () => {
  it('uses numbered prefixes without undocumented duplicates', () => {
    const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url).toString())
    const files = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql'))

    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      expect(file).toMatch(/^\d{4}_[a-z0-9]+(_[a-z0-9]+)*\.sql$/)
    }

    // 0002_reliability and 0002_service_status_failure_state predate this guard
    // and cannot be renamed: d1_migrations bookkeeping on existing deployments
    // records the full filenames. Any NEW duplicate prefix must fail here.
    const prefixCounts = new Map<string, number>()

    for (const file of files) {
      const prefix = file.slice(0, 4)
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1)
    }

    const duplicatePrefixes = [...prefixCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([prefix]) => prefix)
      .sort()

    expect(duplicatePrefixes).toEqual(['0002'])
    expect(
      files.filter((file) => file.startsWith('0002_')).sort()
    ).toEqual(['0002_reliability.sql', '0002_service_status_failure_state.sql'])
  })
})

type ServiceRow = {
  id: string
  name: string
  service_group: string | null
  sort_order: number
  is_active: number
}

class FakePreparedStatement {
  constructor(
    private readonly database: FakeD1Database,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}

  bind(...params: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.database, this.sql, params)
  }

  async all(): Promise<{ results: ServiceRow[] }> {
    return {
      results: this.database.services
        .filter((service) => service.is_active === 1)
        .map(({ id, name, service_group, sort_order }) => ({ id, name, service_group, sort_order, is_active: 1 })),
    }
  }

  async run(): Promise<Record<string, unknown>> {
    if (this.sql.includes('UPDATE services SET is_active = 0')) {
      for (const service of this.database.services) {
        service.is_active = 0
      }

      return {}
    }

    if (this.sql.includes('INSERT INTO services') && this.sql.includes('ON CONFLICT(id) DO UPDATE')) {
      const [id, name, group, sortOrder] = this.params as [string, string, string | null, number]

      if (this.database.failOnServiceId === id) {
        throw new Error(`Failed to sync service ${id}`)
      }

      const existing = this.database.services.find((service) => service.id === id)
      if (existing) {
        existing.name = name
        existing.service_group = group
        existing.sort_order = sortOrder
        existing.is_active = 1
      } else {
        this.database.services.push({
          id,
          name,
          service_group: group,
          sort_order: sortOrder,
          is_active: 1,
        })
      }

      return {}
    }

    throw new Error(`Unexpected run() query: ${this.sql}`)
  }
}

class FakeD1Database {
  public batchCalls = 0
  public failOnServiceId: string | undefined

  constructor(public services: ServiceRow[]) {}

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql)
  }

  async batch(statements: FakePreparedStatement[]): Promise<Record<string, unknown>[]> {
    this.batchCalls += 1
    const snapshot = this.services.map((service) => ({ ...service }))

    try {
      for (const statement of statements) {
        await statement.run()
      }
    } catch (error) {
      this.services = snapshot
      throw error
    }

    return []
  }
}

const config = {
  site: { name: 'Pulseflare' },
  services: [
    {
      id: 'api',
      name: 'Public API v2',
      group: 'Platform',
      checks: [{ type: 'http' as const, url: 'https://api.example.com' }],
    },
    {
      id: 'dashboard',
      name: 'Dashboard',
      checks: [{ type: 'http' as const, url: 'https://dashboard.example.com' }],
    },
  ],
  notifications: { providers: [] },
  maintenances: [],
} satisfies StatusConfig

describe('syncServices', () => {
  it('skips the D1 batch when active services already match the config', async () => {
    const database = new FakeD1Database([
      { id: 'api', name: 'Public API v2', service_group: 'Platform', sort_order: 0, is_active: 1 },
      { id: 'dashboard', name: 'Dashboard', service_group: null, sort_order: 1, is_active: 1 },
    ])

    await syncServices(database as unknown as D1Database, config)

    expect(database.batchCalls).toBe(0)
  })

  it('syncs active services and archives removed services atomically', async () => {
    const database = new FakeD1Database([
      { id: 'api', name: 'Old API', service_group: null, sort_order: 4, is_active: 1 },
      { id: 'legacy', name: 'Legacy', service_group: null, sort_order: 2, is_active: 1 },
    ])

    await syncServices(database as unknown as D1Database, config)

    expect(database.batchCalls).toBe(1)
    expect(database.services).toEqual([
      { id: 'api', name: 'Public API v2', service_group: 'Platform', sort_order: 0, is_active: 1 },
      { id: 'legacy', name: 'Legacy', service_group: null, sort_order: 2, is_active: 0 },
      { id: 'dashboard', name: 'Dashboard', service_group: null, sort_order: 1, is_active: 1 },
    ])
  })

  it('rolls back the entire service sync when an upsert fails', async () => {
    const database = new FakeD1Database([
      { id: 'api', name: 'Old API', service_group: null, sort_order: 4, is_active: 1 },
      { id: 'legacy', name: 'Legacy', service_group: null, sort_order: 2, is_active: 1 },
    ])
    database.failOnServiceId = 'dashboard'
    const originalServices = database.services.map((service) => ({ ...service }))

    await expect(syncServices(database as unknown as D1Database, config)).rejects.toThrow(
      'Failed to sync service dashboard'
    )

    expect(database.batchCalls).toBe(1)
    expect(database.services).toEqual(originalServices)
  })
})
