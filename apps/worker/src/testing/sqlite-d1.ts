import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

/**
 * Test-only adapter that fronts an in-memory SQLite database with the subset of
 * the Cloudflare D1 API used by the worker (prepare/batch/exec plus bound
 * statements running all/first/run). Backed by the real checked-in migrations so
 * domain logic is exercised against actual SQL instead of query-blind fakes.
 */
function toD1Statement(statement: StatementSync, values: unknown[] = []): {
  bind: (...nextValues: unknown[]) => ReturnType<typeof toD1Statement>
  all: () => Promise<{ results: Array<Record<string, unknown>> }>
  first: () => Promise<Record<string, unknown> | null>
  run: () => Promise<{ meta: { changes: number; last_row_id: number } }>
} {
  return {
    bind: (...nextValues: unknown[]) => toD1Statement(statement, nextValues),
    all: async () => ({
      results: statement.all(...(values as never[])) as Array<Record<string, unknown>>,
    }),
    first: async () => {
      const row = statement.get(...(values as never[])) as Record<string, unknown> | undefined
      return row ?? null
    },
    run: async () => {
      const info = statement.run(...(values as never[])) as {
        changes: number | bigint
        lastInsertRowid: number | bigint
      }

      return {
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      }
    },
  }
}

export function createSqliteD1(database: DatabaseSync): D1Database {
  const adapter = {
    prepare: (query: string) => toD1Statement(database.prepare(query)),
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      const results: unknown[] = []

      for (const statement of statements) {
        results.push(await statement.run())
      }

      return results
    },
    exec: (sql: string) => {
      database.exec(sql)
    },
  }

  return adapter as unknown as D1Database
}

export function createMigrationBackedD1Database(): { database: D1Database; raw: DatabaseSync } {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url).toString())
  const files = readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()

  for (const file of files) {
    database.exec(readFileSync(`${migrationsDirectory}${file}`, 'utf8'))
  }

  return { database: createSqliteD1(database), raw: database }
}
