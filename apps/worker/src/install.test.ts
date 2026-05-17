import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { BASE_SCHEMA_SQL } from './schema'

describe('BASE_SCHEMA_SQL', () => {
  it('matches the checked-in D1 migration', () => {
    const migrationPath = fileURLToPath(new URL('../migrations/0001_initial.sql', import.meta.url).toString())
    const migrationSql = readFileSync(migrationPath, 'utf8').trim()

    expect(BASE_SCHEMA_SQL.trim()).toBe(migrationSql)
  })
})
