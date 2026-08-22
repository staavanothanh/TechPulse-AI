import { describe, expect, it, vi } from 'vitest'
import { createIndexingQueueAdapter } from '../../../server/jobs/indexing-queue.js'

const candidate = { id: '507f1f77bcf86cd799439041', articleId: '507f1f77bcf86cd799439011', task: 'summary' }

describe('Step 9 indexing queue adapter', () => {
  it('claims the canonical article lease and completes one task independently', async () => {
    const jobRepository = {
      selectDueIndexing: vi.fn(async () => candidate), recoverExpiredIndexing: vi.fn(), nextAvailableAt: vi.fn(),
      claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => true), deferWithFence: vi.fn(),
    }
    const leaseRepository = { acquire: vi.fn(async ({ key }) => ({ key, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 })), release: vi.fn() }
    const executor = vi.fn(async () => ({ status: 'succeeded', inputHash: 'b'.repeat(64) }))
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })
    const result = await adapter.claimAndExecute({ candidate, now: new Date('2026-08-10T00:00:00.000Z') })
    expect(leaseRepository.acquire).toHaveBeenCalledWith(expect.objectContaining({ key: `indexing:article:${candidate.articleId}`, jobId: candidate.id }))
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ job: { ...candidate, leaseGeneration: 2 }, fence: expect.objectContaining({ leaseGeneration: 2 }) }))
    expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded', inputHash: 'b'.repeat(64) }))
    expect(result).toEqual({ status: 'succeeded', claimed: true })
  })

  it('defers safely when no executor exists and never completes another task array', async () => {
    const jobRepository = { selectDueIndexing: vi.fn(), recoverExpiredIndexing: vi.fn(), nextAvailableAt: vi.fn(), claimQueuedWithFence: vi.fn(async () => true), deferWithFence: vi.fn(async () => ({ status: 'queued' })), completeWithFence: vi.fn() }
    const leaseRepository = { acquire: vi.fn(async () => ({ key: `indexing:article:${candidate.articleId}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })), release: vi.fn() }
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, ownerToken: () => 'owner-token-value' })
    await expect(adapter.claimAndExecute({ candidate })).resolves.toEqual({ status: 'deferred', claimed: true })
    expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
  })

  it('marks a stale lease outcome retryable for safe recovery', async () => {
    const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const executor = vi.fn(async () => { throw Object.assign(new Error('stale fence'), { code: 'lease_fence_stale', retryable: false }) })
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })

    await expect(adapter.claimAndExecute({ candidate })).resolves.toEqual({ status: 'failed', claimed: true })
    expect(jobRepository.completeWithFence.mock.calls[0][0].error).toMatchObject({ code: 'lease_fence_stale', retryable: true })
  })

  it('renews an active lease during long indexing work and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => true) }
      let finish
      const executor = vi.fn(() => new Promise((resolve) => { finish = resolve }))
      const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 1000, ownerToken: () => 'owner-token-value' })
      const run = adapter.claimAndExecute({ candidate })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledWith({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken: 'owner-token-value', leaseMs: 1000 })
      finish({ status: 'succeeded', inputHash: 'b'.repeat(64) })
      await expect(run).resolves.toEqual({ status: 'succeeded', claimed: true })
      const calls = leaseRepository.heartbeat.mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
