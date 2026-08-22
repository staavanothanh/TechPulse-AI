import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const USER_ID = '507f1f77bcf86cd799439001'

function visibleDocument() {
  return {
    _id: new ObjectId(ARTICLE_ID),
    sourceId: new ObjectId(SOURCE_ID),
    status: 'published',
    titleOriginal: 'Verified article',
    titleVi: null,
    publishedAt: new Date('2026-08-10T08:00:00.000Z'),
    sourceLanguage: 'en',
    topics: ['AI'],
    excerptOriginal: 'AI infrastructure',
    summaryVi: null,
    summaryStatus: 'pending',
    summaryBasis: null,
    leadMedia: null,
    leadMediaStatus: 'none',
    embedding: [0.1, 0.2],
    fullText: 'must not reach the feed worker',
    _currentSource: {
      _id: new ObjectId(SOURCE_ID),
      name: 'Tech Review',
      authorityTier: 'editorial',
      operationalStatus: 'active',
      licenseStatus: 'metadata-only',
      llmInputScope: 'metadata',
      storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
      mediaPolicy: {
        imageMode: 'remote-preview',
        videoMode: 'link-only',
        allowedHosts: ['media.example.com'],
        attributionRequired: true,
        evidenceNote: 'Reviewed remote preview policy',
      },
      attributionRequired: true,
      attributionText: 'Tech Review',
      policyVersion: 4,
    },
    _isSaved: [],
  }
}

describe('Mongo article feed projection', () => {
  it('reads only public-card fields before the saved lookup, sort and limit', async () => {
    const aggregate = vi.fn(() => ({ toArray: vi.fn(async () => [visibleDocument()]) }))
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })

    await repository.listVisibleArticles({ userId: USER_ID, limit: 20 })

    const pipeline = aggregate.mock.calls[0][0]
    const projectionIndex = pipeline.findIndex((stage) => stage.$project)
    const limitIndex = pipeline.findIndex((stage) => stage.$limit === 21)
    const savedLookupIndex = pipeline.findIndex((stage) => stage.$lookup?.from === 'savedArticles')
    const sortIndex = pipeline.findIndex((stage) => stage.$sort)
    expect(projectionIndex).toBeGreaterThan(-1)
    expect(projectionIndex).toBeLessThan(savedLookupIndex)
    expect(projectionIndex).toBeLessThan(sortIndex)
    expect(projectionIndex).toBeLessThan(limitIndex)
    expect(pipeline[projectionIndex].$project).toEqual({
      _id: 1,
      sourceId: 1,
      status: 1,
      titleOriginal: 1,
      titleVi: 1,
      publishedAt: 1,
      sourceLanguage: 1,
      topics: 1,
      excerptOriginal: 1,
      summaryVi: 1,
      summaryStatus: 1,
      summaryBasis: 1,
      leadMedia: 1,
      leadMediaStatus: 1,
      _isSaved: 1,
      '_currentSource._id': 1,
      '_currentSource.name': 1,
      '_currentSource.authorityTier': 1,
      '_currentSource.operationalStatus': 1,
      '_currentSource.licenseStatus': 1,
      '_currentSource.llmInputScope': 1,
      '_currentSource.storageScope': 1,
      '_currentSource.mediaPolicy': 1,
      '_currentSource.attributionRequired': 1,
      '_currentSource.attributionText': 1,
      '_currentSource.policyVersion': 1,
    })
  })

  it('keeps a permitted media card, saved marker and cursor when Mongo returns projected fields', async () => {
    const first = visibleDocument()
    first.leadMediaStatus = 'available'
    first.leadMedia = {
      type: 'image',
      displayMode: 'remote-preview',
      url: 'https://media.example.com/image.jpg',
      sourcePageUrl: 'https://example.com/article',
      altText: 'AI infrastructure',
      attribution: 'Tech Review',
      mediaEvidenceStatus: 'not-analyzed',
      sourcePolicyVersion: 4,
    }
    first._isSaved = [{ _id: new ObjectId() }]
    const second = visibleDocument()
    second._id = new ObjectId('507f1f77bcf86cd799439012')
    const aggregate = vi.fn(() => ({ toArray: vi.fn(async () => [first, second]) }))
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    repository.articles = () => ({ aggregate })

    const page = await repository.listVisibleArticles({ userId: USER_ID, limit: 1 })

    expect(page).toEqual(
      expect.objectContaining({
        articles: [
          expect.objectContaining({
            id: ARTICLE_ID,
            isSaved: true,
            leadMedia: expect.objectContaining({
              type: 'image',
              url: 'https://media.example.com/image.jpg',
              attribution: 'Tech Review',
            }),
          }),
        ],
        hasNext: true,
        nextCursor: expect.any(String),
      }),
    )
  })
})
