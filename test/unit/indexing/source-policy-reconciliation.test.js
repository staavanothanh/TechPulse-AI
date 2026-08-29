import { describe, expect, it, vi } from 'vitest'
import { createSourcePolicyReconciliationWorker } from '../../../server/application/indexing/source-policy-reconciliation.js'

const SOURCE_ID = '507f1f77bcf86cd799439011'
const source = {
  id: SOURCE_ID,
  sourceKey: 'demo:hn-topstories',
  operationalStatus: 'paused',
  policyVersion: 8,
  reconciliation: {
    status: 'pending',
    requiredPolicyVersion: 8,
    completedPolicyVersion: null,
    requestedAt: '2026-08-29T00:00:00.000Z',
    error: null,
  },
}
const NOW = new Date('2026-08-29T01:00:00.000Z')

function fixture({ preview = {}, pages = [] } = {}) {
  const sourceRepository = { findSourceById: vi.fn(async () => source) }
  let selectionCount = 0
  const indexingJobRepository = {
    previewReconciliationPage: vi.fn(async () => ({
      inspected: 3,
      wouldCreate: 3,
      wouldCreateJobs: [],
      hasMore: false,
      ...preview,
    })),
    selectPendingReconciliationSource: vi.fn(async ({ sourceId } = {}) => {
      if (sourceId !== SOURCE_ID || selectionCount > 0) return null
      selectionCount += 1
      return { id: SOURCE_ID, policyVersion: 8 }
    }),
    materializeReconciliationPage: vi.fn(async () => pages.shift() ?? { inspected: 3, created: 3, hasMore: false }),
    markReconciliationFailure: vi.fn(async () => true),
  }
  const leaseRepository = {
    clearExpiredReconciliation: vi.fn(async () => true),
    acquire: vi.fn(async ({ key, jobId }) => ({ key, jobId, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })),
    release: vi.fn(async () => true),
  }
  return { sourceRepository, indexingJobRepository, leaseRepository }
}

describe('source policy reconciliation worker', () => {
  it('keeps preview read-only and returns bounded exact job candidates', async () => {
    const jobs = [{
      id: '507f1f77bcf86cd799439099',
      idempotencyKey: `policy:${SOURCE_ID}:507f1f77bcf86cd799439021:visibility-reconcile:8`,
      actorScope: 'system-policy-reconciliation',
      articleId: '507f1f77bcf86cd799439021',
      sourceId: SOURCE_ID,
      expectedSourcePolicyVersion: 8,
      task: 'visibility-reconcile',
      trigger: 'policy-change',
      status: 'queued',
      priority: 75,
    }]
    const fixtureState = fixture({ preview: { inspected: 1, wouldCreate: 1, wouldCreateJobs: jobs } })
    const worker = createSourcePolicyReconciliationWorker({
      ...fixtureState,
      now: () => NOW,
      ownerToken: () => 'source-owner-token',
    })

    const result = await worker.run({ sourceId: SOURCE_ID, dryRun: true, limit: 1 })

    expect(result).toEqual(expect.objectContaining({
      outcome: 'completed',
      mode: 'dry-run',
      sourceId: SOURCE_ID,
      policyVersion: 8,
      inspected: 1,
      wouldCreate: 1,
      created: 0,
      hasMore: false,
      jobs,
    }))
    expect(JSON.stringify(result)).not.toMatch(/rightsSnapshot|fullText|rawHtml|providerPayload|secret|api[_-]?key|token/i)
    expect(fixtureState.indexingJobRepository.previewReconciliationPage).toHaveBeenCalledWith({ sourceId: SOURCE_ID, limit: 1, now: NOW, retryBackoffMs: expect.any(Number) })
    expect(fixtureState.indexingJobRepository.selectPendingReconciliationSource).not.toHaveBeenCalled()
    expect(fixtureState.indexingJobRepository.materializeReconciliationPage).not.toHaveBeenCalled()
    expect(fixtureState.leaseRepository.acquire).not.toHaveBeenCalled()
    expect(fixtureState.leaseRepository.release).not.toHaveBeenCalled()
  })

  it('executes only the selected source through the canonical runner', async () => {
    const fixtureState = fixture({ pages: [{ inspected: 2, created: 2, hasMore: false }] })
    fixtureState.sourceRepository.findSourceById
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, reconciliation: { ...source.reconciliation, status: 'completed', completedPolicyVersion: 8 } })
    const worker = createSourcePolicyReconciliationWorker({
      ...fixtureState,
      now: () => NOW,
      ownerToken: () => 'source-owner-token',
      maxPages: 3,
    })

    const result = await worker.run({ sourceId: SOURCE_ID, dryRun: false, limit: 2 })

    expect(result).toEqual(expect.objectContaining({
      outcome: 'completed',
      mode: 'execute',
      sourceId: SOURCE_ID,
      inspected: 2,
      created: 2,
      pages: 1,
      hasMore: false,
    }))
    expect(result.reconciliation).toEqual(expect.objectContaining({ status: 'completed', completedPolicyVersion: 8 }))
    expect(fixtureState.indexingJobRepository.selectPendingReconciliationSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_ID, retryBackoffMs: expect.any(Number), now: NOW }))
    expect(fixtureState.indexingJobRepository.materializeReconciliationPage).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_ID, limit: 2, now: NOW, fence: expect.any(Object) }))
    expect(fixtureState.leaseRepository.acquire).toHaveBeenCalledWith(expect.objectContaining({ key: `reconciliation:source:${SOURCE_ID}`, jobId: SOURCE_ID }))
    expect(fixtureState.leaseRepository.release).toHaveBeenCalledOnce()
  })

  it('skips missing or archived sources without acquiring a lease', async () => {
    const fixtureState = fixture()
    fixtureState.sourceRepository.findSourceById.mockResolvedValueOnce(null)
    const worker = createSourcePolicyReconciliationWorker(fixtureState)
    await expect(worker.run({ sourceId: SOURCE_ID, dryRun: false })).resolves.toEqual(expect.objectContaining({ outcome: 'skipped', skippedReasons: ['source_not_found'] }))
    expect(fixtureState.leaseRepository.acquire).not.toHaveBeenCalled()

    fixtureState.sourceRepository.findSourceById.mockResolvedValueOnce({ ...source, operationalStatus: 'archived' })
    await expect(worker.run({ sourceId: SOURCE_ID, dryRun: true })).resolves.toEqual(expect.objectContaining({ outcome: 'skipped', skippedReasons: ['source_archived'] }))
    expect(fixtureState.indexingJobRepository.previewReconciliationPage).not.toHaveBeenCalled()
  })
  it('propagates marker conflicts instead of recording a false success', async () => {
    const fixtureState = fixture()
    fixtureState.indexingJobRepository.materializeReconciliationPage.mockRejectedValueOnce(Object.assign(new Error('marker changed'), { status: 409, code: 'conflict' }))
    fixtureState.indexingJobRepository.markReconciliationFailure.mockResolvedValueOnce(false)
    const worker = createSourcePolicyReconciliationWorker({ ...fixtureState, now: () => NOW, ownerToken: () => 'source-owner-token' })

    await expect(worker.run({ sourceId: SOURCE_ID, dryRun: false })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(fixtureState.leaseRepository.release).toHaveBeenCalledOnce()
  })
})
