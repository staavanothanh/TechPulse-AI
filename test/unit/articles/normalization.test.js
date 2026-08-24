import { describe, expect, it } from 'vitest'
import { ArticleError, normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { canUseQnaEvidence } from '../../../server/domain/article/visibility.js'
import { makeCandidate, makeSource, OTHER_SOURCE_ID, RETRIEVED_AT, SOURCE_ID } from './fixtures.js'

describe('article normalization and policy gates', () => {
  it('canonicalizes URL/time/language/topics and persists only policy-allowed excerpt/media metadata', () => {
    const article = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })

    expect(article).toMatchObject({
      sourceId: SOURCE_ID,
      connectorType: 'rss',
      titleOriginal: 'AI systems & safety',
      originalUrl: 'https://example.com/articles/ai-systems?a=1&b=2',
      canonicalUrl: 'https://example.com/articles/ai-systems?a=1&b=2',
      sourceLanguage: 'en-us',
      topics: ['ai', 'safety'],
      excerptOriginal: 'Safe excerpt .',
      status: 'published',
      contentScope: 'excerpt',
      summaryStatus: 'pending',
      summaryDetailStatus: 'pending',
      summaryParagraphsVi: null,
      embeddingStatus: 'pending',
      leadMediaStatus: 'available',
      leadMedia: expect.objectContaining({ displayMode: 'remote-preview', mediaEvidenceStatus: 'not-analyzed', url: 'https://cdn.example.com/image.jpg' }),
      rightsSnapshot: expect.objectContaining({ sourcePolicyVersion: 3, licenseStatus: 'permitted', llmInputScope: 'excerpt' }),
    })
    expect(article.publishedAt).toEqual(new Date('2026-08-10T12:00:00.000Z'))
    expect(article.retrievedAt).toEqual(RETRIEVED_AT)
    expect(article).not.toHaveProperty('rawHtml')
    expect(article).not.toHaveProperty('body')
    expect(article).not.toHaveProperty('fullText')
    expect(JSON.stringify(article)).not.toMatch(/ignore\(\)|base64|binary/i)

    const feedMedia = normalizeCandidateToArticle(makeCandidate({ mediaCandidate: { type: 'image', url: 'https://cdn.example.com/image.jpg', alt: 'A diagram', credit: 'Example' } }), { source: makeSource(), now: RETRIEVED_AT })
    expect(feedMedia.leadMedia).toMatchObject({ sourcePageUrl: article.canonicalUrl })
  })

  it('keeps metadata-only sources fail-closed for excerpt, summary input and blocked media', () => {
    const article = normalizeCandidateToArticle(makeCandidate({ mediaCandidate: { type: 'image', url: 'https://unreviewed.example/image.jpg', sourcePageUrl: 'https://example.com/articles/ai-systems' } }), {
      source: makeSource({ licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: false, embedding: false }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null } }),
      now: RETRIEVED_AT,
    })

    expect(article).not.toHaveProperty('excerptOriginal')
    expect(article.contentScope).toBe('metadata')
    expect(article.leadMedia).toBeNull()
    expect(article.leadMediaStatus).toBe('none')
    expect(article.summaryStatus).toBe('pending')
    expect(article.embeddingStatus).toBe('pending')
  })

  it('classifies topics when a connector does not provide explicit categories', () => {
    const article = normalizeCandidateToArticle(
      makeCandidate({
        titleOriginal: 'Cloud data infrastructure with Kubernetes',
        topics: [],
        excerptOriginal: 'A database pipeline improves analytics for teams.',
      }),
      { source: makeSource(), now: RETRIEVED_AT },
    )

    expect(article.topics).toEqual(['devops', 'dữ liệu'])
  })

  it('marks Hacker News community signal as unavailable for Q&A evidence', () => {
    const source = makeSource({ id: OTHER_SOURCE_ID, sourceKey: 'hn:topstories', connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } })
    const article = normalizeCandidateToArticle(makeCandidate({ sourceId: OTHER_SOURCE_ID, connectorType: 'hacker-news', authorityTier: 'community-signal', externalId: '42', originalUrl: 'https://news.ycombinator.com/item?id=42', provenance: { connectorType: 'hacker-news', sourceId: OTHER_SOURCE_ID, sourceKey: 'hn:topstories', externalId: '42', originalUrl: 'https://news.ycombinator.com/item?id=42', observedAt: RETRIEVED_AT } }), { source, now: RETRIEVED_AT })

    expect(article.authorityTier).toBe('community-signal')
    expect(article.evidenceEligible).toBe(false)
    expect(canUseQnaEvidence(article, source)).toBe(false)
    expect(() => normalizeCandidateToArticle(makeCandidate({ sourceId: OTHER_SOURCE_ID, connectorType: 'hacker-news', authorityTier: 'primary', externalId: '43', originalUrl: 'https://news.ycombinator.com/item?id=43', provenance: { sourceId: OTHER_SOURCE_ID, originalUrl: 'https://news.ycombinator.com/item?id=43', externalId: '43', observedAt: RETRIEVED_AT } }), { source: { ...source, authorityTier: 'primary' }, now: RETRIEVED_AT })).toThrowError(expect.objectContaining({ code: 'source_policy_blocked' }))
  })

  it('rejects candidates without required source/url/title/date invariants', () => {
    expect(() => normalizeCandidateToArticle(makeCandidate(), { source: makeSource({ id: undefined }), now: RETRIEVED_AT })).toThrow(ArticleError)
    for (const candidate of [
      makeCandidate({ originalUrl: 'http://example.com/article' }),
      makeCandidate({ titleOriginal: '<script>x</script>' }),
      makeCandidate({ publishedAt: 'not-a-date' }),
    ]) expect(() => normalizeCandidateToArticle(candidate, { source: makeSource(), now: RETRIEVED_AT })).toThrow(ArticleError)
    expect(() => normalizeCandidateToArticle(makeCandidate(), { source: makeSource({ technicalCheck: { status: 'failed' } }), now: RETRIEVED_AT })).toThrowError(expect.objectContaining({ code: 'source_policy_blocked' }))
  })
})
