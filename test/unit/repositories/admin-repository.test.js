import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { INGESTION_OVERVIEW_PIPELINE, MongoAdminRepository, SOURCE_OVERVIEW_PIPELINE } from '../../../server/repositories/mongo/admin-repository.js'

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
      updateOne: vi.fn(async (filter) => take(updateResults, name, name === 'adminAuditLogs' ? { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter?._id } : { matchedCount: 1, modifiedCount: 1 })),
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

function createStatefulArticleContext({ initialStatus = 'published' } = {}) {
  const state = { article: article(articleId, { status: initialStatus }), audits: [], jobs: [] }
  const matches = (document, filter = {}) => Object.entries(filter).every(([key, expected]) => String(document?.[key]) === String(expected))
  const articles = {
    findOne: vi.fn(async () => state.article),
    find: vi.fn(() => cursor([])),
    updateOne: vi.fn(async (filter, update) => {
      if (String(filter?._id) !== articleId.toHexString() || state.article.updatedAt?.getTime?.() !== filter?.updatedAt?.getTime?.()) return { matchedCount: 0 }
      state.article = { ...state.article, ...(update?.$set ?? {}) }
      for (const key of Object.keys(update?.$unset ?? {})) delete state.article[key]
      return { matchedCount: 1 }
    }),
  }
  const sources = {
    findOne: vi.fn(async () => source()),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  }
  const users = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
  const sessions = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
  const indexingJobs = {
    updateOne: vi.fn(async (filter, update) => {
      const existing = state.jobs.find((job) => matches(job, filter))
      const candidate = update?.$setOnInsert ?? {}
      if (!existing && state.jobs.some((job) => String(job._id) === String(candidate._id))) {
        const error = new Error('E11000 duplicate key')
        error.code = 11000
        throw error
      }
      if (!existing) state.jobs.push({ ...candidate })
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 }
    }),
  }
  const adminAuditLogs = {
    findOne: vi.fn(async (filter) => state.audits.find((audit) => matches(audit, filter)) ?? null),
    updateOne: vi.fn(async (filter, update) => {
      const existing = state.audits.find((audit) => matches(audit, filter))
      if (existing) return { matchedCount: 1, upsertedCount: 0 }
      const document = { ...(update?.$setOnInsert ?? {}) }
      if (state.audits.some((audit) => String(audit._id) === String(document._id))) {
        const error = new Error('E11000 duplicate key')
        error.code = 11000
        throw error
      }
      state.audits.push(document)
      return { matchedCount: 0, upsertedCount: 1, upsertedId: document._id }
    }),
    insertOne: vi.fn(async (document) => { state.audits.push({ ...document }); return { acknowledged: true } }),
  }
  const collections = new Map([
    ['articles', articles], ['sources', sources], ['users', users], ['sessions', sessions],
    ['indexingJobs', indexingJobs], ['adminAuditLogs', adminAuditLogs],
  ])
  const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
  const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: vi.fn(() => session) }, now: () => now })
  return { repository, state, collections, session }
}

function createConcurrentArticleContext() {
  const state = {
    articles: new Map([[articleId.toHexString(), article()], [duplicateId.toHexString(), article(duplicateId)]]),
    audits: [],
    jobs: [],
  }
  const matches = (document, filter = {}) => Object.entries(filter).every(([key, expected]) => {
    if (key === '_id') return String(document?._id) === String(expected)
    if (key === 'updatedAt') return document?.updatedAt?.getTime?.() === expected?.getTime?.()
    return String(document?.[key]) === String(expected)
  })
  const articles = {
    findOne: vi.fn(async (filter) => [...state.articles.values()].find((item) => matches(item, filter)) ?? null),
    find: vi.fn(() => cursor([])),
    updateOne: vi.fn(async (filter, update) => {
      const current = [...state.articles.values()].find((item) => matches(item, filter))
      if (!current) return { matchedCount: 0 }
      const next = { ...current, ...(update?.$set ?? {}) }
      for (const key of Object.keys(update?.$unset ?? {})) delete next[key]
      state.articles.set(next._id.toHexString(), next)
      return { matchedCount: 1 }
    }),
  }
  const sources = {
    findOne: vi.fn(async () => source()),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  }
  const users = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
  const sessions = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
  const indexingJobs = {
    updateOne: vi.fn(async (filter, update) => {
      const existing = state.jobs.find((job) => matches(job, filter))
      if (!existing) state.jobs.push({ ...(update?.$setOnInsert ?? {}) })
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 }
    }),
  }
  let requestReads = 0
  let releaseRequestReads
  const requestReadsReady = new Promise((resolve) => { releaseRequestReads = resolve })
  const adminAuditLogs = {
    findOne: vi.fn(async (filter) => {
      if (filter?.requestId) {
        requestReads += 1
        if (requestReads === 2) releaseRequestReads()
        await requestReadsReady
        return null
      }
      return state.audits.find((audit) => matches(audit, filter)) ?? null
    }),
    updateOne: vi.fn(async (filter, update) => {
      const existing = state.audits.find((audit) => matches(audit, filter))
      if (existing) return { matchedCount: 1, upsertedCount: 0 }
      const document = { ...(update?.$setOnInsert ?? {}) }
      if (state.audits.some((audit) => String(audit._id) === String(document._id))) {
        const error = new Error('E11000 duplicate key')
        error.code = 11000
        throw error
      }
      state.audits.push(document)
      return { matchedCount: 0, upsertedCount: 1, upsertedId: document._id }
    }),
    insertOne: vi.fn(async (document) => {
      if (state.audits.some((audit) => String(audit._id) === String(document._id))) {
        const error = new Error('E11000 duplicate key')
        error.code = 11000
        throw error
      }
      state.audits.push({ ...document })
      return { acknowledged: true }
    }),
  }
  const collections = new Map([
    ['articles', articles], ['sources', sources], ['users', users], ['sessions', sessions],
    ['indexingJobs', indexingJobs], ['adminAuditLogs', adminAuditLogs],
  ])
  const makeSession = () => {
    const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
    return session
  }
  const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: vi.fn(makeSession) }, now: () => now })
  return { repository, state, collections }
}

describe('MongoAdminRepository', () => {
  it('computes overview metrics and exposes immutable pipeline constants', async () => {
    const fixture = createContext({
      aggregateResults: {
        sources: [[{ key: 'activeSources', value: 2 }, { key: 'pausedSources', value: 1 }]],
        ingestionJobs: [[{ key: 'queuedJobs', value: 4 }, { key: 'lastSuccessfulIngestionAt', value: now }]],
        articles: [{ articlesNeedingReview: 3, failedIndexes: 1 }],
        takedownRequests: [{ count: 2 }],
        accountDeletionRequests: [{ count: 1 }],
      },
    })
    await expect(fixture.repository.getOverview()).resolves.toEqual({ activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 4, failedJobs: 0, articlesNeedingReview: 3, failedIndexes: 1, openTakedowns: 2, failedAccountDeletions: 1, lastSuccessfulIngestionAt: now })
    expect(SOURCE_OVERVIEW_PIPELINE).toHaveLength(6)
    expect(fixture.collections.get('sources').aggregate).toHaveBeenCalled()
  })

  it('only counts retryable failed ingestion jobs without successful retries in overview', async () => {
    const failedStage = INGESTION_OVERVIEW_PIPELINE.find((stage) => stage.$unionWith?.pipeline?.some((p) => p.$set?.key === 'failedJobs'))
    expect(failedStage).toBeDefined()
    const pipeline = failedStage.$unionWith.pipeline
    const matchStage = pipeline.find((p) => p.$match)
    expect(matchStage.$match).toEqual(expect.objectContaining({ status: 'failed', 'error.retryable': true }))
  })

  it('inserts allowlisted admin audit records and replays existing events', async () => {
    const fixture = createContext({ findOne: { adminAuditLogs: [null] } })
    const input = { actor, targetId: articleId, reasonCode: 'article_topics_changed', changedFields: ['topics'], request: { requestId: 'req-1' }, now }
    await expect(fixture.repository.insertAdminAudit(input)).resolves.toEqual(expect.objectContaining({ action: 'article_topics_changed', targetId: articleId }))
    const existing = fixture.collections.get('adminAuditLogs').insertOne.mock.calls[0][0]
    const replay = createContext({ findOne: { adminAuditLogs: [existing] } })
    await expect(replay.repository.insertAdminAudit(input)).resolves.toEqual(existing)
    await expect(fixture.repository.insertAdminAudit({ ...input, reasonCode: 'invalid' })).rejects.toThrow(/allowlisted/i)
    await expect(fixture.repository.insertAdminAudit({ ...input, request: {} })).rejects.toThrow(/identity/i)
  })

  it('checks the active session and user lifecycle fence before admin work', async () => {
    const fixture = createContext({ updateResults: { sessions: [{ matchedCount: 1 }], users: [{ matchedCount: 1 }] } })
    await expect(fixture.repository.assertActiveSessionForUser({ sessionId, userId: adminId, sessionVersion: 3, role: 'admin', now })).resolves.toBe(true)
    expect(fixture.collections.get('sessions').updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: sessionId, userId: adminId, userSessionVersion: 3, status: 'active' }),
      expect.objectContaining({ $set: { lastSeenAt: now } }),
      {},
    )
    expect(fixture.collections.get('users').updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: adminId, status: 'active', sessionVersion: 3, role: 'admin' }),
      expect.objectContaining({ $set: { updatedAt: now } }),
      {},
    )

    const stale = createContext({ updateResults: { sessions: [{ matchedCount: 0 }] } })
    await expect(stale.repository.assertActiveSessionForUser({ sessionId, userId: adminId, sessionVersion: 3, role: 'admin', now })).resolves.toBe(false)
    expect(stale.collections.get('users')).toBeUndefined()
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
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ topics: ['ai', 'technology'], topicIds: expect.arrayContaining(['ai-ml']), topicTaxonomyVersion: 1 }) }), expect.anything())
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
  const updateStatus = (repository, status, requestId, fence = actorFence()) => repository.updateAdminArticle(articleId, {
    category: 'status', value: status, actorFence: fence, actor,
    request: { requestId }, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
    reasonCode: 'article_status_changed',
  })

  it('writes one reconciliation intent and audit for the first status request', async () => {
    const fixture = createStatefulArticleContext()
    await expect(updateStatus(fixture.repository, 'hidden', 'status-first-request')).resolves.toMatchObject({ status: 'hidden' })
    expect(fixture.state.audits).toHaveLength(1)
    expect(fixture.state.audits[0]).toMatchObject({ action: 'article_status_changed', requestId: 'status-first-request' })
    expect(fixture.state.audits[0]).not.toHaveProperty('actorScope')
    expect(fixture.state.jobs).toHaveLength(1)
    expect(fixture.state.jobs[0]).toMatchObject({ task: 'visibility-reconcile', trigger: 'admin', idempotencyKey: expect.stringContaining('status-first-request') })
  })

  it('reuses an exact status request audit and reconciliation intent without duplicate writes', async () => {
    const fixture = createStatefulArticleContext()
    await updateStatus(fixture.repository, 'hidden', 'status-replay-request')
    await expect(updateStatus(fixture.repository, 'hidden', 'status-replay-request')).resolves.toMatchObject({ status: 'hidden' })
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('sources').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('indexingJobs').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('adminAuditLogs').insertOne).toHaveBeenCalledTimes(1)
    expect(fixture.state.audits).toHaveLength(1)
    expect(fixture.state.jobs).toHaveLength(1)
  })

  it('replays an exact request before consuming rate-limit admission or touching mutable fences', async () => {
    const fixture = createStatefulArticleContext()
    const reserve = vi.fn(async () => ({ allowed: true }))
    const admission = { reserve }
    await fixture.repository.updateAdminArticle(articleId, {
      category: 'status', value: 'hidden', actorFence: actorFence(), actor,
      request: { requestId: 'status-admission-replay' }, rateLimitAdmission: admission,
      reasonCode: 'article_status_changed',
    })
    expect(reserve).toHaveBeenCalledTimes(1)
    await expect(fixture.repository.updateAdminArticle(articleId, {
      category: 'status', value: 'hidden', actorFence: actorFence(), actor,
      request: { requestId: 'status-admission-replay' }, rateLimitAdmission: admission,
      reasonCode: 'article_status_changed',
    })).resolves.toMatchObject({ status: 'hidden' })
    expect(reserve).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('users').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('sessions').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('adminAuditLogs').insertOne).toHaveBeenCalledTimes(1)
  })

  it('rejects a reused status request identity when the payload changes', async () => {
    const fixture = createStatefulArticleContext()
    await updateStatus(fixture.repository, 'hidden', 'status-mismatch-request')
    await expect(updateStatus(fixture.repository, 'published', 'status-mismatch-request')).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    expect(fixture.state.article.status).toBe('hidden')
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('indexingJobs').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('adminAuditLogs').insertOne).toHaveBeenCalledTimes(1)
    expect(fixture.state.audits).toHaveLength(1)
    expect(fixture.state.jobs).toHaveLength(1)
  })

  it('supports hidden to published to hidden with distinct request and event identities', async () => {
    const fixture = createStatefulArticleContext()
    await expect(updateStatus(fixture.repository, 'hidden', 'status-roundtrip-hidden-1')).resolves.toMatchObject({ status: 'hidden' })
    await expect(updateStatus(fixture.repository, 'published', 'status-roundtrip-published')).resolves.toMatchObject({ status: 'published' })
    await expect(updateStatus(fixture.repository, 'hidden', 'status-roundtrip-hidden-2')).resolves.toMatchObject({ status: 'hidden' })
    expect(fixture.state.audits).toHaveLength(3)
    expect(new Set(fixture.state.audits.map(({ eventId }) => eventId)).size).toBe(3)
    expect(fixture.state.audits.map(({ requestId }) => requestId)).toEqual([
      'status-roundtrip-hidden-1', 'status-roundtrip-published', 'status-roundtrip-hidden-2',
    ])
    expect(fixture.state.jobs).toHaveLength(3)
    expect(new Set(fixture.state.jobs.map(({ _id }) => String(_id))).size).toBe(3)
  })
  it('binds a concurrent article request identity before a second domain commit', async () => {
    const fixture = createConcurrentArticleContext()
    const request = { requestId: 'concurrent-status-key' }
    const options = { actorFence: actorFence(), actor, request, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) }, reasonCode: 'article_status_changed' }
    const results = await Promise.allSettled([
      fixture.repository.updateAdminArticle(articleId, { ...options, category: 'status', value: 'hidden' }),
      fixture.repository.updateAdminArticle(duplicateId, { ...options, category: 'status', value: 'published' }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status, reason }) => status === 'rejected' && reason?.code === 'idempotency_mismatch')).toHaveLength(1)
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.get('indexingJobs').updateOne).toHaveBeenCalledTimes(1)
    expect(fixture.state.audits).toHaveLength(1)
    expect(fixture.state.jobs).toHaveLength(1)
  })

  it('keeps reconciliation job identities scoped to the actor session', async () => {
    const fixture = createStatefulArticleContext()
    const secondSessionFence = { ...actorFence(), sessionId: new ObjectId('507f1f77bcf86cd799439016') }
    await updateStatus(fixture.repository, 'hidden', 'status-shared-key', actorFence())
    await updateStatus(fixture.repository, 'hidden', 'status-shared-key', secondSessionFence)
    expect(fixture.state.audits).toHaveLength(2)
    expect(fixture.state.jobs).toHaveLength(2)
    expect(new Set(fixture.state.jobs.map(({ _id }) => String(_id))).size).toBe(2)
  })

  it('supports exact replay with the insert-only audit role', async () => {
    const fixture = createStatefulArticleContext()
    const auditLogs = fixture.collections.get('adminAuditLogs')
    auditLogs.updateOne = undefined
    await updateStatus(fixture.repository, 'hidden', 'insert-only-status-key')
    await updateStatus(fixture.repository, 'hidden', 'insert-only-status-key')
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalledTimes(1)
    expect(auditLogs.insertOne).toHaveBeenCalledTimes(1)
  })
})
