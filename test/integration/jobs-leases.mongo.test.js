import { MongoClient, ObjectId } from 'mongodb'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../server/app.js'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { runSourcesMigration } from '../../scripts/migrations/sources.js'
import { runDurableJobsMigration } from '../../scripts/migrations/durable-jobs.js'
import { MongoJobRepository } from '../../server/repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../../server/repositories/mongo/lease-repository.js'
import { deriveLeaseKey } from '../../server/domain/jobs/lease-keys.js'
import { createIngestionQueueAdapter } from '../../server/jobs/ingestion-queue.js'
import { assertDurableJobsReady, createCronDueWorkRunner } from '../../server/bootstrap/jobs.js'
import { createJobAuditEvent } from '../../server/audit/job-writer.js'
import { canonicalRequestHash } from '../../server/domain/jobs/idempotency.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

function jobDocument(sourceId, suffix, now) {
  return {
    id: new ObjectId().toHexString(), idempotencyKey: `integration-${suffix}-0001`, actorScope: 'system:test', requestHash: createHash('sha256').update(suffix).digest('hex'),
    sourceId: sourceId.toHexString(), connectorType: 'rss', expectedSourcePolicyVersion: 1, trigger: 'cron', status: 'queued', attempt: 1, priority: 0,
    availableAt: now, agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), idempotencyExpiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
    leaseGeneration: 0, batchSize: 20, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }, createdAt: now, updatedAt: now,
  }
}

function activeSourceDocument(sourceId, now, overrides = {}) {
  return {
    _id: sourceId, name: 'Example', sourceKey: `rss:source-${sourceId.toHexString().slice(-6)}`, publisherName: 'Example', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    operationalStatus: 'active', licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false, attributionText: null, termsUrl: null, licenseUrl: null, evidenceNote: 'reviewed', reviewedAt: now, reviewedBy: new ObjectId(), policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null }, technicalCheck: { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }, health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null }, createdAt: now, updatedAt: now,
    ...overrides,
  }
}

describeMongo('durable jobs and lease fencing', () => {
  it('preserves high-water, rejects expired heartbeat and fences stale completion after recovery', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_lease')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const sourceId = new ObjectId()
      const start = new Date('2026-08-10T00:00:00.000Z')
      let authoritativeNow = start
      const runtimeContext = { ...context, now: () => authoritativeNow }
      const jobs = new MongoJobRepository(runtimeContext)
      const leases = new MongoLeaseRepository(runtimeContext)
      const parent = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'parent', start) })
      const key = deriveLeaseKey('ingestion', sourceId.toHexString())
      const first = await leases.acquire({ key, jobId: parent.id, ownerToken: 'owner-token-one', now: start, leaseMs: 1000 })
      expect(first.leaseGeneration).toBe(1)
      expect(await jobs.claimQueuedWithFence({ jobId: parent.id, fence: first, now: start })).toBe(true)
      authoritativeNow = new Date(start.getTime() + 2000)
      expect(await leases.heartbeat({ ...first, ownerToken: 'owner-token-one', now: new Date(start.getTime() + 2000), leaseMs: 1000 })).toBe(false)

      const recovered = await jobs.recoverExpiredIngestion({ leaseRepository: leases, now: new Date(start.getTime() + 2000), limit: 10 })
      expect(recovered).toEqual(expect.objectContaining({ recovered: 1, retriesCreated: 1 }))
      const parentAfter = await jobs.findIngestionJobById(parent.id)
      expect(parentAfter.status).toBe('failed')
      expect(parentAfter.purgeAfter.getTime() - (start.getTime() + 2000)).toBe(30 * 24 * 60 * 60 * 1000)
      const children = await context.db.collection('ingestionJobs').find({ parentJobId: new ObjectId(parent.id) }).toArray()
      expect(children).toHaveLength(1)

      authoritativeNow = new Date(start.getTime() + 2001)
      const second = await leases.acquire({ key, jobId: children[0]._id.toHexString(), ownerToken: 'owner-token-two', now: new Date(start.getTime() + 2001), leaseMs: 1000 })
      expect(second.leaseGeneration).toBe(2)
      await expect(jobs.completeWithFence({ jobId: parent.id, fence: first, ownerToken: 'owner-token-one', status: 'succeeded', now: new Date(start.getTime() + 2100) })).rejects.toThrow(/lease fence/i)
      const lease = await context.db.collection('jobLeases').findOne({ key })
      expect(Number(lease.generationHighWater)).toBe(2)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('selects aged lane before normal priority and reuses system idempotency exactly', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_due')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const sourceId = new ObjectId()
      const now = new Date('2026-08-10T01:00:00.000Z')
      const aged = jobDocument(sourceId, 'aged', new Date(now.getTime() - 60 * 60 * 1000)); aged.priority = -50; aged.agingEligibleAt = new Date(now.getTime() - 30 * 60 * 1000)
      const normal = jobDocument(sourceId, 'normal', new Date(now.getTime() - 1000)); normal.priority = 100
      const first = await jobs.createSystemIngestionJob({ job: aged })
      const replay = await jobs.createSystemIngestionJob({ job: { ...aged, id: new ObjectId().toHexString() } })
      await jobs.createSystemIngestionJob({ job: normal })
      expect(replay.id).toBe(first.id)
      expect((await jobs.selectDueIngestion({ now })).id).toBe(first.id)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('converges concurrent duplicate jobs and permits only one canonical lease owner', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_race')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)
      const sourceId = new ObjectId()
      const now = new Date('2026-08-10T02:00:00.000Z')
      const intent = jobDocument(sourceId, 'race', now)
      const results = await Promise.all(Array.from({ length: 8 }, () => jobs.createSystemIngestionJob({ job: { ...intent, id: new ObjectId().toHexString() } })))
      expect(new Set(results.map(({ id }) => id)).size).toBe(1)
      expect(await context.db.collection('ingestionJobs').countDocuments()).toBe(1)
      await expect(jobs.createSystemIngestionJob({ job: { ...intent, id: new ObjectId().toHexString(), requestHash: createHash('sha256').update('different-intent').digest('hex') } })).rejects.toEqual(expect.objectContaining({ status: 409, code: 'idempotency_mismatch' }))

      const key = deriveLeaseKey('ingestion', sourceId.toHexString())
      const acquisitions = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => leases.acquire({ key, jobId: results[0].id, ownerToken: `concurrent-owner-${index}`, now, leaseMs: 1000 })))
      expect(acquisitions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(acquisitions.filter(({ status }) => status === 'rejected').every(({ reason }) => reason?.status === 409)).toBe(true)
      const lease = await context.db.collection('jobLeases').findOne({ key })
      expect(Number(lease.generationHighWater)).toBe(1)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('heartbeats and commits a terminal result only through the exact live fence', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_done')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const sourceId = new ObjectId()
      const start = new Date('2026-08-10T03:00:00.000Z')
      let authoritativeNow = start
      const runtimeContext = { ...context, now: () => authoritativeNow }
      const jobs = new MongoJobRepository(runtimeContext)
      const leases = new MongoLeaseRepository(runtimeContext)
      await context.db.collection('sources').insertOne(activeSourceDocument(sourceId, start))
      const created = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'complete', start) })
      const key = deriveLeaseKey('ingestion', sourceId.toHexString())
      const fence = await leases.acquire({ key, jobId: created.id, ownerToken: 'terminal-owner-token', now: start, leaseMs: 2000 })
      expect(await jobs.claimQueuedWithFence({ jobId: created.id, fence, now: start })).toBe(true)
      await expect(leases.heartbeat({ ...fence, ownerToken: 'terminal-owner-token', now: new Date(start.getTime() + 100), leaseMs: 0 })).rejects.toThrow(/duration/i)
      authoritativeNow = new Date(start.getTime() + 500)
      expect(await leases.heartbeat({ ...fence, ownerToken: 'terminal-owner-token', now: new Date(start.getTime() + 500), leaseMs: 2000 })).toBe(true)
      const finishedAt = new Date(start.getTime() + 1000)
      authoritativeNow = finishedAt
      const completed = await jobs.completeWithFence({
        jobId: created.id, fence, status: 'succeeded', checkpoint: { cursor: 'next', processedCount: 1 },
        counters: { fetched: 1, created: 0, updated: 0, duplicate: 1, skipped: 0, failed: 0 }, finishedAt, now: finishedAt,
      })
      expect(completed).toEqual(expect.objectContaining({ status: 'succeeded', checkpoint: { cursor: 'next', processedCount: 1 } }))
      const lease = await context.db.collection('jobLeases').findOne({ key })
      expect(lease.activeOwner).toBeUndefined()
      expect(Number(lease.generationHighWater)).toBe(1)
      expect(completed.purgeAfter.getTime() - finishedAt.getTime()).toBe(14 * 24 * 60 * 60 * 1000)

      const deferredJob = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'deferred', finishedAt) })
      const adapter = createIngestionQueueAdapter({ jobRepository: jobs, leaseRepository: leases, ownerToken: () => 'deferred-owner-token' })
      await expect(adapter.claimAndExecute({ candidate: deferredJob, now: finishedAt })).resolves.toEqual({ status: 'deferred', claimed: true })
      const deferredAfter = await jobs.findIngestionJobById(deferredJob.id)
      expect(deferredAfter.status).toBe('queued')
      expect(deferredAfter.availableAt.getTime()).toBe(finishedAt.getTime() + 5 * 60 * 1000)
      expect(deferredAfter.leaseGeneration).toBe(0)
      const leaseAfterDefer = await context.db.collection('jobLeases').findOne({ key })
      expect(leaseAfterDefer.activeOwner).toBeUndefined()
      expect(Number(leaseAfterDefer.generationHighWater)).toBe(2)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('discards completion checkpoint and counters when the source policy changes mid-run', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('job_policy')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const sourceId = new ObjectId()
      const start = new Date('2026-08-10T04:00:00.000Z')
      let authoritativeNow = start
      const runtimeContext = { ...context, now: () => authoritativeNow }
      const jobs = new MongoJobRepository(runtimeContext)
      const leases = new MongoLeaseRepository(runtimeContext)
      await context.db.collection('sources').insertOne(activeSourceDocument(sourceId, start))
      const job = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'policy-fence', start) })
      const fence = await leases.acquire({ key: deriveLeaseKey('ingestion', sourceId.toHexString()), jobId: job.id, ownerToken: 'policy-fence-owner', leaseMs: 30_000 })
      expect(await jobs.claimQueuedWithFence({ jobId: job.id, fence })).toBe(true)
      await context.db.collection('sources').deleteOne({ _id: sourceId })
      authoritativeNow = new Date(start.getTime() + 1000)
      const completed = await jobs.completeWithFence({ jobId: job.id, fence, status: 'succeeded', checkpoint: { cursor: 'unsafe-advance', processedCount: 7 }, counters: { fetched: 7, created: 7, updated: 0, duplicate: 0, skipped: 0, failed: 0 } })
      expect(completed).toEqual(expect.objectContaining({ status: 'failed', checkpoint: undefined, error: expect.objectContaining({ code: 'source_policy_changed_mid_run', retryable: false }) }))
      expect(completed.counters).toEqual({ fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 })
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('rejects an unexpected TTL index on persistent job leases during readiness', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('job_ttl')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      await context.db.collection('jobLeases').createIndex({ updatedAt: 1 }, { name: 'unexpected_lease_ttl', expireAfterSeconds: 0 })
      await expect(assertDurableJobsReady(context)).rejects.toThrow(/indexes/i)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('converges concurrent distinct-idempotency linked retries to one parent attempt', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('job_retry')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const sourceId = new ObjectId()
      const now = new Date('2026-08-10T05:00:00.000Z')
      const parent = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'retry-parent', now) })
      const one = jobDocument(sourceId, 'retry-one', now)
      const two = jobDocument(sourceId, 'retry-two', now)
      for (const job of [one, two]) {
        job.parentJobId = parent.id
        job.attempt = 2
        job.trigger = 'retry'
        job.actorScope = 'system-recovery'
      }
      two.requestHash = one.requestHash
      const results = await Promise.all([jobs.createSystemIngestionJob({ job: one }), jobs.createSystemIngestionJob({ job: two })])
      expect(new Set(results.map((item) => item.id)).size).toBe(1)
      expect(await context.db.collection('ingestionJobs').countDocuments({ parentJobId: new ObjectId(parent.id), attempt: 2 })).toBe(1)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('materializes bounded daily intents only for active eligible sources and converges duplicate cron runs', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('job_cron')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const now = new Date('2026-08-10T06:00:00.000Z')
      const eligibleOne = new ObjectId()
      const eligibleTwo = new ObjectId()
      const inactive = new ObjectId()
      await context.db.collection('sources').insertMany([
        activeSourceDocument(eligibleOne, now),
        activeSourceDocument(eligibleTwo, now),
        activeSourceDocument(inactive, now, { operationalStatus: 'paused' }),
      ])
      const first = await jobs.materializeDailyIngestion({ now, limit: 2 })
      const replay = await jobs.materializeDailyIngestion({ now, limit: 2 })
      expect(first).toEqual(expect.objectContaining({ inspected: 2, created: 2, hasMore: false, period: '2026-08-10' }))
      expect(replay).toEqual(expect.objectContaining({ created: 0 }))
      expect(await context.db.collection('ingestionJobs').countDocuments({ trigger: 'cron' })).toBe(2)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('continues bounded daily materialization across concurrent calls and rolls over per day', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('cron_cont')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const firstDay = new Date('2026-08-10T06:00:00.000Z')
      const sourceIds = Array.from({ length: 101 }, () => new ObjectId())
      await context.db.collection('sources').insertMany(sourceIds.map((sourceId) => activeSourceDocument(sourceId, firstDay)))

      const firstPass = await Promise.all([
        jobs.materializeDailyIngestion({ now: firstDay, limit: 100 }),
        jobs.materializeDailyIngestion({ now: firstDay, limit: 100 }),
      ])
      expect(firstPass.some((result) => result.hasMore)).toBe(true)
      expect(await context.db.collection('ingestionJobs').countDocuments({ trigger: 'cron' })).toBe(101)
      const replay = await jobs.materializeDailyIngestion({ now: firstDay, limit: 100 })
      expect(replay).toEqual(expect.objectContaining({ created: 0, hasMore: false, period: '2026-08-10' }))

      const nextDay = new Date('2026-08-11T06:00:00.000Z')
      await Promise.all([
        jobs.materializeDailyIngestion({ now: nextDay, limit: 100 }),
        jobs.materializeDailyIngestion({ now: nextDay, limit: 100 }),
      ])
      expect(await context.db.collection('ingestionJobs').countDocuments({ trigger: 'cron' })).toBe(202)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('production cron HTTP consumes the daily continuation in one invocation', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('cron_http')
    const context = createMongoContext({ client, database })
    let listener
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const now = new Date('2026-08-10T06:00:00.000Z')
      const sourceIds = Array.from({ length: 101 }, () => new ObjectId())
      await context.db.collection('sources').insertMany(sourceIds.map((sourceId) => activeSourceDocument(sourceId, now)))
      const jobs = new MongoJobRepository({ ...context, now: () => now })
      const coordinatorRunner = async () => ({
        runId: 'cron-http-run', startedAt: now, finishedAt: now,
        recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
        queues: {
          ingestion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
          indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
          accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        }, nextAvailableAt: null,
      })
      const dueWorkRunner = createCronDueWorkRunner({ jobRepository: jobs, coordinatorRunner, now: () => now })
      const app = createApp({ dueWorkRunner, machineSecret: 'step4-cron-http-secret' })
      listener = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)) })
      const origin = `http://127.0.0.1:${listener.address().port}`
      const response = await fetch(`${origin}/api/internal/cron/due-work`, { headers: { Authorization: 'Bearer step4-cron-http-secret' } })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual(expect.objectContaining({ data: expect.objectContaining({ runId: 'cron-http-run' }) }))
      expect(await context.db.collection('ingestionJobs').countDocuments({ trigger: 'cron' })).toBe(101)
    } finally {
      if (listener) await new Promise((resolve) => listener.close(resolve))
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('does not move a job aging deadline when repeated defers compete with normal priority work', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('defer_age')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const startedAt = new Date('2026-08-10T00:00:00.000Z')
      let authoritativeNow = new Date(startedAt)
      const runtimeContext = { ...context, now: () => authoritativeNow }
      const jobs = new MongoJobRepository(runtimeContext)
      const leases = new MongoLeaseRepository(runtimeContext)
      const sourceId = new ObjectId()
      const deferred = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'aging-deferred', startedAt) })
      const highPriority = jobDocument(sourceId, 'aging-high-priority', new Date(startedAt.getTime() + 29 * 60 * 1000))
      highPriority.priority = 100
      await jobs.createSystemIngestionJob({ job: highPriority })
      const key = deriveLeaseKey('ingestion', sourceId.toHexString())

      authoritativeNow = new Date(startedAt.getTime() + 29 * 60 * 1000)
      const firstFence = await leases.acquire({ key, jobId: deferred.id, ownerToken: 'aging-first', now: authoritativeNow, leaseMs: 10_000 })
      expect(await jobs.claimQueuedWithFence({ jobId: deferred.id, fence: firstFence })).toBe(true)
      await jobs.deferWithFence({ jobId: deferred.id, fence: firstFence, delayMs: 1000 })
      authoritativeNow = new Date(authoritativeNow.getTime() + 1000)
      const secondFence = await leases.acquire({ key, jobId: deferred.id, ownerToken: 'aging-second', now: authoritativeNow, leaseMs: 10_000 })
      expect(await jobs.claimQueuedWithFence({ jobId: deferred.id, fence: secondFence })).toBe(true)
      await jobs.deferWithFence({ jobId: deferred.id, fence: secondFence, delayMs: 1000 })

      const after = await jobs.findIngestionJobById(deferred.id)
      expect(after.agingEligibleAt).toEqual(new Date(startedAt.getTime() + 30 * 60 * 1000))
      authoritativeNow = new Date(startedAt.getTime() + 30 * 60 * 1000)
      expect((await jobs.selectDueIngestion({ now: authoritativeNow })).id).toBe(deferred.id)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('keeps one canonical child when manual linked retry races expired-lease recovery', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('manrec')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const startedAt = new Date('2026-08-10T07:00:00.000Z')
      let authoritativeNow = new Date(startedAt)
      const runtimeContext = { ...context, now: () => authoritativeNow }
      const jobs = new MongoJobRepository(runtimeContext)
      const leases = new MongoLeaseRepository(runtimeContext)
      jobs.assertActorFence = async () => true
      const sourceId = new ObjectId()
      const parent = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'manual-recovery-parent', startedAt) })
      const key = deriveLeaseKey('ingestion', sourceId.toHexString())
      const fence = await leases.acquire({ key, jobId: parent.id, ownerToken: 'manual-recovery-owner', now: startedAt, leaseMs: 1000 })
      expect(await jobs.claimQueuedWithFence({ jobId: parent.id, fence })).toBe(true)
      authoritativeNow = new Date(startedAt.getTime() + 2000)

      const child = jobDocument(sourceId, 'manual-recovery-child', authoritativeNow)
      child.actorScope = 'admin:507f1f77bcf86cd799439011:session:507f1f77bcf86cd799439012:v1'
      child.idempotencyKey = 'manual-recovery-key-0001'
      child.parentJobId = parent.id
      child.attempt = 2
      child.trigger = 'retry'
      child.requestHash = canonicalRequestHash({ operation: 'retry-ingestion-job', parentJobId: parent.id, nextAttempt: 2 })
      const audit = createJobAuditEvent({
        actor: { id: '507f1f77bcf86cd799439011', role: 'admin' }, action: 'ingestion_job_retry_created', targetId: child.id,
        changedFields: ['status', 'attempt', 'parentJobId'], reasonCode: 'job_retry_requested',
        request: { idempotencyKey: child.idempotencyKey, actorSessionId: '507f1f77bcf86cd799439012' }, createdAt: authoritativeNow,
      })
      const admission = { reserve: async () => ({ allowed: true }) }
      const outcomes = await Promise.allSettled([
        jobs.createOrReuseIngestionJobWithAdmission({ job: child, audit, actorFence: { userId: '507f1f77bcf86cd799439011', sessionId: '507f1f77bcf86cd799439012', sessionVersion: 1 }, rateLimitAdmission: admission, admission: { scope: 'admin-trigger', subject: '507f1f77bcf86cd799439011' }, parentJobId: parent.id, nextAttempt: 2 }),
        jobs.recoverExpiredIngestion({ leaseRepository: leases, now: authoritativeNow, limit: 1 }),
      ])
      expect(outcomes.every((outcome) => outcome.status === 'fulfilled' || outcome.reason?.code === 'idempotency_mismatch')).toBe(true)
      expect(await context.db.collection('ingestionJobs').countDocuments({ parentJobId: new ObjectId(parent.id), attempt: 2 })).toBe(1)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('atomically reuses idempotent create and retry jobs without consuming a second admission slot', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('admit_idem')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      jobs.assertActorFence = async () => true
      const now = new Date('2026-08-10T08:00:00.000Z')
      const sourceId = new ObjectId()
      const actor = { id: '507f1f77bcf86cd799439011', role: 'admin' }
      const actorFence = { userId: actor.id, sessionId: '507f1f77bcf86cd799439012', sessionVersion: 1 }
      const rateLimitAdmission = {
        async reserve({ session }) {
          await context.db.collection('jobAdmissionProbe').updateOne({ _id: 'admin-trigger' }, { $inc: { count: 1 } }, { upsert: true, session })
          return { allowed: true }
        },
      }
      const buildManual = (suffix, key, hash) => {
        const job = jobDocument(sourceId, suffix, now)
        job.trigger = 'admin'
        job.actorScope = `admin:${actor.id}:session:${actorFence.sessionId}:v1`
        job.idempotencyKey = key
        job.requestHash = hash
        return job
      }
      const createHash = canonicalRequestHash({ operation: 'create-ingestion-job', sourceId: sourceId.toHexString(), batchSize: 20 })
      const createOne = buildManual('admission-create-one', 'admission-create-key', createHash)
      const createTwo = buildManual('admission-create-two', 'admission-create-key', createHash)
      const auditFor = (job) => createJobAuditEvent({
        actor, action: 'ingestion_job_created', targetId: job.id, changedFields: ['status'], reasonCode: 'ingestion_trigger_requested',
        request: { idempotencyKey: job.idempotencyKey, actorSessionId: actorFence.sessionId }, result: 'pending', createdAt: now,
      })
      const unavailable = buildManual('admission-unavailable', 'admission-unavailable-key', createHash)
      await expect(jobs.createOrReuseIngestionJobWithAdmission({
        job: unavailable, audit: auditFor(unavailable), actorFence,
        rateLimitAdmission: { reserve: async () => { throw new Error('limiter unavailable') } },
        admission: { scope: 'admin-trigger', subject: actor.id },
      })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
      expect(await context.db.collection('ingestionJobs').countDocuments({ idempotencyKey: unavailable.idempotencyKey })).toBe(0)
      expect(await context.db.collection('adminAuditLogs').countDocuments({ targetId: new ObjectId(unavailable.id) })).toBe(0)
      const first = await Promise.all([
        jobs.createOrReuseIngestionJobWithAdmission({ job: createOne, audit: auditFor(createOne), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id } }),
        jobs.createOrReuseIngestionJobWithAdmission({ job: createTwo, audit: auditFor(createTwo), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id } }),
      ])
      expect(new Set(first.map((job) => job.id)).size).toBe(1)
      expect(await context.db.collection('jobAdmissionProbe').findOne({ _id: 'admin-trigger' })).toMatchObject({ count: 1 })
      expect(await context.db.collection('adminAuditLogs').countDocuments({ action: 'ingestion_job_created' })).toBe(1)
      await jobs.createOrReuseIngestionJobWithAdmission({ job: createOne, audit: auditFor(createOne), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id } })
      await expect(jobs.createOrReuseIngestionJobWithAdmission({ job: { ...createOne, id: new ObjectId().toHexString(), requestHash: canonicalRequestHash({ changed: true }) }, audit: auditFor(createOne), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id } })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
      expect(await context.db.collection('jobAdmissionProbe').findOne({ _id: 'admin-trigger' })).toMatchObject({ count: 1 })

      const parent = await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, 'admission-retry-parent', now) })
      const retryHash = canonicalRequestHash({ operation: 'retry-ingestion-job', parentJobId: parent.id, nextAttempt: 2 })
      const retryOne = buildManual('admission-retry-one', 'admission-retry-key', retryHash)
      const retryTwo = buildManual('admission-retry-two', 'admission-retry-key', retryHash)
      for (const retry of [retryOne, retryTwo]) { retry.parentJobId = parent.id; retry.attempt = 2; retry.trigger = 'retry' }
      const retryAudit = (job) => createJobAuditEvent({
        actor, action: 'ingestion_job_retry_created', targetId: job.id, changedFields: ['status', 'attempt', 'parentJobId'], reasonCode: 'job_retry_requested',
        request: { idempotencyKey: job.idempotencyKey, actorSessionId: actorFence.sessionId }, result: 'pending', createdAt: now,
      })
      const retries = await Promise.all([
        jobs.createOrReuseIngestionJobWithAdmission({ job: retryOne, audit: retryAudit(retryOne), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id }, parentJobId: parent.id, nextAttempt: 2 }),
        jobs.createOrReuseIngestionJobWithAdmission({ job: retryTwo, audit: retryAudit(retryTwo), actorFence, rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id }, parentJobId: parent.id, nextAttempt: 2 }),
      ])
      expect(new Set(retries.map((job) => job.id)).size).toBe(1)
      expect(await context.db.collection('jobAdmissionProbe').findOne({ _id: 'admin-trigger' })).toMatchObject({ count: 2 })
      expect(await context.db.collection('ingestionJobs').countDocuments({ parentJobId: new ObjectId(parent.id), attempt: 2 })).toBe(1)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)

  it('lists durable jobs with stable cursor, filters and canonical input failures', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('jobs_list')
    const context = createMongoContext({ client, database })
    try {
      await runAuthCoreMigration({ db: context.db })
      await runSourcesMigration({ db: context.db })
      await runDurableJobsMigration({ db: context.db })
      const jobs = new MongoJobRepository(context)
      const sourceId = new ObjectId()
      const base = new Date('2026-08-10T04:00:00.000Z')
      for (let index = 0; index < 3; index += 1) await jobs.createSystemIngestionJob({ job: jobDocument(sourceId, `list-${index}`, new Date(base.getTime() + index)) })
      const first = await jobs.listIngestionJobs({ limit: 1, status: 'queued', sourceId: sourceId.toHexString() })
      expect(first).toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
      const second = await jobs.listIngestionJobs({ limit: 1, cursor: first.nextCursor })
      expect(second.jobs).toHaveLength(1)
      expect(second.jobs[0].id).not.toBe(first.jobs[0].id)
      await expect(jobs.listIngestionJobs({ limit: 0 })).rejects.toEqual(expect.objectContaining({ status: 400, code: 'bad_request' }))
      await expect(jobs.listIngestionJobs({ status: 'unknown' })).rejects.toEqual(expect.objectContaining({ status: 400 }))
      await expect(jobs.listIngestionJobs({ cursor: 'not-a-cursor' })).rejects.toEqual(expect.objectContaining({ status: 400 }))
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)
})
