import { describe, expect, it } from 'vitest'
import { currentArticleVisibilityFilter, qnaEvidenceFilter } from '../../../server/domain/article/visibility.js'

describe('article visibility predicates', () => {
  it('builds a current-source fail-closed published predicate', () => {
    expect(currentArticleVisibilityFilter({ sourcePath: '_currentSource' })).toEqual({
      status: 'published',
      '_currentSource.operationalStatus': 'active',
      '_currentSource.licenseStatus': { $in: ['permitted', 'metadata-only'] },
      '_currentSource.technicalCheck.status': 'passed',
    })
  })

  it('excludes community signal and requires current primary/editorial source for Q&A', () => {
    expect(qnaEvidenceFilter({ sourcePath: '_currentSource' })).toEqual({
      status: 'published',
      authorityTier: { $in: ['primary', 'editorial'] },
      evidenceEligible: true,
      '_currentSource.operationalStatus': 'active',
      '_currentSource.licenseStatus': { $in: ['permitted', 'metadata-only'] },
      '_currentSource.technicalCheck.status': 'passed',
      '_currentSource.authorityTier': { $in: ['primary', 'editorial'] },
    })
  })
})
