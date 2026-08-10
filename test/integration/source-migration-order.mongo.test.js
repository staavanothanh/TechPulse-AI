import { MongoClient } from 'mongodb'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { AUTH_CORE_COLLECTIONS, runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { runSourcesMigration, SOURCE_AUDIT_VALIDATOR } from '../../scripts/migrations/sources.js'
import { runAuthCoreWithStep3Compatibility } from '../../scripts/migrations/step3-compatibility.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

async function auditValidator(db) {
  const collections = await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray()
  return collections[0]?.options?.validator
}

function runMigrationCli(target, database) {
  return spawnSync(process.execPath, ['scripts/db-migrate.js', '--to', target], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      MONGODB_URI_ENV: 'STEP3_MIGRATION_URI',
      STEP3_MIGRATION_URI: process.env.MONGODB_TEST_URI,
      MONGODB_DATABASE: database,
    },
  })
}

describeMongo('Step 3 monotonic migration order', () => {
  it('preserves the Source audit validator after auth-core is rerun', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const forwardName = databaseNameForSuite('src_fwd')
    const reverseName = databaseNameForSuite('src_rev')
    const forward = createMongoContext({ client, database: forwardName })
    const reverse = createMongoContext({ client, database: reverseName })
    try {
      await runAuthCoreMigration({ db: forward.db })
      await runSourcesMigration({ db: forward.db })
      expect(await auditValidator(forward.db)).toEqual(SOURCE_AUDIT_VALIDATOR)

      for (const target of ['auth-core', 'sources', 'auth-core']) {
        const result = runMigrationCli(target, reverseName)
        expect(result.status, result.stderr).toBe(0)
      }
      expect(await auditValidator(reverse.db)).toEqual(SOURCE_AUDIT_VALIDATOR)
    } finally {
      await dropTestDatabase({ context: forward, expectedDatabase: forwardName })
      await dropTestDatabase({ context: reverse, expectedDatabase: reverseName })
      await client.close()
    }
  }, 30_000)

  it('fails closed without mutating an unknown audit-validator superset', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('src_unknown')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      const unknownValidator = structuredClone(AUTH_CORE_COLLECTIONS.adminAuditLogs.validator)
      unknownValidator.$and[0].$or.push({ action: 'unknown_open_rule' })
      const untouchedUsersValidator = { $jsonSchema: { bsonType: 'object' } }
      await context.db.command({ collMod: 'users', validator: untouchedUsersValidator, validationLevel: 'strict', validationAction: 'error' })
      await context.db.command({ collMod: 'adminAuditLogs', validator: unknownValidator, validationLevel: 'strict', validationAction: 'error' })

      await expect(runAuthCoreWithStep3Compatibility({ db: context.db })).rejects.toThrow(/unknown audit validator revision/i)
      expect(await auditValidator(context.db)).toEqual(unknownValidator)
      const usersCollection = (await context.db.listCollections({ name: 'users' }, { nameOnly: false }).toArray())[0]
      expect(usersCollection.options.validator).toEqual(untouchedUsersValidator)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('reports a missing sources schema without collapsing to a runtime error', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('src_missing')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      const result = spawnSync(process.execPath, ['scripts/db-verify.js', 'sources'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          MONGODB_URI_ENV: 'STEP3_VERIFY_URI',
          STEP3_VERIFY_URI: process.env.MONGODB_TEST_URI,
          MONGODB_DATABASE: database,
        },
      })
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('runtime_or_database_error')
      const failure = JSON.parse(result.stderr.trim())
      expect(failure.missing).toContain('sources:collection')
      expect(failure.roleStatus).toBe('not-requested')

      const roleResult = spawnSync(process.execPath, ['scripts/db-verify.js', 'sources', '--require-role'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          MONGODB_URI_ENV: 'STEP3_VERIFY_URI',
          STEP3_VERIFY_URI: process.env.MONGODB_TEST_URI,
          MONGODB_DATABASE: database,
        },
      })
      expect(roleResult.status).toBe(1)
      expect(roleResult.stderr).not.toContain('runtime_or_database_error')
      const roleFailure = JSON.parse(roleResult.stderr.trim())
      expect(roleFailure.missing).toContain('sources:collection')
      expect(roleFailure.roleStatus).toBe('blocked-by-schema')
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)
})
