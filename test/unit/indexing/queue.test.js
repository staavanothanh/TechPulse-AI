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
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ job: candidate, fence: expect.objectContaining({ leaseGeneration: 2 }) }))
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
})
