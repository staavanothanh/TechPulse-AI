import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { buildPolicyDerivedInput } from '../../../server/ai/policy-input.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const JOB_ID = '507f1f77bcf86cd799439041'
const now = new Date('2026-08-10T01:00:00.000Z')
const fence = { key: `indexing:article:${ARTICLE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }

function setup({ leaseMatched = 1, task = 'summary', source, article } = {}) {
  const session = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn(async () => undefined) }
  const collections = {
    jobLeases: { updateOne: vi.fn(async () => ({ matchedCount: leaseMatched })) },
    indexingJobs: { findOne: vi.fn(async () => ({ _id: new ObjectId(JOB_ID), articleId: new ObjectId(ARTICLE_ID), sourceId: new ObjectId(SOURCE_ID), expectedSourcePolicyVersion: 4, task, status: 'running', leaseGeneration: 2 })), updateOne: vi.fn(async () => ({ upsertedCount: 1 })) },
    sources: { findOne: vi.fn(async () => source ?? ({ _id: new ObjectId(SOURCE_ID), id: SOURCE_ID, name: 'Tech Review', policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'metadata', technicalCheck: { status: 'passed' }, storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false } })) },
    articles: {
      findOne: vi.fn(async () => article ?? ({ _id: new ObjectId(ARTICLE_ID), sourceId: new ObjectId(SOURCE_ID), status: 'published', titleOriginal: 'Article', topics: [], publishedAt: now, summaryStatus: 'pending', updatedAt: now })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
  }
  const repository = new MongoArticleRepository({
    db: { collection: (name) => collections[name] }, client: { startSession: () => session }, now: () => now,
  })
  return { repository, collections, session }
}

describe('Step 9 Mongo artifact commit fence', () => {
  it('commits summary only after exact lease, running task, current source policy and published article match', async () => {
    const { repository, collections, session } = setup()
    const source = { id: SOURCE_ID, name: 'Tech Review', policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'metadata', technicalCheck: { status: 'passed' }, storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false } }
    const inputHash = buildPolicyDerivedInput({ article: { sourceId: SOURCE_ID, titleOriginal: 'Article', topics: [], publishedAt: now, summaryStatus: 'pending' }, source, purpose: 'summary' }).inputHash
    const committed = await repository.commitSummaryArtifact({
      job: { id: JOB_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID, task: 'summary' }, fence, expectedSourcePolicyVersion: 4, inputHash,
      summary: { titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tóm tắt tiếng Việt.', summaryStatus: 'ready', summaryBasis: 'metadata', summaryModel: 'summary-model', summaryInputHash: inputHash, summarySourcePolicyVersion: 4, summaryGeneratedAt: now, summaryError: null },
    })
    expect(committed).toBe(true)
    expect(collections.jobLeases.updateOne).toHaveBeenCalledWith(expect.objectContaining({
      key: fence.key, 'activeOwner.jobId': new ObjectId(JOB_ID), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
      'activeOwner.leaseGeneration': 2, 'activeOwner.expiresAt': { $gt: now },
    }), expect.any(Object), { session })
    expect(collections.sources.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: new ObjectId(SOURCE_ID), policyVersion: 4, operationalStatus: 'active', 'technicalCheck.status': 'passed', 'storageScope.summary': true,
    }), { session })
    expect(collections.articles.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: new ObjectId(ARTICLE_ID), sourceId: new ObjectId(SOURCE_ID), status: 'published' }), { $set: expect.objectContaining({ summaryStatus: 'ready', summarySourcePolicyVersion: 4, updatedAt: now }) }, { session })
    expect(collections.indexingJobs.updateOne).toHaveBeenCalledWith(expect.any(Object), { $setOnInsert: expect.objectContaining({ task: 'embedding', trigger: 'ingestion' }) }, expect.objectContaining({ upsert: true, session }))
  })

  it('discards output before touching article when the lease fence is stale', async () => {
    const { repository, collections } = setup({ leaseMatched: 0, task: 'embedding' })
    await expect(repository.commitEmbeddingArtifact({
      job: { id: JOB_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID, task: 'embedding' }, fence, expectedSourcePolicyVersion: 4, inputHash: 'b'.repeat(64),
      embedding: { embeddingStatus: 'ready', embedding: Array(1024).fill(0), embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingInputHash: 'b'.repeat(64), embeddingVersion: 1, embeddingSourcePolicyVersion: 4, embeddedAt: now, embeddingError: null },
    })).resolves.toBe(false)
    expect(collections.articles.updateOne).not.toHaveBeenCalled()
  })

  it('discards an artifact output whose captured input hash no longer matches the current article revision', async () => {
    const { repository, collections } = setup()
    await expect(repository.commitSummaryArtifact({
      job: { id: JOB_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID, task: 'summary' }, fence, expectedSourcePolicyVersion: 4, inputHash: 'b'.repeat(64),
      summary: { titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tóm tắt tiếng Việt.', summaryStatus: 'ready', summaryBasis: 'metadata', summaryModel: 'summary-model', summaryInputHash: 'b'.repeat(64), summarySourcePolicyVersion: 4, summaryGeneratedAt: now, summaryError: null },
    })).resolves.toBe(false)
    expect(collections.articles.updateOne).not.toHaveBeenCalled()
  })

  it('reconciles current policy by clearing denied artifacts and hiding no-longer-visible content', async () => {
    const blocked = {
      _id: new ObjectId(SOURCE_ID), policyVersion: 4, operationalStatus: 'paused', licenseStatus: 'blocked', llmInputScope: 'none',
      technicalCheck: { status: 'failed' }, storageScope: { metadata: false, excerpt: false, summary: false, embedding: false },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
      reconciliation: { status: 'processing', requiredPolicyVersion: 4 },
    }
    const { repository, collections } = setup({ task: 'visibility-reconcile', source: blocked, article: {
      _id: new ObjectId(ARTICLE_ID), sourceId: new ObjectId(SOURCE_ID), status: 'published', titleOriginal: 'Article', excerptOriginal: 'old excerpt',
      summaryStatus: 'ready', summaryVi: 'old summary', summarySourcePolicyVersion: 3, embeddingStatus: 'ready', embedding: [1], embeddingSourcePolicyVersion: 3,
      leadMedia: { type: 'image', url: 'https://media.example/image.jpg' }, leadMediaStatus: 'available',
    } })
    await expect(repository.reconcileArticleVisibility({ job: { id: JOB_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID, task: 'visibility-reconcile' }, fence, expectedSourcePolicyVersion: 4, now })).resolves.toBe(true)
    const update = collections.articles.updateOne.mock.calls[0][1]
    expect(update.$set).toEqual(expect.objectContaining({ status: 'hidden', summaryStatus: 'removed', summaryVi: null, embeddingStatus: 'removed', embedding: null, leadMedia: null, leadMediaStatus: 'hidden' }))
    expect(update.$unset).toEqual(expect.objectContaining({ excerptOriginal: '' }))
    expect(JSON.stringify(update)).not.toMatch(/Tóm tắt|providerPayload/)
  })

  it('does not reconcile an article when the source marker is not the exact captured version', async () => {
    const { repository, collections } = setup({ task: 'visibility-reconcile', source: null })
    collections.sources.findOne.mockResolvedValue(null)
    await expect(repository.reconcileArticleVisibility({ job: { id: JOB_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID, task: 'visibility-reconcile' }, fence, expectedSourcePolicyVersion: 4, now })).resolves.toBe(false)
    expect(collections.sources.findOne).toHaveBeenCalledTimes(1)
    expect(collections.articles.updateOne).not.toHaveBeenCalled()
  })
})
