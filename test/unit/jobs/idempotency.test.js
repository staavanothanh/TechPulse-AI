import { describe, expect, it } from 'vitest'
import { JobError, actorScopeForAdmin, canonicalRequestHash, resolveIdempotentJob } from '../../../server/domain/jobs/idempotency.js'

describe('durable job idempotency', () => {
  it('hashes canonical request objects independent of property order', () => {
    expect(canonicalRequestHash({ sourceId: 'source_1', batchSize: 20 })).toBe(canonicalRequestHash({ batchSize: 20, sourceId: 'source_1' }))
  })

  it('scopes manual keys to exact actor and session', () => {
    expect(actorScopeForAdmin({ user: { id: 'user_1' }, session: { _id: 'session_1', userSessionVersion: 3 } })).toBe('admin:user_1:session:session_1:v3')
  })

  it('reuses same logical result and rejects a different intent', () => {
    const existing = { requestHash: canonicalRequestHash({ sourceId: 'source_1' }) }
    expect(resolveIdempotentJob(existing, existing.requestHash)).toBe(existing)
    expect(() => resolveIdempotentJob(existing, canonicalRequestHash({ sourceId: 'source_2' }))).toThrow(JobError)
    try { resolveIdempotentJob(existing, 'different') } catch (error) { expect(error.code).toBe('idempotency_mismatch'); expect(error.status).toBe(409) }
  })
})
