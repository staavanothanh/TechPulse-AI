import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionQueueAdapter } from '../../../server/jobs/account-deletion-queue.js'

describe('Step 11 account deletion queue adapter', () => {
  it('executes every bounded cleanup proof before terminal completion', async () => {
    const repository = {
      selectDue: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'queued' })),
      claim: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'running', leaseGeneration: 1 })),
      deferClaimed: vi.fn(async () => true),
      applyCleanup: vi.fn(async () => ({
        sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true,
        answerAttemptsDeleted: true, userQuotaDataDeleted: true, identityAnonymized: true,
      })),
      complete: vi.fn(async () => true),
      fail: vi.fn(), recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })), nextAvailableAt: vi.fn(async () => null),
    }
    const adapter = createAccountDeletionQueueAdapter({ repository })
    const candidate = await adapter.selectDue({ now: new Date() })
    const result = await adapter.claimAndExecute({ candidate, now: new Date() })

    expect(result).toEqual({ claimed: true, status: 'succeeded' })
    expect(repository.applyCleanup).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ status: 'running' }) }))
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ completion: expect.objectContaining({ identityAnonymized: true, chatSessionsDeleted: true }) }))
    expect(repository.fail).not.toHaveBeenCalled()
  })
  it('defers when account deletion claim crosses the deadline', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-10T00:00:00.000Z')
      let signal
      const repository = {
        selectDue: vi.fn(),
        claim: vi.fn(({ signal: receivedSignal }) => {
          signal = receivedSignal
          return new Promise(() => {})
        }),
        deferClaimed: vi.fn(async () => true),
        applyCleanup: vi.fn(), complete: vi.fn(), fail: vi.fn(),
        recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
        nextAvailableAt: vi.fn(async () => null),
      }
      const adapter = createAccountDeletionQueueAdapter({ repository })
      const run = adapter.claimAndExecute({ candidate: { id: '507f1f77bcf86cd799439010' }, now, deadline: new Date(now.getTime() + 100) })

      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ claimed: false, status: 'deferred' })
      expect(signal.aborted).toBe(true)
      expect(repository.applyCleanup).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('defers a late account claim instead of leaving a running ownerless request', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-10T00:00:00.000Z')
      let resolveClaim
      const job = { id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'running', leaseGeneration: 1, leaseOwner: 'a'.repeat(64) }
      const repository = {
        selectDue: vi.fn(),
        claim: vi.fn(() => new Promise((resolve) => { resolveClaim = resolve })),
        deferClaimed: vi.fn(async () => true),
        applyCleanup: vi.fn(), complete: vi.fn(), fail: vi.fn(),
        recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
        nextAvailableAt: vi.fn(async () => null),
      }
      const adapter = createAccountDeletionQueueAdapter({ repository, ownerToken: () => 'a'.repeat(64) })
      const run = adapter.claimAndExecute({ candidate: { id: job.id }, now, deadline: new Date(now.getTime() + 100) })

      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ claimed: false, status: 'deferred' })
      resolveClaim(job)
      await vi.runAllTimersAsync()
      await Promise.resolve()
      expect(repository.deferClaimed).toHaveBeenCalledWith(expect.objectContaining({ job, ownerToken: 'a'.repeat(64) }))
      expect(repository.applyCleanup).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fenced-fails safely without claiming completion when one proof is missing', async () => {
    const repository = {
      claim: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'running', leaseGeneration: 1 })),
      deferClaimed: vi.fn(async () => true),
      applyCleanup: vi.fn(async () => ({ sessionsRevoked: true })), complete: vi.fn(), fail: vi.fn(async () => true),
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })), nextAvailableAt: vi.fn(async () => null), selectDue: vi.fn(),
    }
    const adapter = createAccountDeletionQueueAdapter({ repository })
    const result = await adapter.claimAndExecute({ candidate: { id: '507f1f77bcf86cd799439010' }, now: new Date() })
    expect(result).toEqual({ claimed: true, status: 'failed' })
    expect(repository.complete).not.toHaveBeenCalled()
    expect(repository.fail).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'cleanup_incomplete', retryable: true }) }))
  })
})
