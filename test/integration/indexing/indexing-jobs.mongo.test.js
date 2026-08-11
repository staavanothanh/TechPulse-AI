import { MongoClient } from 'mongodb'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { MongoProviderAdmissionRepository } from '../../../server/repositories/mongo/provider-admission-repository.js'
import { INDEXING_ARTICLE_INDEXES, INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

function safeDatabaseName() {
  return `techpulse_test_step9_${process.pid}_${Date.now()}`
}

function runScript(script, args, database) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MONGODB_URI_ENV: 'STEP9_TEST_URI', STEP9_TEST_URI: process.env.MONGODB_TEST_URI, MONGODB_DATABASE: database },
  })
}

describeMongo('Step 9 indexing-jobs Mongo integration', () => {
  it('migrates/verifies idempotently and enforces shared provider admission state', async () => {
    const database = safeDatabaseName()
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs', 'articles', 'indexing-jobs', 'indexing-jobs']) {
        const migrated = runScript('scripts/db-migrate.js', ['--to', target], database)
        expect(migrated.status, `${target}: ${migrated.stderr}`).toBe(0)
      }
      const verified = runScript('scripts/db-verify.js', ['indexing-jobs'], database)
      expect(verified.status, verified.stderr).toBe(0)
      expect(JSON.parse(verified.stdout)).toMatchObject({ verified: true, collections: 2, roleStatus: 'not-requested' })

      const collections = new Map((await context.db.listCollections({}, { nameOnly: false }).toArray()).map((collection) => [collection.name, collection]))
      for (const [name, definition] of Object.entries(INDEXING_JOB_COLLECTIONS)) {
        expect(collections.get(name)?.options?.validator).toEqual(definition.validator)
        const actual = await context.db.collection(name).indexes()
        for (const index of INDEXING_JOB_INDEXES[name]) expect(actual.find(({ name: actualName }) => actualName === index.name)?.key).toEqual(index.key)
      }
      const articleIndexes = await context.db.collection('articles').indexes()
      for (const index of INDEXING_ARTICLE_INDEXES) expect(articleIndexes.find(({ name }) => name === index.name)?.key).toEqual(index.key)

      const repository = new MongoProviderAdmissionRepository(context)
      const domain = { admissionDomainId: 'shared-test', provider: 'openrouter', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' }
      const now = new Date('2026-08-10T00:00:00.000Z')
      const first = await repository.reserveProviderCall({ domain, route: { routeId: 'primary', admissionDomainId: 'shared-test' }, reservationId: 'reservation-primary', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
      const blocked = await repository.reserveProviderCall({ domain, route: { routeId: 'fallback', admissionDomainId: 'shared-test' }, reservationId: 'reservation-fallback', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
      expect(first.allowed).toBe(true)
      expect(blocked).toEqual(expect.objectContaining({ allowed: false, reason: 'concurrency-limit' }))
      await repository.releaseProviderCall({ admissionDomainId: 'shared-test', routeId: 'primary', reservationId: 'reservation-primary', outcome: 'succeeded', now })
      await expect(repository.reserveProviderCall({ domain, route: { routeId: 'fallback', admissionDomainId: 'shared-test' }, reservationId: 'reservation-fallback', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })).resolves.toEqual(expect.objectContaining({ allowed: true }))
    } finally {
      await context.db.dropDatabase()
      await client.close()
    }
  }, 60_000)
})
