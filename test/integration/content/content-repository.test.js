import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'

const USER_ID = '507f1f77bcf86cd799439001'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const SESSION_ID = '507f1f77bcf86cd799439031'
const PUBLISHED_AT = new Date('2026-08-10T08:00:00.000Z')

function source(overrides = {}) {
  return {
    _id: new ObjectId(SOURCE_ID),
    name: 'Tech Review',
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
    authorityTier: 'editorial',
    policyVersion: 4,
    mediaPolicy: { imageMode: 'remote-preview', videoMode: 'link-only', allowedHosts: ['media.example.com'], attributionRequired: true },
    ...overrides,
  }
}

function document(overrides = {}) {
  return {
    _id: new ObjectId(ARTICLE_ID),
    sourceId: new ObjectId(SOURCE_ID),
    status: 'published',
    titleOriginal: 'Verified article',
    titleVi: null,
    originalUrl: 'https://example.com/article',
    author: null,
    publishedAt: PUBLISHED_AT,
    retrievedAt: new Date('2026-08-10T09:00:00.000Z'),
    sourceLanguage: 'en',
    topics: ['AI'],
    summaryVi: null,
    summaryStatus: 'pending',
    summaryBasis: null,
    leadMedia: null,
    leadMediaStatus: 'none',
    ...overrides,
  }
}

function chain(values) {
  return {
    maximum: null,
    sort() { return this },
    limit(value) { this.maximum = value; return this },
    async toArray() { return this.maximum === null ? values : values.slice(0, this.maximum) },
  }
}

describe('Step 8 Mongo content repository', () => {
  it('uses the shared current visibility predicate and returns a contract-safe opaque page', async () => {
    const currentSource = source()
    const first = { ...document(), _currentSource: currentSource, _isSaved: [{ _id: new ObjectId() }] }
    const second = { ...document({ _id: new ObjectId('507f1f77bcf86cd799439012'), titleOriginal: 'Second article' }), _currentSource: currentSource, _isSaved: [] }
    const aggregate = vi.fn(() => ({ toArray: vi.fn(async () => [first, second]) }))
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })

    const page = await repository.listVisibleArticles({ userId: USER_ID, topic: 'AI', limit: 1 })

    expect(page.articles).toEqual([expect.objectContaining({ id: ARTICLE_ID, source: { id: SOURCE_ID, name: 'Tech Review', authorityTier: 'editorial' }, isSaved: true, summaryStatus: 'pending', summaryVi: null, summaryBasis: null })])
    expect(page.hasNext).toBe(true)
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(page.nextCursor).not.toMatch(/507f1f77bcf86cd799439011|2026-08-10/)
    expect(aggregate.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ $lookup: expect.objectContaining({ from: 'sources' }) }),
      expect.objectContaining({ $match: expect.objectContaining({ '_currentSource.operationalStatus': 'active', '_currentSource.licenseStatus': { $in: ['permitted', 'metadata-only'] } }) }),
    ]))
  })

  it('never serializes removed summary state or stale/unsafe media metadata', async () => {
    const currentSource = source()
    const stale = { ...document({ summaryStatus: 'removed', summaryVi: 'must not leak', summaryBasis: 'metadata', leadMediaStatus: 'available', leadMedia: { type: 'image', displayMode: 'remote-preview', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: 'Board', credit: null, attribution: 'Tech Review', mediaEvidenceStatus: 'not-analyzed', sourcePolicyVersion: 3 } }), _currentSource: currentSource, _isSaved: [] }
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate: vi.fn(() => ({ toArray: vi.fn(async () => [stale]) })) })

    const page = await repository.listVisibleArticles({ userId: USER_ID, limit: 20 })

    expect(page.articles[0]).toEqual(expect.objectContaining({ summaryStatus: 'failed', summaryVi: null, summaryBasis: null, leadMedia: null }))
    expect(JSON.stringify(page)).not.toMatch(/must not leak|sourcePolicyVersion|leadMediaStatus|removed/)
  })

  it('derives public topics for legacy articles that were stored without categories', async () => {
    const currentSource = source()
    const legacy = {
      ...document({ topics: [], titleOriginal: 'Cloud data infrastructure with Kubernetes' }),
      _currentSource: currentSource,
      _isSaved: [],
    }
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate: vi.fn(() => ({ toArray: vi.fn(async () => [legacy]) })) })

    const page = await repository.listVisibleArticles({ userId: USER_ID, limit: 20 })

    expect(page.articles[0].topics).toEqual(['devops', 'dữ liệu'])
  })

  it('returns text-only search scores and binds cursors to the normalized query', async () => {
    const currentSource = source()
    const match = { ...document(), _currentSource: currentSource, _isSaved: [], _textScore: 3.5 }
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate: vi.fn(() => ({ toArray: vi.fn(async () => [match]) })) })

    const result = await repository.searchVisibleArticles({ userId: USER_ID, q: 'trí tuệ nhân tạo', mode: 'text', limit: 20 })

    expect(result.results[0]).toEqual(expect.objectContaining({ score: expect.any(Number), textScore: expect.any(Number), semanticScore: null, article: expect.objectContaining({ id: ARTICLE_ID }) }))
    await expect(repository.searchVisibleArticles({ userId: USER_ID, q: 'query khác', cursor: result.nextCursor ?? 'invalid-cursor', limit: 20 })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })

  it('continues text search from an opaque cursor without a fixed result-window cap', async () => {
    const currentSource = source()
    const first = { ...document(), _currentSource: currentSource, _isSaved: [], _textScore: 3.5 }
    const secondId = new ObjectId('507f1f77bcf86cd799439012')
    const second = { ...document({ _id: secondId, titleOriginal: 'Second verified article' }), _currentSource: currentSource, _isSaved: [], _textScore: 2.5 }
    const aggregate = vi.fn()
      .mockReturnValueOnce({ toArray: vi.fn(async () => [first, second]) })
      .mockReturnValueOnce({ toArray: vi.fn(async () => [second]) })
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })

    const firstPage = await repository.searchVisibleArticles({ userId: USER_ID, q: 'verified article', limit: 1 })
    const secondPage = await repository.searchVisibleArticles({ userId: USER_ID, q: 'verified article', cursor: firstPage.nextCursor, limit: 1 })

    expect(firstPage).toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    expect(secondPage.results[0].article.id).toBe(secondId.toHexString())
    expect(JSON.stringify(aggregate.mock.calls[1][0])).toContain('$_textScore')
    expect(JSON.stringify(aggregate.mock.calls[1][0])).not.toContain('$limit":500')
  })

  it('filters and idempotently cleans saved relations that no longer resolve visible content', async () => {
    const visibleRelation = { _id: new ObjectId('507f1f77bcf86cd799439031'), userId: new ObjectId(USER_ID), articleId: new ObjectId(ARTICLE_ID), createdAt: new Date('2026-08-11T09:00:00.000Z') }
    const hiddenRelation = { _id: new ObjectId('507f1f77bcf86cd799439032'), userId: new ObjectId(USER_ID), articleId: new ObjectId('507f1f77bcf86cd799439012'), createdAt: new Date('2026-08-11T08:00:00.000Z') }
    const saved = { find: vi.fn(() => chain([visibleRelation, hiddenRelation])), deleteMany: vi.fn(async () => ({ deletedCount: 1 })) }
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.savedArticles = () => saved
    repository.visibleArticlesByIds = vi.fn(async () => new Map([[ARTICLE_ID, { ...document(), _currentSource: source(), _isSaved: [visibleRelation] }]]))

    const page = await repository.listSavedVisibleArticles({ userId: USER_ID, limit: 20 })

    expect(page.articles).toEqual([expect.objectContaining({ id: ARTICLE_ID, isSaved: true })])
    expect(saved.deleteMany).toHaveBeenCalledWith({ userId: new ObjectId(USER_ID), _id: { $in: [hiddenRelation._id] } })
    expect(JSON.stringify(page)).not.toMatch(/unavailable|hiddenRelation/)
  })

  it('continues cleanup scanning until a visible relation beyond 501 stale rows is reachable', async () => {
    const userId = new ObjectId(USER_ID)
    const baseTime = new Date('2026-08-11T10:00:00.000Z').getTime()
    const relations = Array.from({ length: 502 }, (_, index) => ({
      _id: new ObjectId(),
      userId,
      articleId: new ObjectId(),
      createdAt: new Date(baseTime - index),
    }))
    const visibleRelation = { _id: new ObjectId(), userId, articleId: new ObjectId(ARTICLE_ID), createdAt: new Date(baseTime - 502) }
    relations.push(visibleRelation)
    const find = vi.fn((filter) => {
      const position = filter.$or?.[1]
      const filtered = position ? relations.filter((relation) => relation.createdAt < position.createdAt || relation.createdAt.getTime() === position.createdAt.getTime() && relation._id.toHexString() < position._id.$lt.toHexString()) : relations
      return chain(filtered)
    })
    const saved = { find, deleteMany: vi.fn(async () => ({ deletedCount: 0 })) }
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.savedArticles = () => saved
    repository.visibleArticlesByIds = vi.fn(async (ids) => ids.some((id) => id.equals(visibleRelation.articleId))
      ? new Map([[ARTICLE_ID, { ...document(), _currentSource: source(), _isSaved: [visibleRelation] }]])
      : new Map())

    const page = await repository.listSavedVisibleArticles({ userId: USER_ID, limit: 1 })

    expect(page.articles).toEqual([expect.objectContaining({ id: ARTICLE_ID, isSaved: true })])
    expect(find.mock.calls.length).toBeGreaterThan(1)
  })

  it('transactionally fences the active user, exact session/version and current visibility before save', async () => {
    const transaction = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn(async () => undefined) }
    const client = { startSession: vi.fn(() => transaction) }
    const saved = { updateOne: vi.fn(async () => ({ upsertedCount: 1 })), deleteOne: vi.fn(async () => ({ deletedCount: 1 })), deleteMany: vi.fn(async () => ({ deletedCount: 1 })) }
    const users = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const sessions = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const articles = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const sources = { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
    const repository = new MongoArticleRepository({ db: {}, client, now: () => new Date('2026-08-11T10:00:00.000Z') })
    repository.savedArticles = () => saved
    repository.users = () => users
    repository.sessions = () => sessions
    repository.articles = () => articles
    repository.sources = () => sources
    repository.findVisibleArticleDocument = vi.fn(async () => ({ ...document(), _currentSource: source() }))

    expect(await repository.saveVisibleArticle({ userId: USER_ID, articleId: ARTICLE_ID, actorFence: { sessionId: SESSION_ID, sessionVersion: 7 } })).toBe(true)
    await repository.unsaveArticle({ userId: USER_ID, articleId: ARTICLE_ID })
    await repository.clearSavedArticles({ userId: USER_ID })

    expect(client.startSession).toHaveBeenCalledTimes(1)
    expect(users.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: new ObjectId(USER_ID), status: 'active', sessionVersion: 7 }), expect.any(Object), { session: transaction })
    expect(sessions.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: new ObjectId(SESSION_ID), userId: new ObjectId(USER_ID), userSessionVersion: 7, status: 'active' }), expect.any(Object), { session: transaction })
    expect(articles.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: new ObjectId(ARTICLE_ID), status: 'published' }), expect.any(Object), { session: transaction })
    expect(sources.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: new ObjectId(SOURCE_ID), operationalStatus: 'active' }), expect.any(Object), { session: transaction })
    expect(saved.updateOne.mock.calls[0][0]).toEqual({ userId: new ObjectId(USER_ID), articleId: new ObjectId(ARTICLE_ID) })
    expect(saved.updateOne.mock.calls[0][2]).toEqual({ upsert: true, session: transaction })
    expect(saved.deleteOne.mock.calls[0][0]).toEqual({ userId: new ObjectId(USER_ID), articleId: new ObjectId(ARTICLE_ID) })
    expect(saved.deleteMany.mock.calls[0][0]).toEqual({ userId: new ObjectId(USER_ID) })
  })

  it('does not upsert when the transactional user fence is stale', async () => {
    const transaction = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn(async () => undefined) }
    const saved = { updateOne: vi.fn() }
    const repository = new MongoArticleRepository({ db: {}, client: { startSession: () => transaction } })
    repository.savedArticles = () => saved
    repository.users = () => ({ updateOne: vi.fn(async () => ({ matchedCount: 0 })) })
    repository.sessions = () => ({ updateOne: vi.fn(async () => ({ matchedCount: 1 })) })
    repository.findVisibleArticleDocument = vi.fn(async () => ({ ...document(), _currentSource: source() }))

    await expect(repository.saveVisibleArticle({ userId: USER_ID, articleId: ARTICLE_ID, actorFence: { sessionId: SESSION_ID, sessionVersion: 7 } })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(saved.updateOne).not.toHaveBeenCalled()
  })
})
