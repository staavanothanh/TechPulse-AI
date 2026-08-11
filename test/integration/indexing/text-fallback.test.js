import { describe, expect, it, vi } from 'vitest'
import { createSearchService } from '../../../server/application/search/service.js'

describe('Step 9 text-fallback integration gate', () => {
  it('returns successful text metadata when semantic provider throws', async () => {
    const repository = { searchVisibleArticles: vi.fn(async () => ({ results: [], hasNext: false, nextCursor: null })) }
    const service = createSearchService({ repository, queryEmbedding: async () => { throw new Error('semantic outage') } })
    const result = await service.search({ auth: { user: { id: '507f1f77bcf86cd799439001', status: 'active' } }, query: { q: 'công nghệ AI', mode: 'hybrid' } })
    expect(result.meta).toEqual(expect.objectContaining({ effectiveMode: 'text', fallbackUsed: true, fallbackReason: 'embedding-unavailable' }))
    expect(repository.searchVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text' }))
  })

  it('reports provider-timeout while preserving successful text search for retryable provider outages', async () => {
    const repository = { searchVisibleArticles: vi.fn(async () => ({ results: [], hasNext: false, nextCursor: null })) }
    const service = createSearchService({ repository, queryEmbedding: async () => { throw Object.assign(new Error('provider timeout'), { retryable: true }) } })
    const result = await service.search({ auth: { user: { id: '507f1f77bcf86cd799439001', status: 'active' } }, query: { q: 'công nghệ AI', mode: 'hybrid' } })
    expect(result.meta).toEqual(expect.objectContaining({ effectiveMode: 'text', fallbackUsed: true, fallbackReason: 'provider-timeout' }))
  })
})
