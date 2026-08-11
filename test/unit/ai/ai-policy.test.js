import { describe, expect, it } from 'vitest'
import { buildPolicyDerivedInput } from '../../../server/ai/policy-input.js'

describe('Step 9 ai-policy focused gate', () => {
  it('fails closed when AI storage is outside current policy', () => {
    const source = {
      id: '507f1f77bcf86cd799439021', name: 'Source', policyVersion: 1, operationalStatus: 'active', technicalCheck: { status: 'passed' },
      licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
    }
    expect(() => buildPolicyDerivedInput({ article: { sourceId: source.id, titleOriginal: 'Article' }, source, purpose: 'summary' })).toThrow(/policy/i)
  })
})
