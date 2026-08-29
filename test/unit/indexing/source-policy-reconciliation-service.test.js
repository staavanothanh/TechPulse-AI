import { describe, expect, it, vi } from 'vitest'
import { canonicalRequestHash } from '../../../server/domain/jobs/idempotency.js'
import { sourceAuditEventId } from '../../../server/audit/source-writer.js'

import { createSourcePolicyReconciliationService } from '../../../server/application/indexing/source-policy-reconciliation-service.js'
const SOURCE_ID = '507f1f77bcf86cd799439011'
const admin = { user: { id: '507f1f77bcf86cd799439001', role: 'admin', status: 'active' }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 1 } }
const result = { outcome: 'completed', sourceId: SOURCE_ID, inspected: 1, created: 1, hasMore: false }

function commitWithAdmission({ rateLimitAdmission, admission }) {
  return rateLimitAdmission.reserve(admission).then((result) => {
    if (!result || typeof result.allowed !== 'boolean') throw Object.assign(new Error('admission unavailable'), { status: 503, code: 'service_unavailable' })
    if (!result.allowed) throw Object.assign(new Error('admission denied'), { status: 429, code: 'rate_limit_exceeded' })
    return { replay: false }
  })
}

function fixture() {
  const worker = { run: vi.fn(async () => result) }
  const sourceRepository = { findSourceById: vi.fn(async () => ({ id: SOURCE_ID })), findReconciliationRequest: vi.fn(async () => null), commitReconciliationAudit: vi.fn(commitWithAdmission) }
  const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }
  return { worker, sourceRepository, rateLimitAdmission, service: createSourcePolicyReconciliationService({ worker, sourceRepository, rateLimitAdmission, now: () => new Date('2026-08-29T01:00:00.000Z') }) }
}

describe('source policy reconciliation service', () => {
  it('requires an active administrator for preview and execution', async () => {
    const { service } = fixture()
    await expect(service.preview({ sourceId: SOURCE_ID })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    await expect(service.execute({ auth: { user: { role: 'user', status: 'active' } }, sourceId: SOURCE_ID, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
  })

  it('returns 404 for a nonexistent source before any audit claim or admission', async () => {
    const { service, worker, sourceRepository, rateLimitAdmission } = fixture()
    sourceRepository.findSourceById.mockResolvedValue(null)

    await expect(service.preview({ auth: admin, sourceId: SOURCE_ID })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(service.execute({ auth: admin, sourceId: SOURCE_ID, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(rateLimitAdmission.reserve).not.toHaveBeenCalled()
    expect(sourceRepository.commitReconciliationAudit).not.toHaveBeenCalled()
    expect(worker.run).not.toHaveBeenCalled()
  })

  it('validates request contracts before admission and delegates bounded options', async () => {
    const { service, worker, sourceRepository, rateLimitAdmission } = fixture()
    await expect(service.execute({ auth: admin, sourceId: SOURCE_ID, reasonCode: 'wrong', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.execute({ auth: admin, sourceId: SOURCE_ID, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'bad' })).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    expect(rateLimitAdmission.reserve).not.toHaveBeenCalled()

    await service.preview({ auth: admin, sourceId: SOURCE_ID, limit: 2 })
    expect(worker.run).toHaveBeenCalledWith({ sourceId: SOURCE_ID, dryRun: true, limit: 2 })
    await service.execute({ auth: admin, sourceId: SOURCE_ID, limit: 2, maxPages: 3, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })
    expect(rateLimitAdmission.reserve).toHaveBeenCalledWith({ scope: 'admin-trigger', subject: admin.user.id })
    expect(worker.run).toHaveBeenLastCalledWith({ sourceId: SOURCE_ID, dryRun: false, limit: 2, maxPages: 3 })
    expect(sourceRepository.commitReconciliationAudit).toHaveBeenCalledWith(expect.objectContaining({ actorFence: expect.objectContaining({ userId: admin.user.id, sessionId: admin.session.id, sessionVersion: 1 }), audit: expect.objectContaining({ action: 'source_policy_reconciliation_requested', result: 'pending', changedFields: ['reconciliation'], reasonCode: 'source_policy_reconciliation_requested', requestId: 'reconciliation-key-1' }) }))
  })

  it('rejects a reused key with a different request intent and replays without mutation', async () => {
    const mismatch = fixture()
    mismatch.sourceRepository.findReconciliationRequest.mockResolvedValueOnce({ eventId: 'source:bound-to-another-intent' })
    await expect(mismatch.service.execute({ auth: admin, sourceId: SOURCE_ID, limit: 2, maxPages: 3, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    expect(mismatch.rateLimitAdmission.reserve).not.toHaveBeenCalled()
    expect(mismatch.worker.run).not.toHaveBeenCalled()

    const replay = fixture()
    const requestHash = canonicalRequestHash({ operation: 'source-policy-reconciliation', sourceId: SOURCE_ID, limit: 2, maxPages: 3, reasonCode: 'source_policy_reconciliation_requested' })
    const eventId = sourceAuditEventId('source_policy_reconciliation_requested', SOURCE_ID, 'reconciliation-key-1', admin.user.id, admin.session.id, requestHash)
    replay.sourceRepository.findReconciliationRequest.mockResolvedValueOnce({ eventId })
    replay.worker.run.mockResolvedValueOnce({ outcome: 'completed', sourceId: SOURCE_ID, inspected: 4, staleArticleCount: 4, wouldCreate: 4, created: 0, pages: 1, hasMore: true, jobs: [] })
    await expect(replay.service.execute({ auth: admin, sourceId: SOURCE_ID, limit: 2, maxPages: 3, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).resolves.toEqual(expect.objectContaining({ outcome: 'skipped', mode: 'execute', skippedReasons: ['idempotency_replay'], created: 0, jobs: [] }))
    expect(replay.rateLimitAdmission.reserve).not.toHaveBeenCalled()
    expect(replay.worker.run).toHaveBeenCalledWith({ sourceId: SOURCE_ID, dryRun: true, limit: 2 })
  })

  it('fails closed when admission is unavailable or denied', async () => {
    const worker = { run: vi.fn() }
    const sourceRepository = { findSourceById: vi.fn(async () => ({ id: SOURCE_ID })), findReconciliationRequest: vi.fn(async () => null), commitReconciliationAudit: vi.fn(commitWithAdmission) }
    const unavailable = createSourcePolicyReconciliationService({ worker, sourceRepository, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: 'yes' })) } })
    await expect(unavailable.execute({ auth: admin, sourceId: SOURCE_ID, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    const denied = createSourcePolicyReconciliationService({ worker, sourceRepository, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 30 })) } })
    await expect(denied.execute({ auth: admin, sourceId: SOURCE_ID, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'reconciliation-key-1' })).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded' })
    expect(worker.run).not.toHaveBeenCalled()
  })
})
