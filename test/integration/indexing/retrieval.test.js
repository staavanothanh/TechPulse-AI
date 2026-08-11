import { describe, expect, it, vi } from 'vitest'
import { createSearchService } from '../../../server/application/search/service.js'

const auth = { user: { id: '507f1f77bcf86cd799439001', role: 'user', status: 'active' } }
const textResult = { results: [], hasNext: false, nextCursor: null }

describe('Step 9 hybrid retrieval and text fallback service', () => {
  it('passes exact BGE-M3 query metadata to repository hybrid retrieval', async () => {
    const repository = { searchVisibleArticles: vi.fn(async () => textResult) }
    const vector = Array(1024).fill(0.01)
    const queryEmbedding = vi.fn(async () => ({ model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: vector }))
    const service = createSearchService({ repository, queryEmbedding })
    const result = await service.search({ auth, query: { q: 'chip AI tiết kiệm điện', mode: 'hybrid' } })
    expect(repository.searchVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ mode: 'hybrid', queryEmbedding: { model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: vector } }))
    expect(result.meta).toEqual(expect.objectContaining({ requestedMode: 'hybrid', effectiveMode: 'hybrid', fallbackUsed: false, fallbackReason: null }))
  })

  it('keeps text search available when query embedding/provider is unavailable', async () => {
    const repository = { searchVisibleArticles: vi.fn(async () => textResult) }
    const queryEmbedding = vi.fn(async () => { throw Object.assign(new Error('provider down'), { code: 'provider_unavailable' }) })
    const service = createSearchService({ repository, queryEmbedding })
    const result = await service.search({ auth, query: { q: 'chip AI tiết kiệm điện', mode: 'hybrid' } })
    expect(repository.searchVisibleArticles).toHaveBeenCalledTimes(1)
    expect(repository.searchVisibleArticles).toHaveBeenCalledWith(expect.objectContaining({ mode: 'text' }))
    expect(result.meta).toEqual(expect.objectContaining({ requestedMode: 'hybrid', effectiveMode: 'text', fallbackUsed: true, fallbackReason: 'embedding-unavailable' }))
  })
})
