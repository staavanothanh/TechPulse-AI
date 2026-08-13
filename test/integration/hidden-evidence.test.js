import { describe, expect, it } from 'vitest'
import { filterQnaEvidence } from '../../server/domain/qa/evidence.js'

describe('hidden evidence integration boundary', () => {
  it('fails closed when current article lifecycle is hidden or source policy is stale', () => {
    const source = { id: 'source-1', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 2, llmInputScope: 'excerpt', technicalCheck: { status: 'passed' } }
    const base = { id: 'article-1', sourceId: 'source-1', status: 'published', evidenceEligible: true, rightsSnapshot: { sourcePolicyVersion: 2, licenseStatus: 'permitted', llmInputScope: 'excerpt' } }
    expect(() => filterQnaEvidence([{ article: { ...base, status: 'hidden' }, source }])).toThrow(/evidence/i)
    expect(() => filterQnaEvidence([{ article: { ...base, rightsSnapshot: { ...base.rightsSnapshot, sourcePolicyVersion: 1 } }, source }])).toThrow(/evidence/i)
  })
})
