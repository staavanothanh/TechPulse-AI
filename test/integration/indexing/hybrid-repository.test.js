import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'

const USER_ID = '507f1f77bcf86cd799439001'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const source = { _id: new ObjectId(SOURCE_ID), name: 'Tech Review', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', technicalCheck: { status: 'passed' }, policyVersion: 4, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false } }

function article(id, overrides = {}) {
  return {
    _id: new ObjectId(id), sourceId: new ObjectId(SOURCE_ID), status: 'published', titleOriginal: 'AI accelerator', titleVi: null,
    originalUrl: `https://example.com/${id}`, publishedAt: new Date('2026-08-10T00:00:00.000Z'), retrievedAt: new Date('2026-08-10T01:00:00.000Z'),
    sourceLanguage: 'en', topics: ['ai'], summaryStatus: 'ready', summaryVi: 'Tóm tắt tiếng Việt.', summaryBasis: 'metadata',
    leadMedia: null, leadMediaStatus: 'none', embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1,
    embedding: Array(1024).fill(0), _currentSource: source, _isSaved: [], ...overrides,
  }
}

describe('Step 9 Mongo hybrid retrieval repository', () => {
  it('unions text and compatible semantic candidates, ranks cosine and keeps HN community discovery', async () => {
    const text = article('507f1f77bcf86cd799439011', { _textScore: 4, embedding: [0, ...Array(1023).fill(0)] })
    const communitySource = { ...source, name: 'Hacker News', authorityTier: 'community-signal' }
    const semantic = article('507f1f77bcf86cd799439012', { titleOriginal: 'Community signal', authorityTier: 'community-signal', evidenceEligible: false, _currentSource: communitySource, embedding: [1, ...Array(1023).fill(0)] })
    const aggregate = vi.fn((pipeline) => ({ toArray: vi.fn(async () => JSON.stringify(pipeline).includes('$text') ? [text] : [text, semantic]) }))
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })

    const result = await repository.searchVisibleArticles({
      userId: USER_ID, q: 'chip AI', mode: 'hybrid', limit: 20,
      queryEmbedding: { model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: [1, ...Array(1023).fill(0)] },
    })

    expect(aggregate).toHaveBeenCalledTimes(2)
    expect(result.fallbackReason).toBeNull()
    expect(result.results.map(({ article: item }) => item.id)).toEqual([semantic._id.toHexString(), text._id.toHexString()])
    expect(result.results[0]).toEqual(expect.objectContaining({ semanticScore: 1, textScore: 0, score: 0.55 }))
    expect(result.results[0].article.source.authorityTier).toBe('community-signal')
  })

  it('returns the text page with an explicit fallback when no compatible vectors exist', async () => {
    const text = article('507f1f77bcf86cd799439011', { _textScore: 4, embeddingStatus: 'pending', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingVersion: null })
    const aggregate = vi.fn((pipeline) => ({ toArray: vi.fn(async () => JSON.stringify(pipeline).includes('$text') ? [text] : []) }))
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })
    const result = await repository.searchVisibleArticles({
      userId: USER_ID, q: 'chip AI', mode: 'hybrid', limit: 20,
      queryEmbedding: { model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: Array(1024).fill(0.01) },
    })
    expect(result.fallbackReason).toBe('no-compatible-vectors')
    expect(result.results[0]).toEqual(expect.objectContaining({ semanticScore: null, article: expect.objectContaining({ id: text._id.toHexString() }) }))
  })
})
