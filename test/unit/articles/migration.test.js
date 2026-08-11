import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES, buildArticlesMigration, runArticlesMigration, validateArticleDocument } from '../../../scripts/migrations/articles.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/durable-jobs.js'
import { canonicalUrlHash } from '../../../server/domain/article/identity.js'

function validArticle() {
  const now = new Date('2026-08-11T00:00:00.000Z')
  const sourceId = new ObjectId()
  return {
    _id: new ObjectId(), sourceId, connectorType: 'rss', externalId: 'item-1', sourceType: 'rss:example', authorityTier: 'editorial', evidenceEligible: true, status: 'published',
    titleOriginal: 'Safe title', originalUrl: 'https://example.com/article', canonicalUrl: 'https://example.com/article', canonicalUrlHash: canonicalUrlHash('https://example.com/article'), author: 'Ada', publishedAt: now, retrievedAt: now, sourceLanguage: 'en', topics: ['ai'], searchTextNormalized: 'safe title ai',
    leadMedia: null, leadMediaStatus: 'none', summaryVi: null, summaryStatus: 'pending', summaryBasis: null, contentScope: 'metadata', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'metadata-only', llmInputScope: 'metadata', capturedAt: now },
    embeddingStatus: 'pending', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null,
    provenance: [{ sourceId, originalUrl: 'https://example.com/article', externalId: 'item-1', observedAt: now }], dedupeKey: 'source:external', createdAt: now, updatedAt: now,
  }
}

describe('articles migration contract', () => {
  it('defines closed article schema and exact dedupe/visibility/search indexes', () => {
    expect(ARTICLE_COLLECTIONS.articles.validator).toBeTruthy()
    expect(ARTICLE_INDEXES.articles).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'articles_source_external_unique', key: { sourceId: 1, externalId: 1 }, options: { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } } }),
      expect.objectContaining({ name: 'articles_canonical_url_hash', key: { canonicalUrlHash: 1 } }),
      expect.objectContaining({ name: 'articles_status_published', key: { status: 1, publishedAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'articles_search_text', key: { titleOriginal: 'text', titleVi: 'text', summaryVi: 'text', topics: 'text', searchTextNormalized: 'text' } }),
    ]))
  })

  it('validates published metadata/provenance and rejects raw/full-text/media binary fields', () => {
    const article = validArticle()
    expect(validateArticleDocument(article)).toEqual({ valid: true, errors: [] })
    for (const field of ['rawHtml', 'body', 'fullText', 'translatedFullText', 'mediaBinary', 'gridFsId']) {
      const invalid = { ...article, [field]: 'forbidden' }
      expect(validateArticleDocument(invalid).valid).toBe(false)
    }
    const invalidPublished = { ...article, provenance: [] }
    expect(validateArticleDocument(invalidPublished).valid).toBe(false)
  })

  it('keeps hidden media metadata valid for audit while none removes the relation', () => {
    const article = validArticle()
    article.leadMedia = { type: 'image', displayMode: 'remote-preview', url: 'https://cdn.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: null, credit: null, attribution: 'Example', mediaEvidenceStatus: 'not-analyzed', sourcePolicyVersion: 1 }
    article.leadMediaStatus = 'hidden'
    expect(validateArticleDocument(article)).toEqual({ valid: true, errors: [] })
    expect(validateArticleDocument({ ...article, leadMediaStatus: 'none' }).valid).toBe(false)
  })

  it('builds only idempotent create/collMod/index operations', () => {
    const first = buildArticlesMigration({ dryRun: true })
    const second = buildArticlesMigration({ dryRun: true, existingCollections: ['articles'], existingIndexes: { articles: ARTICLE_INDEXES.articles.map((index) => index.name) } })
    expect(first.length).toBeGreaterThan(0)
    expect(first.every(({ type }) => ['createCollection', 'collMod', 'createIndex'].includes(type))).toBe(true)
    expect(first.some(({ type }) => type.startsWith('drop'))).toBe(false)
    expect(second.filter(({ type }) => type === 'createIndex')).toHaveLength(0)
  })

  it('fails closed before applying when the durable-jobs predecessor is not present', async () => {
    const db = { createCollection: vi.fn(), listCollections: vi.fn(() => ({ toArray: vi.fn(async () => []) })) }
    await expect(runArticlesMigration({ db })).rejects.toThrow(/durable-jobs migration/i)
    expect(db.createCollection).not.toHaveBeenCalled()
  })

  it('applies the versioned plan only after the exact predecessor validator', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: vi.fn(async () => [{ name: 'adminAuditLogs', options: { validator: DURABLE_JOB_AUDIT_VALIDATOR } }]) })),
      createCollection: vi.fn(async () => undefined),
      command: vi.fn(async () => undefined),
      collection: vi.fn(() => ({ createIndex: vi.fn(async () => 'index-name') })),
    }
    const plan = await runArticlesMigration({ db })
    expect(plan).toHaveLength(10)
    expect(db.createCollection).toHaveBeenCalledWith('articles', expect.objectContaining({ validationLevel: 'strict', validationAction: 'error' }))
    expect(db.command).toHaveBeenCalledWith(expect.objectContaining({ collMod: 'articles' }))
  })
})
