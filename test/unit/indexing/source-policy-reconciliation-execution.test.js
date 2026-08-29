import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'
import { createSourcePolicyReconciliationWorker } from '../../../server/application/indexing/source-policy-reconciliation.js'
import { MongoIndexingJobRepository } from '../../../server/repositories/mongo/indexing-job-repository.js'
import { MongoSourceRepository } from '../../../server/repositories/mongo/source-repository.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const articleIds = [new ObjectId('507f1f77bcf86cd799439021'), new ObjectId('507f1f77bcf86cd799439022')]
const now = new Date('2026-08-29T01:00:00.000Z')
const fence = {
  key: `reconciliation:source:${sourceId.toHexString()}`,
  jobId: sourceId.toHexString(),
  ownerTokenHash: 'a'.repeat(64),
  leaseGeneration: 1,
  expiresAt: new Date(now.getTime() + 60_000),
}

function source() {
  return {
    _id: sourceId,
    sourceKey: 'demo:hn-topstories',
    operationalStatus: 'paused',
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
    policyVersion: 8,
    reconciliation: { status: 'pending', requiredPolicyVersion: 8, completedPolicyVersion: null, requestedAt: now, error: null },
    technicalCheck: { status: 'passed' },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  }
}

describe('source policy reconciliation canonical execution', () => {
  it('creates one exact visibility job per article and converges on replay', async () => {
    const mongo = createStep11Mongo({
      app: {
        sources: [source()],
        articles: articleIds.map((_id) => ({ _id, sourceId, status: 'published', rightsSnapshot: { sourcePolicyVersion: 2 } })),
        indexingJobs: [],
        jobLeases: [{
          _id: new ObjectId('507f1f77bcf86cd799439031'), key: fence.key,
          activeOwner: { jobId: sourceId, ownerTokenHash: fence.ownerTokenHash, leaseGeneration: 1, expiresAt: fence.expiresAt },
        }],
      },
    })
    const jobsCollection = mongo.db.collection('indexingJobs')
    const updateOne = jobsCollection.updateOne.bind(jobsCollection)
    jobsCollection.updateOne = async (filter, update, options = {}) => {
      if (options.upsert && !(await jobsCollection.findOne(filter))) {
        await jobsCollection.insertOne(update.$setOnInsert)
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
      }
      return updateOne(filter, update, options)
    }
    const indexingJobRepository = new MongoIndexingJobRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const sourceRepository = new MongoSourceRepository({ db: mongo.db, client: mongo.client })
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => false),
      acquire: vi.fn(async () => fence),
      release: vi.fn(async () => true),
    }
    const worker = createSourcePolicyReconciliationWorker({ sourceRepository, indexingJobRepository, leaseRepository, now: () => now, ownerToken: () => 'source-owner-token' })

    const first = await worker.run({ sourceId: sourceId.toHexString(), dryRun: false, limit: 100, maxPages: 10 })
    const jobs = await mongo.db.collection('indexingJobs').find({}).toArray()
    const marker = (await mongo.db.collection('sources').findOne({ _id: sourceId })).reconciliation

    expect(first).toEqual(expect.objectContaining({ outcome: 'completed', inspected: 2, created: 2, pages: 1, hasMore: false }))
    expect(jobs).toHaveLength(2)
    expect(jobs.every((job) => job.actorScope === 'system-policy-reconciliation' && job.trigger === 'policy-change' && job.expectedSourcePolicyVersion === 8 && job.task === 'visibility-reconcile' && job.priority === 75)).toBe(true)
    expect(new Set(jobs.map((job) => job.idempotencyKey))).toHaveLength(2)
    expect(marker).toEqual(expect.objectContaining({ status: 'completed', requiredPolicyVersion: 8, completedPolicyVersion: 8, error: null }))
    expect(marker.cursorArticleId).toBeUndefined()

    const replay = await worker.run({ sourceId: sourceId.toHexString(), dryRun: false, limit: 100, maxPages: 10 })
    expect(replay.outcome).toBe('skipped')
    expect(await mongo.db.collection('indexingJobs').countDocuments({})).toBe(2)
    expect(leaseRepository.acquire).toHaveBeenCalledOnce()
  })
})
