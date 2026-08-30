import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { StatusConfig } from '@pulseflare/schema'

import { syncServices } from './install'
import { BASE_SCHEMA_SQL } from './schema'

describe('BASE_SCHEMA_SQL', () => {
  it('matches the checked-in D1 migration', () => {
    const migrationPath = fileURLToPath(new URL('../migrations/0001_initial.sql', import.meta.url).toString())
    const migrationSql = readFileSync(migrationPath, 'utf8').trim()

    expect(BASE_SCHEMA_SQL.trim()).toBe(migrationSql)
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
