import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoAdminRepository, SOURCE_OVERVIEW_PIPELINE } from '../../../server/repositories/mongo/admin-repository.js'

const adminId = new ObjectId('507f1f77bcf86cd799439011')
const articleId = new ObjectId('507f1f77bcf86cd799439012')
const duplicateId = new ObjectId('507f1f77bcf86cd799439013')
const sourceId = new ObjectId('507f1f77bcf86cd799439014')
const sessionId = new ObjectId('507f1f77bcf86cd799439015')
const now = new Date('2026-08-20T08:00:00.000Z')

function source() {
  return { _id: sourceId, policyVersion: 2, updatedAt: now, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'metadata' }
}

function article(id = articleId, overrides = {}) {
  return {
    _id: id,
    sourceId,
    titleOriginal: `Article ${id.toHexString()}`,
    originalUrl: 'https://example.com/article',
    status: 'published',
    topics: ['technology'],
    provenance: [{ sourceId: sourceId.toHexString(), originalUrl: 'https://example.com/article', observedAt: now.toISOString() }],
    rightsSnapshot: { sourcePolicyVersion: 2 },
    leadMedia: { type: 'image' },
    leadMediaStatus: 'available',
    updatedAt: now,
    ...overrides,
  }
}

function cursor(values = []) {
  const result = {
    sort: vi.fn(() => result),
    project: vi.fn(() => result),
    limit: vi.fn(() => result),
    toArray: vi.fn(async () => values),
  }
  return result
}

function aggregateCursor(value) {
  return {
    toArray: vi.fn(async () => value),
    next: vi.fn(async () => Array.isArray(value) ? value[0] ?? null : value),
  }
}

function createContext({ findOne = {}, findResults = {}, aggregateResults = {}, updateResults = {}, updateManyResults = {}, insertResults = {}, session = null } = {}) {
  const collections = new Map()
  const take = (input, name, fallback) => {
    const queue = input[name]
    return Array.isArray(queue) && queue.length > 0 ? queue.shift() : fallback
  }
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async () => take(findOne, name, null)),
      find: vi.fn(() => cursor(take(findResults, name, []))),
      aggregate: vi.fn(() => aggregateCursor(take(aggregateResults, name, []))),
      updateOne: vi.fn(async () => take(updateResults, name, { matchedCount: 1, modifiedCount: 1 })),
      updateMany: vi.fn(async () => take(updateManyResults, name, { matchedCount: 1, modifiedCount: 1 })),
      insertOne: vi.fn(async () => take(insertResults, name, { acknowledged: true })),
    }
    collections.set(name, handle)
    return handle
  }
  const transactionSession = session ?? {
    withTransaction: vi.fn(async (work) => work(transactionSession)),
    endSession: vi.fn(async () => {}),
  }
  const context = { db: { collection }, client: { startSession: vi.fn(() => transactionSession) }, now: () => now }
  return { repository: new MongoAdminRepository(context), context, collections, session: transactionSession }
}

function actorFence() {
  return { userId: adminId, sessionId, sessionVersion: 3 }
}

const actor = { _id: adminId, role: 'admin' }

describe('MongoAdminRepository', () => {
  it('computes overview metrics and exposes immutable pipeline constants', async () => {
    const fixture = createContext({
      aggregateResults: {
        sources: [[{ key: 'activeSources', value: 2 }, { key: 'pausedSources', value: 1 }]],
        ingestionJobs: [[{ key: 'queuedJobs', value: 4 }, { key: 'lastSuccessfulIngestionAt', value: now }]],
        articles: [{ count: 3 }],
        indexingJobs: [{ count: 1 }],
        takedownRequests: [{ count: 2 }],
        accountDeletionRequests: [{ count: 1 }],
      },
    })
    await expect(fixture.repository.getOverview()).resolves.toEqual({ activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 4, failedJobs: 0, articlesNeedingReview: 3, failedIndexes: 1, openTakedowns: 2, failedAccountDeletions: 1, lastSuccessfulIngestionAt: now })
    expect(SOURCE_OVERVIEW_PIPELINE).toHaveLength(6)
    expect(fixture.collections.get('sources').aggregate).toHaveBeenCalled()
  })

  it('inserts allowlisted admin audit records and replays existing events', async () => {
    const fixture = createContext({ findOne: { adminAuditLogs: [null] } })
    const input = { actor, targetId: articleId, reasonCode: 'article_topics_changed', changedFields: ['topics'], request: { requestId: 'req-1' }, now }
    await expect(fixture.repository.insertAdminAudit(input)).resolves.toEqual(expect.objectContaining({ action: 'article_topics_changed', targetId: articleId }))
    const replay = createContext({ findOne: { adminAuditLogs: [{ eventId: 'existing' }] } })
    await expect(replay.repository.insertAdminAudit(input)).resolves.toEqual({ eventId: 'existing' })
    await expect(fixture.repository.insertAdminAudit({ ...input, reasonCode: 'invalid' })).rejects.toThrow(/allowlisted/i)
    await expect(fixture.repository.insertAdminAudit({ ...input, request: {} })).rejects.toThrow(/identity/i)
  })

  it('lists admin articles and audit logs with cursor boundaries', async () => {
    const first = article()
    const second = article(duplicateId)
    const articleCursor = Buffer.from(JSON.stringify({ id: articleId.toHexString(), at: now.toISOString() })).toString('base64url')
    const auditRow = { _id: articleId, actorType: 'admin', actorId: adminId, action: 'article_topics_changed', targetType: 'article', targetId: articleId, changedFields: ['topics'], reasonCode: 'article_topics_changed', requestId: 'req', result: 'succeeded', createdAt: now }
    const auditCursor = Buffer.from(JSON.stringify({ id: articleId.toHexString(), at: now.toISOString() })).toString('base64url')
    const fixture = createContext({ findResults: { articles: [[first, second]], adminAuditLogs: [[auditRow, { ...auditRow, _id: duplicateId }]] } })
    await expect(fixture.repository.listAdminArticles({ limit: 1, status: 'published', sourceId: sourceId.toHexString(), cursor: articleCursor })).resolves.toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    await expect(fixture.repository.findAdminArticle(articleId, { session: fixture.session })).resolves.toBeNull()
    await expect(fixture.repository.listAuditLogs({ limit: 1, actorType: 'admin', targetType: 'article', actorId: adminId.toHexString(), targetId: 'article-key', cursor: auditCursor })).resolves.toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    await expect(fixture.repository.listAdminArticles({ limit: 0 })).rejects.toMatchObject({ status: 422 })
    await expect(fixture.repository.listAuditLogs({ limit: 101 })).rejects.toMatchObject({ status: 422 })
    await expect(fixture.repository.listAuditLogs({ cursor: 'bad' })).rejects.toMatchObject({ status: 422 })
  })

  it('updates article topics under admin, source, rate and audit fences', async () => {
    const current = article()
    const fixture = createContext({
      findOne: { articles: [current, current, current], sources: [source()], adminAuditLogs: [null] },
      updateResults: { users: [{ matchedCount: 1 }], sessions: [{ matchedCount: 1 }], sources: [{ matchedCount: 1 }], articles: [{ matchedCount: 1 }], indexingJobs: [{ matchedCount: 1 }] },
    })
    const reserve = vi.fn(async () => ({ allowed: true }))
    await expect(fixture.repository.updateAdminArticle(articleId, { category: 'topics', value: ['ai', 'technology'], actorFence: actorFence(), actor, request: { requestId: 'req-1' }, rateLimitAdmission: { reserve }, reasonCode: 'article_topics_changed' })).resolves.toEqual(current)
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalled()
    expect(fixture.collections.get('indexingJobs').updateOne).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ $setOnInsert: expect.any(Object) }), expect.objectContaining({ upsert: true, session: fixture.session }))

    const media = createContext({ findOne: { articles: [article(articleId, { leadMedia: null })] } })
    await expect(media.repository.updateAdminArticle(articleId, { category: 'leadMediaStatus', value: 'available', actorFence: actorFence() })).rejects.toMatchObject({ status: 409 })
    const missing = createContext({ findOne: { articles: [null] } })
    await expect(missing.repository.updateAdminArticle(articleId, { category: 'topics', value: [], actorFence: actorFence() })).resolves.toBeNull()
    const admission = createContext({ findOne: { articles: [current] } })
    await expect(admission.repository.updateAdminArticle(articleId, { category: 'topics', value: [], actorFence: actorFence(), rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 5 })) } })).rejects.toMatchObject({ status: 429, retryAfter: 5 })
  })

  it('merges duplicate articles while fencing source snapshots and idempotency', async () => {
    const canonical = article(articleId, { provenance: [{ sourceId: sourceId.toHexString(), originalUrl: 'https://example.com/canonical', observedAt: now.toISOString() }] })
    const duplicate = article(duplicateId, { status: 'published', provenance: [{ sourceId: sourceId.toHexString(), originalUrl: 'https://example.com/duplicate', observedAt: now.toISOString() }] })
    const fixture = createContext({
      findOne: { users: [{}], sessions: [{}], articles: [canonical, canonical], sources: [source(), source()], adminAuditLogs: [null] },
      findResults: { articles: [[duplicate]] },
      updateResults: { users: [{ matchedCount: 1 }], sessions: [{ matchedCount: 1 }], sources: [{ matchedCount: 1 }], articles: [{ matchedCount: 1 }] },
      updateManyResults: { articles: [{ matchedCount: 1 }] },
    })
    await expect(fixture.repository.mergeDuplicateArticles({ canonicalArticleId: articleId, duplicateArticleIds: [duplicateId], actorFence: actorFence(), actor, request: { requestId: 'merge-request' }, idempotencyKey: 'merge-key', rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) }, reasonCode: 'duplicate_merge_confirmed' })).resolves.toEqual(expect.objectContaining({ duplicateCount: 1, canonical: expect.anything() }))
    expect(fixture.collections.get('articles').updateMany).toHaveBeenCalled()

    const prior = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [{ targetId: articleId, eventId: 'wrong' }] } })
    await expect(prior.repository.mergeDuplicateArticles({ canonicalArticleId: articleId, duplicateArticleIds: [duplicateId], actorFence: actorFence(), actor, request: { requestId: 'merge-request' }, idempotencyKey: 'merge-key', rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) }, reasonCode: 'duplicate_merge_confirmed' })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
  })

  it('purges audit IP HMAC fields in bounded batches', async () => {
    const fixture = createContext({ findResults: { adminAuditLogs: [[{ _id: articleId }, { _id: duplicateId }]] }, updateManyResults: { adminAuditLogs: [{ modifiedCount: 1 }] } })
    await expect(fixture.repository.purgeAuditIpHmac({ cutoff: now, limit: 1 })).resolves.toEqual({ inspected: 1, affected: 1, hasMore: true })
    const empty = createContext({ findResults: { adminAuditLogs: [[]] } })
    await expect(empty.repository.purgeAuditIpHmac({ cutoff: now, limit: 0 })).resolves.toEqual({ inspected: 0, affected: 0, hasMore: false })
  })
})
