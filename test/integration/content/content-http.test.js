import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app.js'

const USER_ID = '507f1f77bcf86cd799439001'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const token = 'content-session-token-12345'
const article = {
  id: ARTICLE_ID,
  titleOriginal: 'Verified article',
  titleVi: null,
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

const authService = {
  authenticate: vi.fn(async () => ({ user: { id: USER_ID, role: 'user', status: 'active' }, session: { _id: '507f1f77bcf86cd799439002' } })),
  verifyCsrf: vi.fn(async () => true),
}
const articleService = {
  list: vi.fn(async () => ({ articles: [article], hasNext: false, nextCursor: null, totalItems: 35 })),
  get: vi.fn(async () => ({ ...article, originalUrl: 'https://example.com/article', author: null, retrievedAt: '2026-08-10T09:00:00.000Z', citation: { sourceId: article.source.id, sourceName: article.source.name, titleOriginal: article.titleOriginal, originalUrl: 'https://example.com/article', author: null, publishedAt: article.publishedAt, sourceLanguage: article.sourceLanguage }, aiDisclosure: 'AI tổng hợp; hãy kiểm chứng với nguồn gốc.' })),
}
const searchService = {
  search: vi.fn(async () => ({ results: [{ article, score: 0.8, textScore: 0.8, semanticScore: null }], meta: { hasNext: false, nextCursor: null, requestedMode: 'text', effectiveMode: 'text', fallbackUsed: false, fallbackReason: null } })),
}
const savedService = {
  list: vi.fn(async () => ({ articles: [article], hasNext: false, nextCursor: null })),
  save: vi.fn(async () => undefined),
  unsave: vi.fn(async () => undefined),
  clear: vi.fn(async () => undefined),
}

let server
let origin

beforeAll(async () => {
  const app = createApp({ authService, articleService, searchService, savedService, imageCspHosts: ['media.example.com', 'cdn.example.com', 'media.example.com'] })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)) })

function headers(extra = {}) {
  return { Cookie: `__Host-techpulse_session=${token}`, ...extra }
}

describe('Step 8 content HTTP boundary', () => {
  it('requires authentication for feed, search, detail and saved list', async () => {
    for (const path of ['/api/v1/articles', '/api/v1/search-results?q=AI&mode=text', `/api/v1/articles/${ARTICLE_ID}`, '/api/v1/me/saved-articles']) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401)
    }
  })

  it('serializes canonical collection/detail/search envelopes with private no-store caching', async () => {
    const feed = await fetch(`${origin}/api/v1/articles?topic=AI`, { headers: headers() })
    const detail = await fetch(`${origin}/api/v1/articles/${ARTICLE_ID}`, { headers: headers() })
    const search = await fetch(`${origin}/api/v1/search-results?q=AI&mode=text`, { headers: headers() })

    expect(await feed.json()).toEqual({ data: [article], meta: { hasNext: false, nextCursor: null, totalItems: 35 } })
    expect((await detail.json()).data.originalUrl).toBe('https://example.com/article')
    const searchPayload = await search.json()
    expect(searchPayload.meta).toEqual(expect.objectContaining({ requestedMode: 'text', effectiveMode: 'text' }))
    expect(searchPayload.data[0].semanticScore).toBeNull()
    expect(feed.headers.get('cache-control')).toBe('no-store, private')
  })

  it('limits browser image loads to self and exact reviewed HTTPS hosts', async () => {
    const response = await fetch(`${origin}/api/v1/articles`, { headers: headers() })
    expect(response.headers.get('content-security-policy')).toBe("base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://cdn.example.com https://img.vietqr.io https://media.example.com")
    expect(response.headers.get('content-security-policy')).not.toMatch(/https:\s|\*\.|https:\/\/\*/)
  })

  it('enforces CSRF before saved mutations and returns bodyless 204 success', async () => {
    const missingCsrf = await fetch(`${origin}/api/v1/me/saved-articles/${ARTICLE_ID}`, { method: 'PUT', headers: headers({ Origin: 'http://localhost:3000' }) })
    expect(missingCsrf.status).toBe(403)
    expect(savedService.save).not.toHaveBeenCalled()

    const mutationHeaders = headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf-token-for-content-mutations' })
    const save = await fetch(`${origin}/api/v1/me/saved-articles/${ARTICLE_ID}`, { method: 'PUT', headers: mutationHeaders })
    const unsave = await fetch(`${origin}/api/v1/me/saved-articles/${ARTICLE_ID}`, { method: 'DELETE', headers: mutationHeaders })
    const clear = await fetch(`${origin}/api/v1/me/saved-articles`, { method: 'DELETE', headers: mutationHeaders })
    expect([save.status, unsave.status, clear.status]).toEqual([204, 204, 204])
    expect(await save.text()).toBe('')
    expect(savedService.save).toHaveBeenCalledWith(expect.objectContaining({ articleId: ARTICLE_ID }))
  })
})
