import { describe, expect, it } from 'vitest'
import { mergeArticleRecords } from '../../../server/domain/article/dedupe.js'
import { makeCandidate, makeSource, RETRIEVED_AT } from '../articles/fixtures.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'

describe('article media merge guard', () => {
  it('does not attach incoming media through generic dedupe', () => {
    const source = makeSource()
    const canonical = normalizeCandidateToArticle(makeCandidate({ mediaCandidate: undefined }), { source, now: RETRIEVED_AT })
    const incoming = normalizeCandidateToArticle(makeCandidate(), { source, now: RETRIEVED_AT })

    const merged = mergeArticleRecords(canonical, incoming)

    expect(merged).toMatchObject({ leadMediaStatus: 'none', leadMedia: null })
  })

  it('does not copy media from a same-URL record owned by another source', () => {
    const canonical = normalizeCandidateToArticle(makeCandidate({ mediaCandidate: undefined }), { source: makeSource(), now: RETRIEVED_AT })
    const incoming = normalizeCandidateToArticle(makeCandidate({ sourceId: '507f1f77bcf86cd799439012' }), {
      source: makeSource({ id: '507f1f77bcf86cd799439012', sourceKey: 'rss:other' }),
      now: RETRIEVED_AT,
    })

    expect(mergeArticleRecords(canonical, incoming)).toMatchObject({ leadMedia: null, leadMediaStatus: 'none' })
  })
})
