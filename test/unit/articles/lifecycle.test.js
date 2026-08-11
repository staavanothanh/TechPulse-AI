import { describe, expect, it } from 'vitest'
import { hideArticle, removeArticle, restoreArticle } from '../../../server/domain/article/lifecycle.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { makeCandidate, makeSource, RETRIEVED_AT } from './fixtures.js'

describe('article lifecycle safety', () => {
  it('hides and restores only through explicit safe transitions', () => {
    const article = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    const hidden = hideArticle(article, 'article_status_changed')
    expect(hidden).toMatchObject({ status: 'hidden', hiddenReason: 'article_status_changed', leadMediaStatus: 'hidden' })
    expect(restoreArticle(hidden, { source: makeSource(), now: RETRIEVED_AT })).toMatchObject({ status: 'published', leadMediaStatus: 'available' })
    expect(restoreArticle(hidden, { source: makeSource({ technicalCheck: { status: 'failed' } }), now: RETRIEVED_AT })).toMatchObject({ status: 'review-needed', leadMediaStatus: 'hidden' })
    expect(restoreArticle(hidden, { source: makeSource({ policyVersion: 4, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null } }), now: RETRIEVED_AT })).toMatchObject({ status: 'published', leadMediaStatus: 'hidden' })
  })

  it('removes all derived artifacts and source media metadata without retaining binary/full text', () => {
    const article = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    const removed = removeArticle({ ...article, summaryVi: 'generated summary', summaryStatus: 'ready', embedding: [0.1], embeddingStatus: 'ready', rawHtml: 'must not survive' }, { now: RETRIEVED_AT })
    expect(removed).toMatchObject({ status: 'removed', leadMedia: null, leadMediaStatus: 'none', summaryVi: null, summaryStatus: 'removed', embedding: null, embeddingStatus: 'removed' })
    expect(JSON.stringify(removed)).not.toContain('must not survive')
  })
})
