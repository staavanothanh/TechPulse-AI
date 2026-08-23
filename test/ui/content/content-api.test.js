import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../../../shared/generated/api-client.js'
import { createContentApi } from '../../../client/features/feed/content-api.js'

describe('Step 8 generated-client content adapter', () => {
  it('adds feed/search query controls without parsing or displaying an opaque cursor', async () => {
    const fetchImpl = vi.fn(async (_url) => new Response(JSON.stringify({ data: [], meta: { hasNext: false, nextCursor: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const api = createContentApi(createApiClient(), fetchImpl)

    await api.listArticles({ topic: 'AI', cursor: 'opaque-cursor-value', limit: 20 })
    await api.listArticles({ page: 3, limit: 20 })
    await api.listArticles({ lastPage: true, limit: 20 })
    await api.searchArticles({ q: 'chip mới', mode: 'text', sourceId: 'source-1' })

    const feedUrl = new URL(fetchImpl.mock.calls[0][0])
    const searchUrl = new URL(fetchImpl.mock.calls[3][0])
    expect(feedUrl.pathname).toBe('/api/v1/articles')
    expect(feedUrl.searchParams.get('cursor')).toBe('opaque-cursor-value')
    const jumpedFeedUrl = new URL(fetchImpl.mock.calls[1][0])
    expect(jumpedFeedUrl.searchParams.get('page')).toBe('3')
    const lastFeedUrl = new URL(fetchImpl.mock.calls[2][0])
    expect(lastFeedUrl.searchParams.get('lastPage')).toBe('true')
    expect(searchUrl.searchParams.get('q')).toBe('chip mới')
    expect(searchUrl.searchParams.get('mode')).toBe('text')
  })

  it('preserves Retry-After on generated-client errors for the search UI cooldown', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded', requestId: 'req_rate' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '17' } }))
    const api = createContentApi(createApiClient(), fetchImpl)
    await expect(api.searchArticles({ q: 'AI', mode: 'text' })).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded', requestId: 'req_rate', retryAfter: 17 })
  })

  it('uses the generated 204 saved operations with the session CSRF token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const api = createContentApi(createApiClient(), fetchImpl)
    await api.saveArticle('article-1', 'csrf-token-for-saved')
    await api.unsaveArticle('article-1', 'csrf-token-for-saved')
    await api.clearSavedArticles('csrf-token-for-saved')
    expect(fetchImpl.mock.calls.map(([, init]) => init.method)).toEqual(['PUT', 'DELETE', 'DELETE'])
    expect(fetchImpl.mock.calls.every(([, init]) => init.headers['X-CSRF-Token'] === 'csrf-token-for-saved')).toBe(true)
  })
})
