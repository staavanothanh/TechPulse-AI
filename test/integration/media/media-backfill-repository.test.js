import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { articleDocument, MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { makeCandidate, makeSource, OTHER_SOURCE_ID, RETRIEVED_AT, SOURCE_ID } from '../../unit/articles/fixtures.js'

const ARTICLE_ID = new ObjectId('507f1f77bcf86cd799439301')

function sourceDocument(overrides = {}) {
  return { ...makeSource({
    mediaPolicy: {
      imageMode: 'remote-preview',
      videoMode: 'none',
      allowedHosts: ['cdn.example.com'],
      attributionRequired: false,
      evidenceNote: null,
    },
    ...overrides,
  }), _id: new ObjectId(SOURCE_ID), updatedAt: RETRIEVED_AT }
}

function legacyArticle(source) {
  return articleDocument(normalizeCandidateToArticle(makeCandidate({ mediaCandidate: undefined }), { source, now: RETRIEVED_AT }), ARTICLE_ID)
}

function repositoryFixture({ source = sourceDocument(), article = legacyArticle(source), canonicalMatches = [] } = {}) {
  const articles = {
    findOne: vi.fn(async (filter) => filter.externalId ? article : null),
    find: vi.fn(() => ({ limit: vi.fn(() => ({ toArray: vi.fn(async () => canonicalMatches) })) })),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  }
  const sources = {
    findOne: vi.fn(async () => source),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  }
  const repository = new MongoArticleRepository({ db: {}, client: {}, now: () => RETRIEVED_AT })
  repository.withTransaction = vi.fn(async (work) => work({}))
  repository.articles = () => articles
  repository.sources = () => sources
  return { repository, source, article, articles, sources }
}

describe('media backfill repository boundary', () => {
  it('atomically fills an eligible same-source legacy article and only changes media fields', async () => {
    const { repository, source, articles, sources } = repositoryFixture()

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
      limit: 10,
    })

    expect(result).toMatchObject({ inspected: 1, updated: 1, wouldUpdate: 0, skipped: 0, failed: 0 })
    expect(articles.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ARTICLE_ID, sourceId: new ObjectId(SOURCE_ID), status: 'published', leadMedia: null, leadMediaStatus: 'none' }),
      expect.objectContaining({ $set: expect.objectContaining({ leadMediaStatus: 'available', leadMedia: expect.objectContaining({ url: 'https://cdn.example.com/image.jpg' }) }), $unset: { leadMediaHiddenReason: '' } }),
      expect.any(Object),
    )
    const articleUpdate = articles.updateOne.mock.calls[0][1]
    expect(articleUpdate.$set.updatedAt.getTime()).toBeGreaterThan(RETRIEVED_AT.getTime())
    expect(sources.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new ObjectId(SOURCE_ID),
        policyVersion: source.policyVersion,
        connectorType: 'rss',
        operationalStatus: 'active',
        licenseStatus: { $in: ['permitted', 'metadata-only'] },
        'technicalCheck.status': 'passed',
      }),
      expect.any(Object),
    )
    expect(sources.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: new ObjectId(SOURCE_ID),
        policyVersion: source.policyVersion,
        updatedAt: source.updatedAt,
        connectorConfig: source.connectorConfig,
      }),
      expect.objectContaining({ $set: { updatedAt: expect.any(Date) } }),
      expect.any(Object),
    )
    expect(sources.updateOne.mock.invocationCallOrder[0]).toBeLessThan(articles.updateOne.mock.invocationCallOrder[0])
  })

  it('previews eligible updates without writing and skips a host denied by the current policy', async () => {
    const { repository, source, articles, sources } = repositoryFixture()
    const preview = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
      dryRun: true,
    })
    const denied = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate({ mediaCandidate: { type: 'image', url: 'https://other.example.com/image.jpg' } })],
    })

    expect(preview).toMatchObject({ inspected: 1, updated: 0, wouldUpdate: 1, skipped: 0 })
    expect(denied).toMatchObject({ updated: 0, skipped: 1, skippedReasons: { media_host_denied: 1 } })
    expect(articles.updateOne).not.toHaveBeenCalled()
    expect(sources.updateOne).not.toHaveBeenCalled()
  })

  it('skips before candidate processing when the source fence no longer matches the current reviewed source', async () => {
    const source = sourceDocument()
    const drifted = { ...source, policyVersion: source.policyVersion + 1 }
    const { repository, articles, sources } = repositoryFixture({ source })
    sources.findOne.mockResolvedValue(drifted)

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
    })

    expect(result).toMatchObject({ inspected: 0, updated: 0, skipped: 1, skippedReasons: { source_policy_changed: 1 } })
    expect(articles.findOne).not.toHaveBeenCalled()
    expect(articles.updateOne).not.toHaveBeenCalled()
  })

  it('fails closed when the in-transaction source CAS fence loses a policy replacement race', async () => {
    const source = sourceDocument()
    const { repository, articles, sources } = repositoryFixture({ source })
    sources.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
    })

    expect(result).toMatchObject({ inspected: 0, updated: 0, skipped: 1, skippedReasons: { source_policy_changed: 1 } })
    expect(articles.updateOne).not.toHaveBeenCalled()
  })

  it('does not use a cross-source canonical match', async () => {
    const source = sourceDocument()
    const crossSourceArticle = { ...legacyArticle(source), sourceId: new ObjectId(OTHER_SOURCE_ID) }
    const { repository, articles } = repositoryFixture({ source, canonicalMatches: [crossSourceArticle] })
    articles.findOne.mockResolvedValue(null)

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate({ externalId: undefined })],
    })

    expect(result).toMatchObject({ updated: 0, skipped: 1, skippedReasons: { no_matching_article: 1 } })
    expect(articles.find).toHaveBeenCalledWith(expect.objectContaining({ sourceId: new ObjectId(SOURCE_ID) }), expect.any(Object))
    expect(articles.updateOne).not.toHaveBeenCalled()
  })

  it('does not overwrite a hidden or already managed media record', async () => {
    const source = sourceDocument()
    const protectedArticle = { ...legacyArticle(source), status: 'hidden', leadMediaStatus: 'hidden' }
    const { repository, articles } = repositoryFixture({ source, article: protectedArticle })

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
    })

    expect(result).toMatchObject({ updated: 0, skipped: 1, skippedReasons: { no_matching_article: 1 } })
    expect(articles.updateOne).not.toHaveBeenCalled()
  })

  it('does not update an external-ID record when its row CAS loses a concurrent change', async () => {
    const source = sourceDocument()
    const { repository, articles } = repositoryFixture({ source })
    articles.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 })

    const result = await repository.backfillLeadMediaCandidates({
      source,
      expectedSourcePolicyVersion: source.policyVersion,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
    })

    expect(result).toMatchObject({ updated: 0, skipped: 1, skippedReasons: { article_changed: 1 } })
    expect(articles.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: RETRIEVED_AT }),
      expect.any(Object),
      expect.any(Object),
    )
  })
})
