import { describe, expect, it, vi } from 'vitest'
import { createReconciliationRunner } from '../../../server/application/indexing/reconciliation.js'
import { buildReconciliationJobs } from '../../../server/repositories/mongo/indexing-job-repository.js'

const SOURCE_ID = '507f1f77bcf86cd799439021'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const source = {
  id: SOURCE_ID, policyVersion: 4, operationalStatus: 'active', technicalCheck: { status: 'passed' }, licenseStatus: 'permitted', llmInputScope: 'metadata',
  storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
  mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
}

describe('Step 9 durable source reconciliation', () => {
  it('builds deterministic independent jobs only for current policy-allowed tasks', () => {
    const first = buildReconciliationJobs({ source, articleId: ARTICLE_ID, now: new Date('2026-08-10T00:00:00.000Z') })
    const replay = buildReconciliationJobs({ source, articleId: ARTICLE_ID, now: new Date('2026-08-10T00:05:00.000Z') })
    expect(first.map(({ task }) => task)).toEqual(['visibility-reconcile', 'summary', 'embedding'])
    expect(first.map(({ id }) => id)).toEqual(replay.map(({ id }) => id))
    expect(new Set(first.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(3)
    expect(first.find(({ task }) => task === 'embedding')?.targetEmbeddingVersion).toBe(1)

    const denied = buildReconciliationJobs({ source: { ...source, llmInputScope: 'none', storageScope: { ...source.storageScope, summary: false, embedding: false } }, articleId: ARTICLE_ID, now: new Date('2026-08-10T00:00:00.000Z') })
    expect(denied.map(({ task }) => task)).toEqual(['visibility-reconcile'])
  })

  it('uses the canonical source reconciliation lease and consumes bounded cursor pages', async () => {
    const repository = {
      selectPendingReconciliationSource: vi.fn()
        .mockResolvedValueOnce({ id: SOURCE_ID })
        .mockResolvedValueOnce({ id: SOURCE_ID })
        .mockResolvedValue(null),
      materializeReconciliationPage: vi.fn()
        .mockResolvedValueOnce({ inspected: 100, created: 300, hasMore: true })
        .mockResolvedValueOnce({ inspected: 1, created: 3, hasMore: false }),
    }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => true),
      acquire: vi.fn(async ({ key }) => ({ key, jobId: SOURCE_ID, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })),
      release: vi.fn(async () => true),
    }
    const runner = createReconciliationRunner({ repository, leaseRepository, ownerToken: () => 'source-owner-token', now: () => new Date('2026-08-10T00:00:00.000Z'), maxPages: 2 })
    await expect(runner.runDueSources()).resolves.toEqual({ inspected: 101, created: 303, pages: 2, hasMore: false, failed: 0 })
    expect(leaseRepository.acquire).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: `reconciliation:source:${SOURCE_ID}`, jobId: SOURCE_ID }))
    expect(repository.materializeReconciliationPage).toHaveBeenCalledTimes(2)
    expect(leaseRepository.release).toHaveBeenCalledTimes(2)
  })

  it('defers on a reconciliation lease conflict without retrying in the same run', async () => {
    const repository = {
      selectPendingReconciliationSource: vi.fn(async () => ({ id: SOURCE_ID, policyVersion: 4 })),
      materializeReconciliationPage: vi.fn(),
    }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => false),
      acquire: vi.fn(async () => { throw Object.assign(new Error('busy'), { status: 409, code: 'conflict' }) }),
      release: vi.fn(),
    }
    const runner = createReconciliationRunner({ repository, leaseRepository, ownerToken: () => 'source-owner-token', now: () => new Date('2026-08-10T00:00:00.000Z') })

    await expect(runner.runDueSources()).resolves.toEqual({ inspected: 0, created: 0, pages: 0, hasMore: true, failed: 0 })
    expect(repository.selectPendingReconciliationSource).toHaveBeenCalledOnce()
    expect(leaseRepository.acquire).toHaveBeenCalledOnce()
    expect(repository.materializeReconciliationPage).not.toHaveBeenCalled()
    expect(leaseRepository.release).not.toHaveBeenCalled()
  })
  it('does not mark a canceled page as failed before releasing its settled fence', async () => {
    let rejectPage
    const page = new Promise((_resolve, reject) => { rejectPage = reject })
    const repository = {
      selectPendingReconciliationSource: vi.fn(async () => ({ id: SOURCE_ID })),
      materializeReconciliationPage: vi.fn(async () => page),
      markReconciliationFailure: vi.fn(async () => true),
    }
    const fence = { key: `reconciliation:source:${SOURCE_ID}`, jobId: SOURCE_ID, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => true),
      acquire: vi.fn(async () => fence),
      release: vi.fn(async () => true),
    }
    const controller = new AbortController()
    const runner = createReconciliationRunner({
      repository,
      leaseRepository,
      ownerToken: () => 'source-owner-token',
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    const pending = runner.runDueSources({ signal: controller.signal, deadline: new Date('2026-08-10T00:00:01.000Z') })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(repository.materializeReconciliationPage).toHaveBeenCalledOnce()

    controller.abort()
    expect(leaseRepository.release).not.toHaveBeenCalled()
    rejectPage(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' }))

    await expect(pending).resolves.toMatchObject({ failed: 0 })
    expect(repository.markReconciliationFailure).not.toHaveBeenCalled()
    expect(leaseRepository.release).toHaveBeenCalledOnce()
  })
  it('passes runtime controls and releases the exact fence only after page settlement', async () => {
    const fence = { key: `reconciliation:source:${SOURCE_ID}`, jobId: SOURCE_ID, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 7 }
    let rejectPage
    let pageSettled = false
    const page = new Promise((_resolve, reject) => { rejectPage = reject })
    const repository = {
      selectPendingReconciliationSource: vi.fn(async () => ({ id: SOURCE_ID })),
      materializeReconciliationPage: vi.fn(async () => page),
      markReconciliationFailure: vi.fn(async () => true),
    }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => true),
      acquire: vi.fn(async () => fence),
      release: vi.fn(async (input) => {
        expect(pageSettled).toBe(true)
        return input.leaseGeneration === fence.leaseGeneration
      }),
    }
    const controller = new AbortController()
    const deadline = new Date('2026-08-10T00:00:01.000Z')
    const settlementDeadline = new Date('2026-08-10T00:00:02.000Z')
    const runner = createReconciliationRunner({
      repository,
      leaseRepository,
      ownerToken: () => 'source-owner-token',
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    const pending = runner.runDueSources({ signal: controller.signal, deadline, settlementDeadline })
    await vi.waitFor(() => expect(repository.materializeReconciliationPage).toHaveBeenCalledOnce())
    expect(repository.selectPendingReconciliationSource).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, deadline }))
    expect(leaseRepository.clearExpiredReconciliation).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, deadline }))
    expect(leaseRepository.acquire).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal, deadline }))
    expect(repository.materializeReconciliationPage).toHaveBeenCalledWith(expect.objectContaining({ fence, signal: controller.signal, deadline, settlementDeadline }))

    controller.abort()
    pageSettled = true
    rejectPage(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' }))
    await expect(pending).resolves.toMatchObject({ inspected: 0, created: 0, failed: 0 })
    expect(repository.markReconciliationFailure).not.toHaveBeenCalled()
    expect(leaseRepository.release).toHaveBeenCalledWith({ ...fence, ownerToken: 'source-owner-token', deadline })
  })
  it('fails closed when no cleanup budget remains and preserves successor fence acquisition', async () => {
    let current = new Date('2026-08-10T00:00:00.000Z')
    const deadline = new Date('2026-08-10T00:00:00.020Z')
    const settlementDeadline = new Date('2026-08-10T00:00:00.010Z')
    const expiresAt = new Date('2026-08-10T00:00:00.100Z')
    const firstFence = { key: `reconciliation:source:${SOURCE_ID}`, jobId: SOURCE_ID, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1, expiresAt }
    const successorFence = { ...firstFence, ownerTokenHash: 'b'.repeat(64), leaseGeneration: 2, expiresAt: new Date('2026-08-10T00:00:00.200Z') }
    let activeFence = firstFence
    const controller = new AbortController()
    const repository = {
      selectPendingReconciliationSource: vi.fn(async () => ({ id: SOURCE_ID })),
      materializeReconciliationPage: vi.fn(async () => {
        current = deadline
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' })
      }),
      markReconciliationFailure: vi.fn(),
    }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => true),
      acquire: vi.fn(async () => {
        if (activeFence && activeFence.expiresAt > current) return activeFence
        activeFence = successorFence
        return activeFence
      }),
      release: vi.fn(async (input) => {
        if (!activeFence || input.leaseGeneration !== activeFence.leaseGeneration || input.ownerTokenHash !== activeFence.ownerTokenHash) return false
        activeFence = null
        return true
      }),
    }
    const runner = createReconciliationRunner({ repository, leaseRepository, ownerToken: () => 'source-owner-token', now: () => current })

    await expect(runner.runDueSources({ signal: controller.signal, deadline, settlementDeadline })).resolves.toMatchObject({ failed: 0, hasMore: true })
    expect(leaseRepository.release).not.toHaveBeenCalled()
    expect(activeFence).toBe(firstFence)

    current = expiresAt
    await expect(leaseRepository.acquire({ key: firstFence.key, jobId: SOURCE_ID, ownerToken: 'successor-token' })).resolves.toEqual(successorFence)
    await expect(leaseRepository.release({ ...firstFence, ownerToken: 'source-owner-token' })).resolves.toBe(false)
    expect(activeFence).toBe(successorFence)
    expect(activeFence.leaseGeneration).toBe(2)
  })
  it('records a bounded exact-marker failure and lets a later invocation retry it', async () => {
    const repository = {
      selectPendingReconciliationSource: vi.fn(async () => ({ id: SOURCE_ID })),
      materializeReconciliationPage: vi.fn(async () => { throw Object.assign(new Error('temporary'), { code: 'temporary_failure', retryable: true }) }),
      markReconciliationFailure: vi.fn(async () => true),
    }
    const leaseRepository = {
      clearExpiredReconciliation: vi.fn(async () => true), acquire: vi.fn(async ({ key }) => ({ key, jobId: SOURCE_ID, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })), release: vi.fn(async () => true),
    }
    const runner = createReconciliationRunner({ repository, leaseRepository, ownerToken: () => 'source-owner-token', now: () => new Date('2026-08-10T00:00:00.000Z') })
    await expect(runner.runDueSources()).resolves.toMatchObject({ failed: 1, pages: 0, hasMore: false })
    expect(repository.selectPendingReconciliationSource).toHaveBeenCalledTimes(1)
    expect(repository.selectPendingReconciliationSource).toHaveBeenCalledWith(expect.objectContaining({ retryBackoffMs: expect.any(Number) }))
    expect(repository.materializeReconciliationPage).toHaveBeenCalledTimes(1)
    expect(repository.markReconciliationFailure).toHaveBeenCalledWith(expect.objectContaining({ sourceId: SOURCE_ID, fence: expect.any(Object), error: expect.objectContaining({ code: 'temporary_failure', retryable: true }) }))
  })
})
