import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { buildIngestionArtifactJobs, indexingJobDocument, MongoIndexingJobRepository, purgeAfterForIndexing, serializeIndexingJob } from '../../../server/repositories/mongo/indexing-job-repository.js'

const createdAt = new Date('2026-08-10T00:00:00.000Z')
const embeddingTarget = { dimensions: 3, version: 7, artifactCompatibilityId: 'embedding-compat-v1' }
const job = {
  id: '507f1f77bcf86cd799439041', idempotencyKey: 'indexing-test-key', actorScope: 'admin:opaque', requestHash: 'a'.repeat(64),
  articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439021', expectedSourcePolicyVersion: 4,
  task: 'embedding', trigger: 'admin', requestedBy: '507f1f77bcf86cd799439001', status: 'queued', attempt: 1, priority: 50,
  availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + 30 * 60_000), idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * 24 * 60 * 60_000),
  leaseGeneration: 0, targetEmbeddingVersion: 1, createdAt, updatedAt: createdAt,
}

describe('Step 9 indexing Mongo repository documents', () => {
  it('round-trips exact task identity and version metadata with Mongo ObjectIds', () => {
    const document = indexingJobDocument(job)
    expect(document).toEqual(expect.objectContaining({ _id: new ObjectId(job.id), articleId: new ObjectId(job.articleId), sourceId: new ObjectId(job.sourceId), task: 'embedding', targetEmbeddingVersion: 1 }))
    expect(serializeIndexingJob(document)).toEqual(expect.objectContaining({ id: job.id, articleId: job.articleId, sourceId: job.sourceId, task: 'embedding', targetEmbeddingVersion: 1 }))
  })

  it('never purges before idempotency expiry and retains failed/partial for thirty days', () => {
    const finishedAt = new Date('2026-08-11T00:00:00.000Z')
    const earlyExpiry = new Date('2026-08-12T00:00:00.000Z')
    const lateExpiry = new Date('2026-10-01T00:00:00.000Z')
    expect(purgeAfterForIndexing('failed', finishedAt, earlyExpiry)).toEqual(new Date('2026-09-10T00:00:00.000Z'))
    expect(purgeAfterForIndexing('succeeded', finishedAt, lateExpiry)).toEqual(lateExpiry)
  })

  it('fans each ingested article into independent, deterministic summary and embedding jobs', () => {
    const source = {
      id: job.sourceId, policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'excerpt',
      storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, technicalCheck: { status: 'passed' },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false, attributionText: null,
    }
    const article = { id: job.articleId, status: 'published', titleOriginal: 'A safe title', excerptOriginal: 'A bounded excerpt', topics: ['ai'], sourceLanguage: 'en' }
    const first = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    const replay = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    expect(first.map(({ task }) => task)).toEqual(['summary', 'embedding'])
    expect(first.map(({ trigger }) => trigger)).toEqual(['ingestion', 'ingestion'])
    expect(first.map(({ idempotencyKey }) => idempotencyKey)).toEqual(replay.map(({ idempotencyKey }) => idempotencyKey))
    expect(first.find(({ task }) => task === 'embedding')).toEqual(expect.objectContaining({ targetEmbeddingVersion: embeddingTarget.version, targetEmbeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId }))
    expect(JSON.stringify(first)).not.toContain(article.excerptOriginal)
  })

  it('changes embedding identity and request hash when version or compatibility target changes', () => {
    const source = { id: job.sourceId, policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, technicalCheck: { status: 'passed' }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false } }
    const article = { id: job.articleId, status: 'published', titleOriginal: 'A safe title', excerptOriginal: 'A bounded excerpt', topics: ['ai'], sourceLanguage: 'en' }
    const first = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    const changed = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget: { ...embeddingTarget, version: 8, artifactCompatibilityId: 'embedding-compat-v2' } })
    const firstEmbedding = first.find(({ task }) => task === 'embedding')
    const changedEmbedding = changed.find(({ task }) => task === 'embedding')
    expect(changedEmbedding.idempotencyKey).not.toBe(firstEmbedding.idempotencyKey)
    expect(changedEmbedding.requestHash).not.toBe(firstEmbedding.requestHash)
  })

  it('selects one due task while excluding articles already active in the drain', async () => {
    const filters = []
    const hints = []
    const cursor = {
      sort() { return this },
      hint(name) { hints.push(name); return this },
      limit() { return this },
      async next() { return null },
    }
    const collection = { find: vi.fn((filter) => { filters.push(filter); return cursor }) }
    const repository = new MongoIndexingJobRepository({
      client: {},
      db: { collection: vi.fn(() => collection) },
      now: () => createdAt,
    })

    await expect(repository.selectDueIndexing({
      now: createdAt,
      task: 'summary',
      excludeArticleIds: [job.articleId],
    })).resolves.toBeNull()

    expect(filters).toHaveLength(2)
    expect(filters[0]).toEqual(expect.objectContaining({
      status: 'queued',
      task: 'summary',
      articleId: { $nin: [new ObjectId(job.articleId)] },
      agingEligibleAt: { $lte: createdAt },
    }))
    expect(filters[1]).toEqual(expect.objectContaining({ agingEligibleAt: { $gt: createdAt } }))
    expect(hints).toEqual(['indexing_drain_task_aged', 'indexing_drain_task_normal'])
    await expect(repository.selectDueIndexing({ now: createdAt, task: 'unknown' })).rejects.toThrow(/task filter/i)
    await expect(repository.deferWithFence({ jobId: job.id, fence: {}, delayMs: 999 })).rejects.toThrow(/defer delay/i)
  })

  it.each([
    { attempt: 2, expectedStatus: 'pending', retriesCreated: 1, parentStatus: 'failed', cancelled: false },
    { attempt: 3, expectedStatus: 'failed', retriesCreated: 0, parentStatus: 'failed', cancelled: false },
    { attempt: 2, expectedStatus: 'pending', retriesCreated: 0, parentStatus: 'cancelled', cancelled: true },
  ])('repairs a processing summary after expired attempt $attempt (cancelled: $cancelled)', async ({ attempt, expectedStatus, retriesCreated, parentStatus, cancelled }) => {
    const expiredAt = new Date(createdAt.getTime() + 60_000)
    const parent = indexingJobDocument({
      ...job,
      status: 'running',
      task: 'summary',
      attempt,
      leaseGeneration: 2,
      startedAt: createdAt,
      heartbeatAt: createdAt,
      ...(cancelled ? { cancellationRequestedAt: createdAt } : {}),
      updatedAt: createdAt,
    })
    const snapshot = {
      _id: new ObjectId('507f1f77bcf86cd799439099'),
      key: `indexing:article:${job.articleId}`,
      activeOwner: {
        jobId: parent._id,
        ownerTokenHash: 'a'.repeat(64),
        leaseGeneration: 2,
        expiresAt: createdAt,
      },
    }
    const jobs = {
      findOne: vi.fn(async () => parent),
      updateOne: vi.fn(async (_filter, update) => ({ matchedCount: 1, upsertedCount: update?.$setOnInsert ? 1 : 0 })),
    }
    const articles = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const leases = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const audits = { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => ({ acknowledged: true })) }
    const collections = { indexingJobs: jobs, articles, jobLeases: leases, adminAuditLogs: audits }
    const session = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn(async () => {}) }
    const repository = new MongoIndexingJobRepository({
      client: { startSession: () => session },
      db: { collection: (name) => collections[name] },
      now: () => expiredAt,
    })

    await expect(repository.recoverExpiredIndexing({
      leaseRepository: { listExpired: vi.fn(async () => [snapshot]) },
      now: expiredAt,
      limit: 1,
    })).resolves.toEqual({ inspected: 1, recovered: 1, retriesCreated, failed: 0 })

    expect(articles.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: parent.articleId, summaryStatus: 'processing' }),
      expect.objectContaining({ $set: expect.objectContaining({ summaryStatus: expectedStatus, summaryParagraphsVi: null, summaryDetailStatus: expectedStatus }) }),
      { session },
    )
    expect(jobs.updateOne.mock.calls[0][1]).toEqual(expect.objectContaining({ $set: expect.objectContaining({ status: parentStatus }) }))
  })
})
