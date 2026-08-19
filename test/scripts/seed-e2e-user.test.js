import { describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../../server/security/password.js'
import {
  buildE2eUserInput,
  parseSeedMode,
  seedE2eUser,
} from '../../scripts/seed-e2e-user.js'

const email = 'deletion-e2e@example.com'
const password = 'disposable-e2e-password'

function repository({ existing } = {}) {
  const user = existing ?? null
  return {
    findUserByEmail: vi.fn(async () => user),
    withTransaction: vi.fn(async (work) => work('session')),
    createUser: vi.fn(async (input) => ({ ...input })),
    insertAudit: vi.fn(async (document) => document),
  }
}

describe('seed-e2e-user', () => {
  it('requires an explicit apply flag', () => {
    expect(parseSeedMode([])).toEqual({ apply: false })
    expect(parseSeedMode(['--apply'])).toEqual({ apply: true })
    expect(() => parseSeedMode(['--force'])).toThrow(/unknown/i)
  })

  it('accepts only reserved disposable email domains', () => {
    expect(buildE2eUserInput({ email, password })).toMatchObject({
      emailNormalized: email,
      emailDisplay: email,
      password,
    })
    expect(() => buildE2eUserInput({ email: 'real@gmail.com', password })).toThrow(/disposable/i)
  })

  it('does not touch the repository during dry-run', async () => {
    const repo = repository()
    const result = await seedE2eUser({ repository: repo, email, password, apply: false })
    expect(result).toEqual({ dryRun: true, eligible: true })
    expect(repo.findUserByEmail).not.toHaveBeenCalled()
    expect(repo.withTransaction).not.toHaveBeenCalled()
  })

  it('creates an active user and a registration audit on apply', async () => {
    const repo = repository()
    const result = await seedE2eUser({ repository: repo, email, password, apply: true })
    expect(result).toEqual({ seeded: true, existing: false })
    expect(repo.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailNormalized: email,
        role: 'user',
        status: 'active',
        topicPreferences: [],
        sessionVersion: 0,
      }),
      { session: 'session' },
    )
    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user_registered',
        actorType: 'user',
        targetType: 'user',
        result: 'succeeded',
      }),
      { session: 'session' },
    )
  })

  it('is idempotent for an active user with the same password', async () => {
    const existing = {
      _id: '507f1f77bcf86cd799439011',
      emailNormalized: email,
      emailDisplay: email,
      passwordHash: await hashPassword(password),
      role: 'user',
      status: 'active',
    }
    const repo = repository({ existing })
    const result = await seedE2eUser({ repository: repo, email, password, apply: true })
    expect(result).toEqual({ seeded: false, existing: true })
    expect(repo.createUser).not.toHaveBeenCalled()
    expect(repo.insertAudit).not.toHaveBeenCalled()
  })

  it('fails closed for a wrong password or non-user account', async () => {
    const passwordHash = await hashPassword(password)
    await expect(
      seedE2eUser({
        repository: repository({
          existing: {
            _id: '507f1f77bcf86cd799439011',
            emailNormalized: email,
            passwordHash,
            role: 'user',
            status: 'active',
          },
        }),
        email,
        password: 'different-disposable-password',
        apply: true,
      }),
    ).rejects.toThrow(/password/i)
    await expect(
      seedE2eUser({
        repository: repository({
          existing: {
            _id: '507f1f77bcf86cd799439011',
            emailNormalized: email,
            passwordHash,
            role: 'admin',
            status: 'active',
          },
        }),
        email,
        password,
        apply: true,
      }),
    ).rejects.toThrow(/user account/i)
  })
})
