import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { migrationUriEnvName } from '../../../scripts/migration-credential.js'

describe('Step 11 migration credential boundary', () => {
  it('uses the operator credential name for governance DDL and never the runtime credential name', () => {
    const environment = { MONGODB_URI_ENV: 'RUNTIME_MONGO_URI', MONGODB_OPERATOR_URI_ENV: 'OPERATOR_MONGO_URI' }
    expect(migrationUriEnvName('governance', environment)).toBe('OPERATOR_MONGO_URI')
    expect(migrationUriEnvName('articles', environment)).toBe('OPERATOR_MONGO_URI')
  })

  it('keeps db-verify on the runtime credential boundary', () => {
    const source = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toContain('validateMongoConfiguration(process.env)')
    expect(source).not.toContain('MONGODB_OPERATOR_URI_ENV')
  })
})
