import { describe, expect, it, vi } from 'vitest'
import { createArticleService } from '../../../server/application/articles/service.js'
import { createSearchService } from '../../../server/application/search/service.js'
import { createSavedService } from '../../../server/application/saved/service.js'

const USER_ID = '507f1f77bcf86cd799439001'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439031'
const SESSION_VERSION = 7

const article = {
  id: ARTICLE_ID,
  titleOriginal: 'A verified technology article',
  titleVi: 'Một bài công nghệ đã kiểm chứng',
  source: { id: '507f1f77bcf86cd799439021', name: 'Tech Review', authorityTier: 'editorial' },
  publishedAt: '2026-08-10T08:00:00.000Z',
  sourceLanguage: 'en',
  topics: ['AI'],
  summaryVi: null,
  summaryStatus: 'pending',
  summaryBasis: null,
  leadMedia: null,
  isSaved: false,
}

const auth = {
  user: { _id: USER_ID, role: 'user', status: 'active', sessionVersion: SESSION_VERSION },
  session: { _id: SESSION_ID, userSessionVersion: SESSION_VERSION },
}

describe('Step 8 content application services', () => {
  it('validates feed filters and passes only the authenticated user identity to the repository', async () => {
    const repository = {
      listVisibleArticles: vi.fn(async () => ({ articles: [article], hasNext: false, nextCursor: null, totalItems: 1 })),
    }
    const service = createArticleService({ repository })

    const result = await service.list({
      auth,
      query: { topic: 'AI', sourceId: article.source.id, publishedAfter: '2026-08-01T00:00:00.000Z', publishedBefore: '2026-08-11T00:00:00.000Z', limit: '20' },
    })

    expect(result).toEqual({ articles: [article], hasNext: false, nextCursor: null, totalItems: 1 })
    expect(repository.listVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, topic: 'AI', limit: 20 }))
    await service.list({ auth, query: { page: '3', limit: '10' } })
    expect(repository.listVisibleArticles).toHaveBeenLastCalledWith(expect.objectContaining({ userId: USER_ID, page: 3, limit: 10 }))
    await service.list({ auth, query: { lastPage: 'true', limit: '10' } })
    expect(repository.listVisibleArticles).toHaveBeenLastCalledWith(expect.objectContaining({ userId: USER_ID, lastPage: true, page: 1, limit: 10 }))
    await expect(service.list({ auth, query: { page: '0' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.list({ auth, query: { page: '2', cursor: 'opaque' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.list({ auth, query: { lastPage: 'invalid' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.list({ auth, query: { page: '2', lastPage: 'true' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.list({ auth, query: { page: '10000', limit: '100' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.list({ auth, query: { publishedAfter: '2026-08-12T00:00:00.000Z', publishedBefore: '2026-08-11T00:00:00.000Z' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })

  it('maps a missing or no-longer-visible detail to the canonical 404', async () => {
    const service = createArticleService({ repository: { getVisibleArticle: vi.fn(async () => null) } })
    await expect(service.get({ auth, articleId: ARTICLE_ID })).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('keeps text search available for hybrid requests when embeddings are disabled', async () => {
    const repository = {
      searchVisibleArticles: vi.fn(async () => ({
        results: [{ article, score: 0.71, textScore: 0.71, semanticScore: null }],
        hasNext: false,
        nextCursor: null,
      })),
    }
    const service = createSearchService({ repository, embeddingAvailable: () => false })

    const result = await service.search({ auth, query: { q: 'trí tuệ nhân tạo', mode: 'hybrid' } })

    expect(result.meta).toEqual({ hasNext: false, nextCursor: null, requestedMode: 'hybrid', effectiveMode: 'text', fallbackUsed: true, fallbackReason: 'embedding-unavailable' })
    expect(result.results[0].semanticScore).toBeNull()
    expect(repository.searchVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID, q: 'trí tuệ nhân tạo' }))
  })

  it('keeps requested text mode non-degraded and rejects an invalid query before repository I/O', async () => {
    const repository = { searchVisibleArticles: vi.fn(async () => ({ results: [], hasNext: false, nextCursor: null })) }
    const service = createSearchService({ repository })
    expect((await service.search({ auth, query: { q: 'AI', mode: 'text' } })).meta).toEqual(expect.objectContaining({ requestedMode: 'text', effectiveMode: 'text', fallbackUsed: false, fallbackReason: null }))
    await expect(service.search({ auth, query: { q: 'x' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(repository.searchVisibleArticles).toHaveBeenCalledTimes(1)
  })

  it('owns saved mutations by the session user and preserves cleanup-only list semantics', async () => {
    const repository = {
      listSavedVisibleArticles: vi.fn(async () => ({ articles: [], hasNext: false, nextCursor: null })),
      saveVisibleArticle: vi.fn(async () => true),
      unsaveArticle: vi.fn(async () => undefined),
      clearSavedArticles: vi.fn(async () => undefined),
    }
    const service = createSavedService({ repository })

    expect(await service.list({ auth, query: {} })).toEqual({ articles: [], hasNext: false, nextCursor: null })
    await service.save({ auth, articleId: ARTICLE_ID })
    await service.unsave({ auth, articleId: ARTICLE_ID })
    await service.clear({ auth })

    expect(repository.listSavedVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }))
    expect(repository.saveVisibleArticle).toHaveBeenCalledWith({
      userId: USER_ID,
      articleId: ARTICLE_ID,
      actorFence: { sessionId: SESSION_ID, sessionVersion: SESSION_VERSION },
    })
    expect(repository.unsaveArticle).toHaveBeenCalledWith({ userId: USER_ID, articleId: ARTICLE_ID })
    expect(repository.clearSavedArticles).toHaveBeenCalledWith({ userId: USER_ID })
  })

  it('does not create a saved relation for an article outside current visibility', async () => {
    const service = createSavedService({ repository: { saveVisibleArticle: vi.fn(async () => false) } })
    await expect(service.save({ auth, articleId: ARTICLE_ID })).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})
