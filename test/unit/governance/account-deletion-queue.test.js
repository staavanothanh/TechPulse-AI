import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionQueueAdapter } from '../../../server/jobs/account-deletion-queue.js'

describe('Step 11 account deletion queue adapter', () => {
  it('executes every bounded cleanup proof before terminal completion', async () => {
    const repository = {
      selectDue: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'queued' })),
      claim: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'running', leaseGeneration: 1 })),
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

  it('fenced-fails safely without claiming completion when one proof is missing', async () => {
    const repository = {
      claim: vi.fn(async () => ({ id: '507f1f77bcf86cd799439010', userId: '507f1f77bcf86cd799439011', status: 'running', leaseGeneration: 1 })),
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
