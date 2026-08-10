import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { MongoClient, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoJobRepository } from '../../server/repositories/mongo/job-repository.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/durable-jobs.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

function runMigration(target, database) {
  return spawnSync(process.execPath, ['scripts/db-migrate.js', '--to', target], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MONGODB_URI_ENV: 'STEP4_MIGRATION_URI', STEP4_MIGRATION_URI: process.env.MONGODB_TEST_URI, MONGODB_DATABASE: database },
  })
}

function runVerify(target, database) {
  return spawnSync(process.execPath, ['scripts/db-verify.js', target], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MONGODB_URI_ENV: 'STEP4_MIGRATION_URI', STEP4_MIGRATION_URI: process.env.MONGODB_TEST_URI, MONGODB_DATABASE: database },
  })
}

function job({ id, suffix, sourceId, now, status = 'queued', purgeAfter, idempotencyExpiresAt } = {}) {
  return {
    id: id ?? new ObjectId().toHexString(), idempotencyKey: `step4-${suffix}-key`, actorScope: 'system:test', requestHash: createHash('sha256').update(suffix).digest('hex'),
    sourceId: sourceId.toHexString(), connectorType: 'rss', expectedSourcePolicyVersion: 1, trigger: 'cron', status, attempt: 1, priority: 0,
    availableAt: now, agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), idempotencyExpiresAt: idempotencyExpiresAt ?? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    leaseGeneration: 0, batchSize: 20, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 },
    ...(status !== 'queued' ? { finishedAt: now } : {}), ...(purgeAfter ? { purgeAfter } : {}), createdAt: now, updatedAt: now,
  }
}

function stages(explain) {
  const result = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.stage) result.push(value.stage)
    for (const nested of Object.values(value)) visit(nested)
  }
  visit(explain.queryPlanner?.winningPlan)
  return result
}

describeMongo('Step 4 durable-jobs migration and retention', () => {
  it('preserves the exact durable audit validator across reverse-order CLI dispatch', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_order')
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs', 'auth-core', 'sources']) {
        const result = runMigration(target, database)
        expect(result.status, result.stderr).toBe(0)
      }
      const audit = (await context.db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
      expect(audit.options.validator).toEqual(DURABLE_JOB_AUDIT_VALIDATOR)
      for (const target of ['auth-core', 'sources', 'durable-jobs']) {
        const verified = runVerify(target, database)
        expect(verified.status, verified.stderr).toBe(0)
      }
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('uses both due lanes and stable purge deadline indexes without blocking sort', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_idx')
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs']) expect(runMigration(target, database).status).toBe(0)
      const now = new Date('2026-08-10T04:00:00.000Z')
      const jobs = context.db.collection('ingestionJobs')
      const normal = await jobs.find({ status: 'queued', availableAt: { $lte: now } }).sort({ priority: -1, availableAt: 1, createdAt: 1, _id: 1 }).hint('ingestion_due_normal').explain('queryPlanner')
      const aged = await jobs.find({ status: 'queued', agingEligibleAt: { $lte: now }, availableAt: { $lte: now } }).sort({ agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 }).hint('ingestion_due_aged').explain('queryPlanner')
      const purge = await jobs.find({ purgeAfter: { $lte: now } }).sort({ purgeAfter: 1, _id: 1 }).hint('ingestion_purge_deadline').explain('queryPlanner')
      for (const plan of [normal, aged, purge]) expect(stages(plan)).not.toEqual(expect.arrayContaining(['COLLSCAN', 'SORT']))
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('paginates equal purge deadlines by _id and never purges inside the idempotency floor', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_purge')
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs']) expect(runMigration(target, database).status).toBe(0)
      const repository = new MongoJobRepository(context)
      const sourceId = new ObjectId()
      const createdAt = new Date('2026-06-01T00:00:00.000Z')
      const cutoff = new Date('2026-08-10T00:00:00.000Z')
      const deadline = new Date('2026-08-01T00:00:00.000Z')
      const ids = ['000000000000000000000001', '000000000000000000000002', '000000000000000000000003']
      for (let index = 0; index < ids.length; index += 1) await repository.createSystemIngestionJob({ job: job({ id: ids[index], suffix: `purge-${index}`, sourceId, now: createdAt, status: 'succeeded', purgeAfter: deadline, idempotencyExpiresAt: deadline }) })
      await repository.createSystemIngestionJob({ job: job({ suffix: 'protected', sourceId, now: createdAt, status: 'succeeded', purgeAfter: deadline, idempotencyExpiresAt: new Date('2026-08-20T00:00:00.000Z') }) })
      await expect(repository.purgeDueIngestionJobs({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
      expect(await context.db.collection('ingestionJobs').find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }).sort({ _id: 1 }).project({ _id: 1 }).toArray()).toEqual([{ _id: new ObjectId(ids[2]) }])
      const second = await repository.purgeDueIngestionJobs({ cutoff, limit: 2 })
      expect(second).toEqual({ inspected: 1, affected: 1, hasMore: false })
      expect(await context.db.collection('ingestionJobs').countDocuments()).toBe(1)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('fails db:verify for an unexpected partial filter on the actor-idempotency unique index', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('idx_drift')
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs']) expect(runMigration(target, database).status).toBe(0)
      const collection = context.db.collection('ingestionJobs')
      await collection.dropIndex('ingestion_actor_idempotency_unique')
      await collection.createIndex({ actorScope: 1, idempotencyKey: 1 }, {
        name: 'ingestion_actor_idempotency_unique', unique: true,
        partialFilterExpression: { actorScope: { $exists: true } },
      })
      const verified = runVerify('durable-jobs', database)
      expect(verified.status).not.toBe(0)
      expect(`${verified.stdout}\n${verified.stderr}`).toMatch(/partial|index/i)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)
})
