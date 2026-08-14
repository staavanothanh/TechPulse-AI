import { describe, expect, it, vi } from 'vitest'
import { createAccountDeletionService } from '../../server/application/account-deletion/service.js'

describe('Step 11 session revocation integration', () => {
  it('discards an account-deletion request when the exact session fence is revoked', async () => {
    const repository = {
      withTransaction: async (work) => work({ transaction: 'step11' }),
      assertActiveSessionForUser: vi.fn(async () => false),
      findByUserId: vi.fn(),
      markUserDeletionPending: vi.fn(),
      create: vi.fn(),
      insertAudit: vi.fn(),
    }
    const service = createAccountDeletionService({ repository })

    await expect(service.request({
      auth: { user: { _id: '507f1f77bcf86cd799439010', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 9 } },
      idempotencyKey: 'step11-deletion-revoked-session',
      request: { serverRequestId: 'step11-revoked-request' },
    })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })

    expect(repository.findByUserId).not.toHaveBeenCalled()
    expect(repository.markUserDeletionPending).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
    expect(repository.insertAudit).not.toHaveBeenCalled()
  })
})
