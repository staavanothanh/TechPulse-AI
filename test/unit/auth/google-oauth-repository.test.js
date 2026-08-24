import { describe, expect, it, vi } from 'vitest'
import { MongoAuthRepository } from '../../../server/repositories/mongo/auth-repository.js'

describe('Google OAuth repository identity persistence', () => {
  it('persists and queries the bounded Google subject', async () => {
    const users = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ _id: 'user-1', googleSub: 'google-sub-1' })),
    }
    const repository = new MongoAuthRepository({ db: { collection: (name) => name === 'users' ? users : {} }, client: {} })

    await repository.createUser({ emailNormalized: 'user@gmail.com', emailDisplay: 'user@gmail.com', passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64), googleSub: 'google-sub-1' })
    expect(users.insertOne).toHaveBeenCalledWith(expect.objectContaining({ googleSub: 'google-sub-1' }), {})
    await expect(repository.findUserByGoogleSub('google-sub-1')).resolves.toEqual(expect.objectContaining({ googleSub: 'google-sub-1' }))
    expect(users.findOne).toHaveBeenCalledWith({ googleSub: 'google-sub-1' }, {})
  })
})
