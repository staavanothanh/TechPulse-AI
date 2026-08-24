import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const requestId = new ObjectId('507f1f77bcf86cd799439041')
const firstTarget = new ObjectId('507f1f77bcf86cd799439042')
const secondTarget = new ObjectId('507f1f77bcf86cd799439043')
const now = new Date('2026-08-14T00:00:00.000Z')

function makeContext({ articleStatus = 'hidden' } = {}) {
  const articles = {
    updateMany: vi.fn(async (filter) => {
      if (filter.status === articleStatus || filter.status?.$in?.includes(articleStatus)) return { matchedCount: filter._id?.$in?.length ?? 2, modifiedCount: 0 }
      return { matchedCount: 0, modifiedCount: 0 }
    }),
  }
  const governance = { insertOne: vi.fn(async (document) => ({ insertedId: document._id })) }
  const db = { collection: vi.fn((name) => name === 'articles' ? articles : { findOne: vi.fn() }) }
  return { context: { db, governanceDb: { collection: vi.fn(() => governance) }, governanceKeyring: { currentVersion: 7, digest: vi.fn((value) => value) }, now: () => now }, articles, governance }
}

describe('Mongo takedown repository integrity', () => {
  it('binds suppression digest and signature to the complete sorted request payload', async () => {
    const fixture = makeContext()
    const repository = new MongoTakedownRepository(fixture.context)
    const first = await repository.insertSuppression({ requestId, targetType: 'article', targetIds: [secondTarget, firstTarget], requestedScope: ['embedding', 'metadata'], now, session: {} })
    const second = await repository.insertSuppression({ requestId, targetType: 'article', targetIds: [firstTarget, secondTarget], requestedScope: ['metadata', 'summary'], now, session: {} })
    expect(first.payloadDigest).toContain(requestId.toHexString())
    expect(first.payloadDigest).toContain(firstTarget.toHexString())
    expect(first.payloadDigest).toContain(secondTarget.toHexString())
    expect(first.payloadDigest).toContain('embedding,metadata')
    expect(first.payloadDigest).toContain('7')
    expect(first.signature).not.toBe(second.signature)
    expect(fixture.governance.insertOne).toHaveBeenCalledTimes(2)
  })

  it('accepts an already hidden article as an idempotent hide-first fence', async () => {
    const fixture = makeContext({ articleStatus: 'hidden', evidenceEligible: false })
    const repository = new MongoTakedownRepository(fixture.context)
    await expect(repository.hideTargets({ targetType: 'article', targetIds: [firstTarget, secondTarget], reasonCode: 'takedown_completed', session: {}, now })).resolves.toBeUndefined()
    expect(fixture.articles.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: expect.objectContaining({ $in: expect.arrayContaining(['hidden']) }) }),
      expect.objectContaining({ $set: expect.objectContaining({ evidenceEligible: false }) }),
      expect.anything(),
    )
  })

  it('finalizes only persisted cleanup proof and does not rerun hide or cleanup work', async () => {
    const fixture = makeContext({ articleStatus: 'removed' })
    const workflow = {
      _id: requestId, status: 'approved', targetType: 'article', targetIds: [firstTarget], requestedScope: ['metadata'],
      completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true },
    }
    const requests = {
      findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set } })),
    }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'articles' ? fixture.articles : { findOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    repository.hideTargets = vi.fn()
    repository.cleanupArtifacts = vi.fn(() => { throw new Error('cleanup must run in materializer') })
    repository.insertAudit = vi.fn(async () => ({}))
    repository.insertSuppression = vi.fn(async () => ({}))
    const result = await repository.transition({ current: workflow, status: 'completed', reasonCode: 'takedown_completed', actor: { _id: new ObjectId('507f1f77bcf86cd799439044') }, request: { serverRequestId: 'finalize-1' }, session: {}, now })
    expect(result.status).toBe('completed')
    expect(repository.hideTargets).not.toHaveBeenCalled()
    expect(repository.cleanupArtifacts).not.toHaveBeenCalled()
    expect(repository.insertSuppression).toHaveBeenCalledOnce()
  })

  it('conditionally touches the hidden article lifecycle before terminal completion', async () => {
    const fixture = makeContext()
    const workflow = {
      _id: requestId, status: 'approved', targetType: 'article', targetIds: [firstTarget], requestedScope: ['metadata'],
      completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true },
    }
    const updates = []
    fixture.articles.updateMany = vi.fn(async (filter, update) => { updates.push({ filter, update }); return { matchedCount: 1 } })
    const requests = { findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set } })) }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'articles' ? fixture.articles : { findOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    const terminalFence = repository.assertTerminalTargetsCurrent.bind(repository)
    repository.assertTerminalTargetsCurrent = vi.fn(terminalFence)
    repository.insertAudit = vi.fn(async () => ({}))
    repository.insertSuppression = vi.fn(async () => ({}))
    await repository.transition({ current: workflow, status: 'completed', reasonCode: 'takedown_completed', actor: { _id: new ObjectId('507f1f77bcf86cd799439044') }, request: { serverRequestId: 'finalize-fence-1' }, session: {}, now })
    expect(repository.assertTerminalTargetsCurrent).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'article', targetIds: [firstTarget], requestedScope: ['metadata'], session: {} }))
  })

  it('exposes one bounded cleanup materialization transaction per invocation', async () => {
    const fixture = makeContext()
    const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
    fixture.context.client = { startSession: vi.fn(() => session) }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests'
      ? { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) }
      : name === 'articles' ? fixture.articles : { findOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    expect(repository.materializeCleanupBatch).toEqual(expect.any(Function))
    const result = await repository.materializeCleanupBatch({ now, limit: 100 })
    expect(result).toEqual(expect.objectContaining({ processed: false }))
  })

  it('clears rich summary fields when a scoped summary cleanup is materialized', async () => {
    const articles = {
      updateMany: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      countDocuments: vi.fn(async () => 1),
    }
    const chat = {
      find: vi.fn(() => ({ hint() { return this }, sort() { return this }, limit() { return this }, toArray: vi.fn(async () => []) })),
      countDocuments: vi.fn(async () => 0),
    }
    const context = { db: { collection: vi.fn((name) => name === 'articles' ? articles : name === 'chatSessions' ? chat : { findOne: vi.fn() }) }, now: () => now }
    const repository = new MongoTakedownRepository(context)
    await expect(repository.cleanupArtifacts({ targetType: 'article', targetIds: [firstTarget], requestedScope: ['summary'], session: {}, now })).resolves.toEqual(expect.objectContaining({ summaryRemoved: true }))
    expect(articles.updateMany).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ $set: expect.objectContaining({ summaryVi: null, summaryParagraphsVi: null, summaryStatus: 'removed', summaryDetailStatus: 'removed' }) }),
      expect.any(Object),
    )
  })

  it('keeps equal-deadline workflow purge reachable across bounded pages', async () => {
    const fixture = makeContext()
    const ids = [new ObjectId(), new ObjectId(), new ObjectId()]
    const deleteMany = vi.fn(async () => ({ deletedCount: 2 }))
    const requests = {
      find: vi.fn(() => ({ sort: vi.fn(() => ({ limit: vi.fn(() => ({ project: vi.fn(() => ({ toArray: vi.fn(async () => ids.map((_id) => ({ _id }))) })) })) })) })),
      deleteMany,
    }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : fixture.articles)
    const repository = new MongoTakedownRepository(fixture.context)

    await expect(repository.purgeWorkflows({ cutoff: now, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
    expect(deleteMany).toHaveBeenCalledWith({ status: { $in: ['rejected', 'completed'] }, workflowPurgeAfter: { $lte: now }, _id: { $in: ids.slice(0, 2) } })
  })

  it('starts both retention deadlines when a takedown is rejected', async () => {
    const fixture = makeContext()
    const workflow = { _id: requestId, status: 'reviewing', targetType: 'article', targetIds: [firstTarget], requestedScope: ['metadata'], completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false } }
    const requests = { findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set } })) }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'articles' ? fixture.articles : { findOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    repository.insertAudit = vi.fn(async () => ({}))
    repository.insertSuppression = vi.fn(async () => ({}))
    const rejected = await repository.transition({ current: workflow, status: 'rejected', reasonCode: 'takedown_rejected', actor: { _id: new ObjectId('507f1f77bcf86cd799439044') }, request: { serverRequestId: 'reject-1' }, session: {}, now })
    expect(rejected).toEqual(expect.objectContaining({ status: 'rejected', completedAt: now, piiPurgeAfter: new Date(now.getTime() + 90 * 86400000), workflowPurgeAfter: new Date(now.getTime() + 180 * 86400000) }))
    expect(repository.insertSuppression).not.toHaveBeenCalled()
  })

  it('redacts one bounded available-citation page and persists proof for the next invocation', async () => {
    const fixture = makeContext()
    const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
    fixture.context.client = { startSession: vi.fn(() => session) }
    const workflow = {
      _id: requestId, status: 'approved', updatedAt: now, targetType: 'article', targetIds: [firstTarget], requestedScope: ['summary'],
      completion: { hidden: true, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false },
    }
    const row = { _id: new ObjectId('507f1f77bcf86cd799439045'), updatedAt: now, messageCount: 2, messages: [{ role: 'assistant', status: 'answered', citations: [{ id: 'citation-1', articleId: firstTarget, status: 'available', originalUrl: 'https://example.test/private' }] }] }
    const chat = {
      find: vi.fn(() => ({ hint: vi.fn(function () { return this }), sort: vi.fn(function () { return this }), limit: vi.fn(function () { return this }), toArray: vi.fn(async () => [row]) })),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      countDocuments: vi.fn(async () => 0),
    }
    const requests = {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [workflow] }) }) })),
      findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set, completion: { ...workflow.completion, summaryRemoved: true, historicalChatCitationsRedacted: true } } })),
    }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'chatSessions' ? chat : name === 'articles' ? fixture.articles : { findOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    const result = await repository.materializeCleanupBatch({ now, limit: 100 })
    expect(result).toEqual(expect.objectContaining({ processed: true, hasMore: false }))
    expect(chat.updateOne).toHaveBeenCalledOnce()
    expect(chat.updateOne.mock.calls[0][1].$set.messages[0].citations[0]).toEqual(expect.objectContaining({ status: 'unavailable', unavailableReason: 'takedown' }))
    expect(requests.findOneAndUpdate.mock.calls[0][1].$set['completion.historicalChatCitationsRedacted']).toBe(true)
  })

  it('source hide-first fences and hides every visible article for the source', async () => {
    const sources = { findOne: vi.fn(async () => ({ _id: firstTarget, policyVersion: 4, operationalStatus: 'active' })), updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const articles = { updateMany: vi.fn(async () => ({ matchedCount: 2, modifiedCount: 2 })) }
    const context = { db: { collection: vi.fn((name) => name === 'sources' ? sources : articles) }, now: () => now }
    const repository = new MongoTakedownRepository(context)
    await expect(repository.hideTargets({ targetType: 'source', targetIds: [firstTarget], reasonCode: 'takedown_approved', session: {}, now })).resolves.toBeUndefined()
    expect(articles.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: { $in: [firstTarget] }, status: expect.objectContaining({ $in: expect.arrayContaining(['published', 'hidden']) }) }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'hidden', evidenceEligible: false }) }),
      expect.anything(),
    )
  })

  it('fails cleanup when a source article is restored to a visible lifecycle', async () => {
    const sources = { findOne: vi.fn(async () => ({ _id: firstTarget, policyVersion: 4, operationalStatus: 'paused' })), updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const articles = {
      countDocuments: vi.fn(async () => 1),
      updateMany: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
    }
    const chats = { find: vi.fn(() => ({ hint: vi.fn(function () { return this }), sort: vi.fn(function () { return this }), limit: vi.fn(function () { return this }), toArray: vi.fn(async () => []) })), countDocuments: vi.fn(async () => 0) }
    const context = { db: { collection: vi.fn((name) => name === 'sources' ? sources : name === 'articles' ? articles : chats) }, now: () => now }
    const repository = new MongoTakedownRepository(context)
    await expect(repository.cleanupArtifacts({ targetType: 'source', targetIds: [firstTarget], requestedScope: ['metadata'], session: {}, now })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('physically replaces requested article metadata with the closed tombstone', async () => {
    const mongo = createStep11Mongo({ app: {
      articles: [{ _id: firstTarget, sourceId: secondTarget, connectorType: 'rss', status: 'hidden', evidenceEligible: false, titleOriginal: 'Private title', originalUrl: 'https://private.example/article', canonicalUrl: 'https://private.example/article', canonicalUrlHash: 'a'.repeat(64), author: 'Private author', provenance: [{ sourceId: secondTarget, originalUrl: 'https://private.example/article', observedAt: now }], excerptOriginal: 'Private excerpt', searchTextNormalized: 'private', summaryVi: 'Private summary', embedding: [0.1], rightsSnapshot: { sourcePolicyVersion: 4 }, createdAt: now, updatedAt: now }],
      chatSessions: [],
    } })
    const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const completion = await repository.cleanupArtifacts({ targetType: 'article', targetIds: [firstTarget], requestedScope: ['metadata'], session: {}, now })
    const tombstone = await mongo.db.collection('articles').findOne({ _id: firstTarget })
    expect(completion).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true, hasMore: false }))
    expect(tombstone).toEqual(expect.objectContaining({ _id: firstTarget, sourceId: secondTarget, status: 'removed', evidenceEligible: false, removalPolicyVersion: 4 }))
    for (const field of ['titleOriginal', 'originalUrl', 'canonicalUrl', 'author', 'provenance', 'excerptOriginal', 'searchTextNormalized', 'summaryVi', 'embedding', 'rightsSnapshot']) expect(tombstone).not.toHaveProperty(field)
    expect(tombstone.canonicalUrlHash).toBe('a'.repeat(64))
  })

  it('physically tombstones source articles in bounded pages before reporting metadata complete', async () => {
    const articleIds = [new ObjectId(), new ObjectId(), new ObjectId()]
    const articles = articleIds.map((_id) => ({ _id, sourceId: firstTarget, connectorType: 'rss', status: 'hidden', evidenceEligible: false, titleOriginal: `Private ${_id}`, originalUrl: `https://private.example/${_id}`, canonicalUrlHash: _id.toHexString().padEnd(64, 'a'), searchTextNormalized: 'private', rightsSnapshot: { sourcePolicyVersion: 4 }, createdAt: now, updatedAt: now }))
    const mongo = createStep11Mongo({ app: {
      sources: [{ _id: firstTarget, operationalStatus: 'paused', policyVersion: 4, updatedAt: now }],
      articles,
      chatSessions: [],
    } })
    const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, now: () => now })

    const first = await repository.cleanupArtifacts({ targetType: 'source', targetIds: [firstTarget], requestedScope: ['metadata'], session: {}, now, limit: 2 })
    expect(first).toEqual(expect.objectContaining({ metadataRemoved: false, historicalChatCitationsRedacted: false, hasMore: true }))
    const second = await repository.cleanupArtifacts({ targetType: 'source', targetIds: [firstTarget], requestedScope: ['metadata'], session: {}, now, limit: 2 })
    expect(second).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true, hasMore: false }))
    const rows = await mongo.db.collection('articles').find({ sourceId: firstTarget }).toArray()
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({ status: 'removed', evidenceEligible: false, removalPolicyVersion: 4 }))
      expect(row).not.toHaveProperty('titleOriginal')
      expect(row).not.toHaveProperty('originalUrl')
    }
  })

  it('rejects terminal completion when a scoped summary artifact is restored', async () => {
    const fixture = makeContext()
    const workflow = {
      _id: requestId, status: 'approved', targetType: 'article', targetIds: [firstTarget], requestedScope: ['summary'],
      completion: { hidden: true, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: true, embeddingRemoved: false, historicalChatCitationsRedacted: true },
    }
    const articles = {
      updateMany: vi.fn(async (filter) => ({ matchedCount: filter.summaryStatus === 'removed' && filter.summaryVi === null && filter.summaryDetailStatus === 'removed' && filter.summaryParagraphsVi === null ? 0 : 1, modifiedCount: 0 })),
      countDocuments: vi.fn(async () => 1),
    }
    const requests = { findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set } })) }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'articles' ? articles : { findOne: vi.fn(), insertOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    await expect(repository.transition({ current: workflow, status: 'completed', reasonCode: 'takedown_completed', actor: { _id: new ObjectId('507f1f77bcf86cd799439044') }, request: { serverRequestId: 'summary-race-1' }, session: {}, now })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('rejects source terminal completion when a newly published article appears after cleanup', async () => {
    const fixture = makeContext()
    const workflow = {
      _id: requestId, status: 'approved', targetType: 'source', targetIds: [firstTarget], requestedScope: ['metadata'],
      completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true },
    }
    const sources = { updateMany: vi.fn(async () => ({ matchedCount: 1 })), countDocuments: vi.fn(async () => 1) }
    const articles = { countDocuments: vi.fn(async (filter) => filter.status?.$in?.includes('published') ? 1 : 0), updateMany: vi.fn(async () => ({ matchedCount: 1 })) }
    const requests = { findOneAndUpdate: vi.fn(async (_filter, update) => ({ value: { ...workflow, ...update.$set } })) }
    fixture.context.db.collection.mockImplementation((name) => name === 'takedownRequests' ? requests : name === 'sources' ? sources : name === 'articles' ? articles : { findOne: vi.fn(), insertOne: vi.fn() })
    const repository = new MongoTakedownRepository(fixture.context)
    await expect(repository.transition({ current: workflow, status: 'completed', reasonCode: 'takedown_completed', actor: { _id: new ObjectId('507f1f77bcf86cd799439044') }, request: { serverRequestId: 'source-race-1' }, session: {}, now })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })
})
