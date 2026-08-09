import { describe, expect, it } from 'vitest'
import { MongoAuthRepository } from '../../server/repositories/mongo/auth-repository.js'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'

describe('rate-limit duplicate-key recovery', () => {
  it('retries a first-window duplicate-key race and reserves the remaining quota', async () => {
    const keyring = createHmacKeyring({ currentEnv: 'CURRENT', currentVersion: 1, values: { CURRENT: 'c'.repeat(32) } })
    const now = new Date('2026-08-09T10:00:00.000Z')
    const windowStart = new Date('2026-08-09T10:00:00.000Z')
    let writes = 0
    let bucket
    const collection = {
      find: () => ({ toArray: async () => [] }),
      findOne: async () => bucket,
      findOneAndUpdate: async () => {
        writes += 1
        if (writes === 1) {
          bucket = { keyVersion: 1, keyFingerprint: keyring.fingerprint(1), count: 1, limit: 10, windowStart }
          const error = new Error('duplicate key')
          error.code = 11000
          throw error
        }
        bucket = { keyVersion: 1, keyFingerprint: keyring.fingerprint(1), count: 2, limit: 10, windowStart }
        return bucket
      },
    }
    const repository = {
      collection: () => collection,
      withTransaction: async (work) => work(undefined),
    }

    const result = await MongoAuthRepository.prototype.reserveRateLimit.call(repository, {
      scope: 'login', subjectType: 'ip', keyHash: 'a'.repeat(64), keyVersion: 1, keyring, now,
    })

    expect(result).toMatchObject({ allowed: true, count: 2 })
    expect(writes).toBe(2)
  })
})
