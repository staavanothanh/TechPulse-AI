import { describe, expect, it } from 'vitest'
import { assessDedupe, mergeArticleRecords, mergeProvenance } from '../../../server/domain/article/dedupe.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { makeCandidate, makeSource, OTHER_SOURCE_ID, RETRIEVED_AT, SOURCE_ID } from './fixtures.js'

describe('article dedupe and provenance', () => {
  it('uses stable source/external or canonical-url identity and unions provenance deterministically', () => {
    const first = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    const second = normalizeCandidateToArticle(makeCandidate({ sourceId: OTHER_SOURCE_ID, connectorType: 'arxiv', authorityTier: 'primary', externalId: 'other-item', provenance: { connectorType: 'arxiv', sourceId: OTHER_SOURCE_ID, sourceKey: 'arxiv:ai', externalId: 'other-item', originalUrl: first.originalUrl, observedAt: new Date(RETRIEVED_AT.getTime() + 1000) } }), {
      source: makeSource({ id: OTHER_SOURCE_ID, sourceKey: 'arxiv:ai', connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 20 } }),
      now: RETRIEVED_AT,
    })
    const merged = mergeArticleRecords(first, second)

    expect(assessDedupe(first, second)).toMatchObject({ decision: 'duplicate', dedupeKey: first.dedupeKey })
    expect(merged.provenance).toHaveLength(2)
    expect(mergeProvenance(first.provenance, second.provenance)).toEqual(merged.provenance)
    expect(merged.provenance.map(({ sourceId }) => sourceId)).toEqual([SOURCE_ID, OTHER_SOURCE_ID])
  })

  it('sends near-title candidates with different canonical URLs to review-needed instead of auto-merging', () => {
    const first = normalizeCandidateToArticle(makeCandidate({ externalId: 'one', originalUrl: 'https://example.com/one' }), { source: makeSource(), now: RETRIEVED_AT })
    const second = normalizeCandidateToArticle(makeCandidate({ externalId: 'two', originalUrl: 'https://example.com/two', titleOriginal: 'AI systems and safety' }), { source: makeSource(), now: RETRIEVED_AT })

    expect(assessDedupe(first, second)).toMatchObject({ decision: 'review-needed', reason: 'near-title-different-url' })
    expect(mergeArticleRecords(first, second).status).toBe('review-needed')
  })

  it('does not persist untrusted full text or binary fields during a provenance union', () => {
    const first = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    const second = { ...first, rawHtml: '<article>secret</article>', body: 'secret', mediaBinary: Buffer.from('secret') }
    const merged = mergeArticleRecords(first, second)

    expect(merged).not.toHaveProperty('rawHtml')
    expect(merged).not.toHaveProperty('body')
    expect(merged).not.toHaveProperty('mediaBinary')
    expect(JSON.stringify(merged)).not.toContain('secret')
  })
})
