import { describe, expect, it, vi } from 'vitest'
import { createCurrentSourcePolicy } from '../../../server/application/sources/current-policy.js'

const active = { id: '507f1f77bcf86cd799439011', operationalStatus: 'active', licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false }, attributionText: 'Example', policyVersion: 4 }

describe('Current Source Policy lookup boundary', () => {
  it('reloads the source on every decision and returns the exact current policy version', async () => {
    const repository = { findSourceById: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce({ ...active, policyVersion: 5, licenseStatus: 'blocked', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false } }) }
    const policy = createCurrentSourcePolicy({ repository })
    expect(await policy.content({ sourceId: active.id, purpose: 'summary' })).toEqual(expect.objectContaining({ allowed: true, policyVersion: 4 }))
    expect(await policy.content({ sourceId: active.id, purpose: 'summary' })).toEqual(expect.objectContaining({ allowed: false, policyVersion: 5 }))
    expect(repository.findSourceById).toHaveBeenCalledTimes(2)
  })

  it('fails closed when current policy is missing or unavailable', async () => {
    const missing = createCurrentSourcePolicy({ repository: { findSourceById: vi.fn(async () => null) } })
    const unavailable = createCurrentSourcePolicy({ repository: { findSourceById: vi.fn(async () => { throw new Error('database unavailable') }) } })
    expect(await missing.content({ sourceId: active.id, purpose: 'embedding' })).toEqual({ allowed: false, code: 'source_policy_unavailable', purpose: 'embedding', policyVersion: null })
    expect(await unavailable.media({ sourceId: active.id, candidate: { type: 'image' } })).toEqual({ allowed: false, code: 'source_policy_unavailable', policyVersion: null })
  })
})
