import { describe, expect, it } from 'vitest'

import worker from '../index'

type ServiceRow = {
  id: string
  name: string
  service_group: string | null
  sort_order: number
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

  async first(): Promise<Record<string, unknown>> {
    if (this.sql.includes('SELECT COUNT(*) AS service_count FROM services')) {
      return { service_count: this.database.services.length }
    }

    throw new Error(`Unexpected first() query: ${this.sql}`)
  }

  async run(): Promise<Record<string, unknown>> {
    if (this.sql.includes('UPDATE services SET is_active = 0')) {
      return {}
    }

    if (this.sql.includes('INSERT INTO services') && this.sql.includes('ON CONFLICT(id) DO UPDATE')) {
      const [id, name, group, sortOrder] = this.params as [string, string, string | null, number]
      const existing = this.database.services.find((service) => service.id === id)

      if (existing) {
        existing.name = name
        existing.service_group = group
        existing.sort_order = sortOrder
      } else {
        this.database.services.push({
          id,
          name,
          service_group: group,
          sort_order: sortOrder,
        })
      }

      return {}
    }

    throw new Error(`Unexpected run() query: ${this.sql}`)
  }
}

class FakeD1Database {
  public execCalls: string[] = []
  public batchCalls = 0
  public services: ServiceRow[] = []

  exec(sql: string): Promise<Record<string, unknown>> {
    this.execCalls.push(sql)
    return Promise.resolve({})
  }

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql)
  }

  async batch(statements: FakePreparedStatement[]): Promise<Record<string, unknown>[]> {
    this.batchCalls += 1

    for (const statement of statements) {
      await statement.run()
    }

    return []
  }
}

describe('/api/install/bootstrap', () => {
  it('rejects requests without the bootstrap token', async () => {
    const database = new FakeD1Database()

    const response = await worker.fetch(
      new Request('https://example.com/api/install/bootstrap', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      }),
      {
        PULSEFLARE_D1: database,
        PULSEFLARE_BOOTSTRAP_TOKEN: 'secret',
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [],
          notifications: { providers: [] },
          maintenances: [],
        },
      } as never,
      {} as ExecutionContext
    )

    expect(response.status).toBe(401)
    expect(database.execCalls).toHaveLength(0)
    expect(database.services).toHaveLength(0)
  })

  it('creates the base schema and seeds services from config on first bootstrap', async () => {
    const database = new FakeD1Database()

    const response = await worker.fetch(
      new Request('https://example.com/api/install/bootstrap', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      {
        PULSEFLARE_D1: database,
        PULSEFLARE_BOOTSTRAP_TOKEN: 'secret',
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'Public API',
              group: 'Platform',
              checks: [{ type: 'http', url: 'https://example.com/health' }],
            },
            {
              id: 'dashboard',
              name: 'Dashboard',
              checks: [{ type: 'http', url: 'https://example.com/dashboard' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      } as never,
      {} as ExecutionContext
    )

    const payload = (await response.json()) as {
      created: boolean
      seededServices: number
      totalServices: number
    }

    expect(response.status).toBe(200)
    expect(payload.created).toBe(true)
    expect(payload.seededServices).toBe(2)
    expect(payload.totalServices).toBe(2)
    expect(database.execCalls).toHaveLength(1)
    expect(database.batchCalls).toBe(1)
    expect(database.services).toEqual([
      {
        id: 'api',
        name: 'Public API',
        service_group: 'Platform',
        sort_order: 0,
      },
      {
        id: 'dashboard',
        name: 'Dashboard',
        service_group: null,
        sort_order: 1,
      },
    ])
  })

  it('reports an already bootstrapped install without duplicating services', async () => {
    const database = new FakeD1Database()
    database.services.push({
      id: 'api',
      name: 'Public API',
      service_group: 'Platform',
      sort_order: 0,
    })

    const response = await worker.fetch(
      new Request('https://example.com/api/install/bootstrap', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      {
        PULSEFLARE_D1: database,
        PULSEFLARE_BOOTSTRAP_TOKEN: 'secret',
        STATUS_CONFIG: {
          site: { name: 'Pulseflare' },
          services: [
            {
              id: 'api',
              name: 'Public API',
              group: 'Platform',
              checks: [{ type: 'http', url: 'https://example.com/health' }],
            },
          ],
          notifications: { providers: [] },
          maintenances: [],
        },
      } as never,
      {} as ExecutionContext
    )

    const payload = (await response.json()) as {
      created: boolean
      seededServices: number
      totalServices: number
    }

    expect(response.status).toBe(200)
    expect(payload.created).toBe(false)
    expect(payload.seededServices).toBe(0)
    expect(payload.totalServices).toBe(1)
    expect(database.services).toHaveLength(1)
  })
})
