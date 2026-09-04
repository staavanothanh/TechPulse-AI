import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { classifyTopicIds, classifyLegacyTopics, canonicalTopicIds, TOPIC_TAXONOMY_VERSION } from '../../../shared/topic-catalog.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { canUseQnaEvidence } from '../../../server/domain/article/visibility.js'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { makeCandidate, makeSource, OTHER_SOURCE_ID, RETRIEVED_AT, SOURCE_ID } from './fixtures.js'

const TAXONOMY_TITLE = 'Cloud data infrastructure with Kubernetes'
const TAXONOMY_EXCERPT = 'A database pipeline stores analytics for modern teams'

// Complete published editorial article document whose legacy topics were never
// enriched into the canonical taxonomy (pre-article-topics-qa backfill state).
function legacyArticleDocument(overrides = {}) {
  const now = new Date('2026-08-11T00:00:00.000Z')
  const sourceId = new ObjectId(SOURCE_ID)
  return {
    _id: new ObjectId(),
    sourceId,
    connectorType: 'rss',
    sourceType: 'rss:example',
    authorityTier: 'editorial',
    evidenceEligible: true,
    status: 'published',
    titleOriginal: TAXONOMY_TITLE,
    originalUrl: 'https://example.com/articles/cloud-kubernetes',
    canonicalUrl: 'https://example.com/articles/cloud-kubernetes',
    canonicalUrlHash: 'cafebabe',
    author: 'Ada Example',
    publishedAt: now,
    retrievedAt: now,
    sourceLanguage: 'en',
    topics: [],
    searchTextNormalized: TAXONOMY_TITLE.toLowerCase(),
    excerptOriginal: TAXONOMY_EXCERPT,
    leadMedia: null,
    leadMediaStatus: 'none',
    summaryVi: null,
    summaryStatus: 'pending',
    summaryBasis: null,
    contentScope: 'excerpt',
    rightsSnapshot: { sourcePolicyVersion: 3, licenseStatus: 'permitted', llmInputScope: 'excerpt', capturedAt: now },
    embeddingStatus: 'pending',
    embedding: null,
    embeddingModel: null,
    embeddingDimensions: null,
    embeddingInputHash: null,
    embeddingVersion: null,
    embeddingSourcePolicyVersion: null,
    embeddedAt: null,
    embeddingError: null,
    provenance: [{ sourceId, originalUrl: 'https://example.com/articles/cloud-kubernetes', externalId: 'item-1', observedAt: now }],
    dedupeKey: 'source:external',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function repositoryFixture({ articles, sources = {}, withTransaction = true } = {}) {
  const collections = {
    articles: articles ?? {
      findOne: vi.fn(async () => null),
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: vi.fn(async () => []) }) }) })),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    },
    sources: { findOne: vi.fn(async () => null), ...sources },
  }
  const db = { collection: vi.fn((name) => collections[name]) }
  const transactionSession = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn(async () => undefined) }
  const client = { startSession: vi.fn(() => transactionSession) }
  const repository = new MongoArticleRepository({ db, client, now: () => RETRIEVED_AT })
  if (!withTransaction) repository.withTransaction = vi.fn(async (work) => work())
  return { repository, collections, db, client }
}

describe('article topic enrichment contracts', () => {
  describe('backfill enrichment of legacy article documents (RED seam)', () => {
    it('reports a bounded dry-run that would enrich the legacy document without writing', async () => {
      const doc = legacyArticleDocument()
      const { repository, collections } = repositoryFixture({ withTransaction: false })

      const report = await repository.backfillArticleTopicCandidates({ articles: [doc], dryRun: true })

      expect(report).toMatchObject({ scanned: 1, wouldUpdate: 1, migrated: 0 })
      expect(report.skipped ?? 0).toBe(0)
      expect(collections.articles.updateOne).not.toHaveBeenCalled()
    })

    it('writes canonical topics under a compare-and-swap fence and is idempotent on the second execution', async () => {
      const doc = legacyArticleDocument()
      const migrated = legacyArticleDocument({
        topics: ['devops', 'dữ liệu'],
        topicIds: ['devops-cloud', 'containers-orchestration', 'computer-science', 'databases', 'data-engineering'],
        topicTaxonomyVersion: TOPIC_TAXONOMY_VERSION,
      })
      const articles = {
        findOne: vi.fn(async () => null),
        updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
      }
      const { repository } = repositoryFixture({ articles, withTransaction: false })

      const first = await repository.backfillArticleTopicCandidates({ articles: [doc], dryRun: false })

      expect(first).toMatchObject({ scanned: 1, migrated: 1, wouldUpdate: 0 })
      expect(articles.updateOne).toHaveBeenCalledTimes(1)
      const [filter, update] = articles.updateOne.mock.calls[0]
      expect(filter).toEqual(
        expect.objectContaining({
          _id: doc._id,
          updatedAt: doc.updatedAt,
          status: { $ne: 'removed' },
        }),
      )
      expect(update.$set).toEqual(
        expect.objectContaining({
          topics: ['devops', 'dữ liệu'],
          topicIds: ['devops-cloud', 'containers-orchestration', 'computer-science', 'databases', 'data-engineering'],
          topicTaxonomyVersion: 1,
          searchTextNormalized: expect.any(String),
          updatedAt: expect.any(Date),
        }),
      )

      articles.updateOne.mockClear()
      const second = await repository.backfillArticleTopicCandidates({ articles: [migrated], dryRun: false })

      expect(second).toMatchObject({ scanned: 1, migrated: 0, wouldUpdate: 0 })
      expect(articles.updateOne).not.toHaveBeenCalled()
    })

    it('keeps documents with no classifier signal untouched and never fabricates IDs for unknown legacy topics', async () => {
      const unknown = legacyArticleDocument({ titleOriginal: 'Morning notes', excerptOriginal: 'A quiet journal about walks', topics: ['Safety', 'morning-journal'] })
      const articles = { findOne: vi.fn(async () => null), updateOne: vi.fn(async () => ({ matchedCount: 1 })) }
      const { repository } = repositoryFixture({ articles, withTransaction: false })

      const report = await repository.backfillArticleTopicCandidates({ articles: [unknown], dryRun: false })

      expect(report).toMatchObject({ scanned: 1, migrated: 0, wouldUpdate: 0, skipped: 1 })
      expect(articles.updateOne).not.toHaveBeenCalled()
    })
  })

  describe('Q&A evidence fence and topic-scoped retrieval (passing contract pin)', () => {
    const TOPIC_IDS = ['devops-cloud', 'containers-orchestration']
    const baseSource = makeSource()

    function enrichedDocument(overrides = {}) {
      return legacyArticleDocument({
        topics: ['devops'],
        topicIds: TOPIC_IDS,
        topicTaxonomyVersion: TOPIC_TAXONOMY_VERSION,
        ...overrides,
      })
    }

    it('admits a fully enriched editorial document and excludes community-signal and hidden evidence', () => {
      const enriched = enrichedDocument()
      const community = enrichedDocument({ authorityTier: 'community-signal', evidenceEligible: false, sourceId: new ObjectId(OTHER_SOURCE_ID) })
      const hidden = enrichedDocument({ status: 'hidden' })
      const rightsMismatch = enrichedDocument()
      const communitySource = makeSource({ id: OTHER_SOURCE_ID, authorityTier: 'community-signal' })

      expect(canUseQnaEvidence(enriched, baseSource)).toBe(true)
      expect(canUseQnaEvidence(community, communitySource)).toBe(false)
      expect(canUseQnaEvidence(hidden, baseSource)).toBe(false)
      expect(canUseQnaEvidence(rightsMismatch, makeSource({ policyVersion: 2 }))).toBe(false)
    })

    it('lets a topic-scoped Q&A query match the enriched document through canonical topicIds and legacy topic values', async () => {
      const { repository, collections } = repositoryFixture({
        articles: {
          findOne: vi.fn(async () => null),
          find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: vi.fn(async () => []) }) }) })),
          updateOne: vi.fn(async () => ({ matchedCount: 1 })),
        },
        withTransaction: false,
      })
      collections.articles.find.mockReturnValue({ sort: () => ({ limit: () => ({ toArray: vi.fn(async () => [enrichedDocument()]) }) }) })

      await repository.findQnaEvidence({ limit: 20, scope: { topics: ['DevOps'] } })

      const query = collections.articles.find.mock.calls.at(-1)[0]
      expect(query.$or).toEqual(
        expect.arrayContaining([
          { topicIds: { $in: expect.arrayContaining(['devops-cloud', 'containers-orchestration']) } },
          { topics: { $in: expect.arrayContaining(['devops']) } },
        ]),
      )
    })
  })

  describe('metadata-only classification stays independent of full text (passing contract pin)', () => {
    it('classifies topicIds from title metadata alone and preserves rights and eligibility fields', () => {
      const source = makeSource({
        licenseStatus: 'metadata-only',
        llmInputScope: 'metadata',
        storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
        mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
      })
      const article = normalizeCandidateToArticle(
        makeCandidate({ topics: [], titleOriginal: 'Kubernetes autoscaling', excerptOriginal: 'Horizontal pod autoscaling uses CPU metrics' }),
        { source, now: RETRIEVED_AT },
      )

      expect(article).not.toHaveProperty('excerptOriginal')
      expect(article.topicIds).toContain('devops-cloud')
      expect(article.topicIds).toContain('containers-orchestration')
      expect(article.topicTaxonomyVersion).toBe(1)
      expect(article.authorityTier).toBe('editorial')
      expect(article.evidenceEligible).toBe(true)
      expect(article.rightsSnapshot).toEqual(
        expect.objectContaining({ sourcePolicyVersion: 3, licenseStatus: 'metadata-only', llmInputScope: 'metadata' }),
      )
      expect(article.status).toBe('published')
    })
  })

  describe('topic classifier determinism and taxonomy closure (passing contract pin)', () => {
    it('is deterministic, returns frozen arrays and closes leaf topics over ancestors', () => {
      const first = classifyTopicIds({ titleOriginal: TAXONOMY_TITLE, excerptOriginal: TAXONOMY_EXCERPT })
      const second = classifyTopicIds({ titleOriginal: TAXONOMY_TITLE, excerptOriginal: TAXONOMY_EXCERPT })

      expect(TOPIC_TAXONOMY_VERSION).toBe(1)
      expect(first).toEqual(second)
      expect(Object.isFrozen(first)).toBe(true)
      expect(classifyLegacyTopics({ titleOriginal: TAXONOMY_TITLE, excerptOriginal: TAXONOMY_EXCERPT })).toEqual(['devops', 'dữ liệu'])
      expect(canonicalTopicIds(['databases'])).toEqual(['computer-science', 'databases'])
    })

    it('classifies future-connector text into AI Agent parents and leaves', () => {
      const title = 'Agentic systems orchestrate tool use for autonomous workflows'
      const canonical = classifyTopicIds({ titleOriginal: title, excerptOriginal: '' })

      expect(canonical).toContain('ai-agent')
      expect(canonical).toContain('agentic-systems')
      expect(canonical).not.toContain('safety')
      expect(classifyTopicIds({ values: [], titleOriginal: 'Morning notes', excerptOriginal: '' })).toEqual([])
    })
  })
})
