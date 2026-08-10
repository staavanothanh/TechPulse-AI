import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  atlasTestArguments,
  createAtlasTestEnvironment,
  databaseNameForSuite,
  dropTestDatabase,
  redactAtlasOutput,
} from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'

const fakeUri = 'mongodb+srv://atlas-user:atlas-password@example.invalid/techpulse?retryWrites=true'

describe('Step 2 explicit Atlas test safety', () => {
  it('resolves the URI indirectly and passes it to tests only as MONGODB_TEST_URI', () => {
    const result = createAtlasTestEnvironment({
      environment: {
        MONGODB_URI_ENV: 'ATLAS_URI',
        ATLAS_URI: fakeUri,
        MONGODB_DATABASE: 'techpulse_app',
        QUOTA_HMAC_CURRENT_KEY: 'must-not-reach-child',
        Path: 'C:\\Windows\\System32',
      },
      runId: 'abc12',
    })

    expect(result.testDatabaseBase).toBe('techpulse_step2_test_abc12')
    expect(result.childEnvironment.MONGODB_TEST_URI).toBe(fakeUri)
    expect(result.childEnvironment.MONGODB_TEST_DATABASE).toBe(result.testDatabaseBase)
    expect(result.childEnvironment.MONGODB_PROTECTED_DATABASE_NAME).toBe('techpulse_app')
    expect(result.childEnvironment.ATLAS_URI).toBeUndefined()
    expect(result.childEnvironment.MONGODB_URI_ENV).toBeUndefined()
    expect(result.childEnvironment.MONGODB_DATABASE).toBeUndefined()
    expect(result.childEnvironment.QUOTA_HMAC_CURRENT_KEY).toBeUndefined()
  })

  it('rejects protected, reserved and non-Step-2 test database names before cleanup', async () => {
    expect(() => databaseNameForSuite('mongo', { MONGODB_TEST_DATABASE: 'techpulse_app', MONGODB_PROTECTED_DATABASE_NAME: 'techpulse_app' })).toThrow(/protected/)
    for (const database of ['admin', 'config', 'local']) {
      expect(() => databaseNameForSuite('mongo', { MONGODB_TEST_DATABASE: database })).toThrow(/reserved|prefix/)
    }
    expect(() => databaseNameForSuite('mongo', { MONGODB_TEST_DATABASE: 'unsafe_test' })).toThrow(/prefix/)

    const dropDatabase = vi.fn(async () => undefined)
    await expect(dropTestDatabase({
      context: { database: 'techpulse_app', db: { dropDatabase } },
      expectedDatabase: 'techpulse_app',
      environment: { MONGODB_PROTECTED_DATABASE_NAME: 'techpulse_app' },
    })).rejects.toThrow(/protected/)
    expect(dropDatabase).not.toHaveBeenCalled()
  })

  it('builds suite-specific names and only drops the exact guarded database', async () => {
    const environment = { MONGODB_TEST_DATABASE: 'techpulse_step2_test_abc12', MONGODB_PROTECTED_DATABASE_NAME: 'techpulse_app' }
    const database = databaseNameForSuite('hmac', environment)
    expect(database).toBe('techpulse_step2_test_abc12_hmac')
    expect(Buffer.byteLength(database, 'utf8')).toBeLessThanOrEqual(38)
    expect(() => databaseNameForSuite('hmac_lifecycle', environment)).toThrow(/38-byte/)
    const dropDatabase = vi.fn(async () => ({ ok: 1 }))
    await expect(dropTestDatabase({ context: { database, db: { dropDatabase } }, expectedDatabase: database, environment })).resolves.toEqual({ ok: 1 })
    expect(dropDatabase).toHaveBeenCalledTimes(1)
  })

  it('redacts the full URI and its credential/host components from child output', () => {
    const output = `connection failed for ${fakeUri} at example.invalid as atlas-user with atlas-password database techpulse option retryWrites=true`
    const redacted = redactAtlasOutput(output, fakeUri)
    expect(redacted).not.toContain(fakeUri)
    expect(redacted).not.toContain('example.invalid')
    expect(redacted).not.toContain('atlas-user')
    expect(redacted).not.toContain('atlas-password')
    expect(redacted).not.toContain('techpulse')
    expect(redacted).not.toContain('retryWrites=true')
  })

  it('keeps default tests offline and uses native Node env loading for explicit runtime scripts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.scripts.test).toBe('vitest')
    expect(pkg.scripts['test:atlas']).toBe('node --env-file-if-exists=.env scripts/run-atlas-tests.js')
    expect(pkg.scripts['test:coverage:mongodb']).toBe('node --env-file-if-exists=.env scripts/run-atlas-tests.js coverage')
    for (const name of ['dev', 'db:migrate', 'db:migrate:dry-run', 'db:verify', 'seed:admin']) {
      expect(pkg.scripts[name]).toContain('node --env-file-if-exists=.env ')
    }
    expect(atlasTestArguments('integration')).toEqual(['node_modules/vitest/vitest.mjs', 'run', 'test/integration'])
    expect(atlasTestArguments('full')).toEqual(['node_modules/vitest/vitest.mjs', 'run'])
    expect(atlasTestArguments('coverage')).toEqual(['node_modules/vitest/vitest.mjs', 'run', '--coverage'])
    for (const path of ['../../server/dev.js', '../../scripts/db-migrate.js', '../../scripts/db-verify.js', '../../scripts/seed-admin.js', '../../scripts/run-atlas-tests.js']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain('configure-dns.js')
    }
  })

  it('configures Cloudflare DNS after Node startup inside the launched process', () => {
    const setServers = vi.fn()
    configureDns(setServers)
    expect(setServers).toHaveBeenCalledWith(['1.1.1.1'])
  })

  it('keeps every real env file ignored while allowing the example template', () => {
    const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')
    expect(ignore).toMatch(/^\.env$/m)
    expect(ignore).toMatch(/^\.env\.\*$/m)
    expect(ignore).toMatch(/^!\.env\.example$/m)
  })
})
