import { describe, expect, it, vi } from 'vitest'
import { createRateLimitAdmission } from '../../../server/security/rate-limit-admission.js'

describe('job rate-limit admission', () => {
  it('forwards a caller transaction session so job admission and persistence share one atomic boundary', async () => {
    const repository = { reserveRateLimit: vi.fn(async () => ({ allowed: true })) }
    const keyring = {
      currentVersion: 7,
      versions: [7],
      digest: (subject, version = 7) => `${version}:${subject}`,
    }
    const admission = createRateLimitAdmission({ repository, keyring, clock: () => new Date('2026-08-10T00:00:00.000Z') })
    const session = { id: 'transaction-session' }
    await expect(admission.reserve({ scope: 'admin-trigger', subject: '507f1f77bcf86cd799439011', session })).resolves.toEqual({ allowed: true })
    expect(repository.reserveRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'admin-trigger', subjectType: 'admin', keyVersion: 7, keyHash: '7:507f1f77bcf86cd799439011',
    }), { session })
  })
})
