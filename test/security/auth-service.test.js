import { describe, expect, it, vi } from 'vitest'
import { createAuthService } from '../../server/application/auth/service.js'
import { createHmacKeyring, validateRetiringKey } from '../../server/security/hmac-keyring.js'
import { hashCsrfToken } from '../../server/security/session-token.js'
import { hashPassword } from '../../server/security/password.js'

const user = {
  _id: 'user-1', emailNormalized: 'user@example.com', emailDisplay: 'user@example.com', role: 'user', status: 'active', topicPreferences: [], sessionVersion: 0, createdAt: new Date('2026-08-09T00:00:00.000Z'), updatedAt: new Date('2026-08-09T00:00:00.000Z'),
}

function keyring() {
  return createHmacKeyring({ currentEnv: 'CURRENT', retiringEnvs: ['OLD'], currentVersion: 10, retiringVersions: [8], values: { CURRENT: 'c'.repeat(32), OLD: 'o'.repeat(32) } })
}

function request() {
  return { testClientIp: '203.0.113.10', requestId: 'request-1', get: vi.fn(() => 'TechPulseTest/1.0') }
}

describe('Step 2 auth application service', () => {
  it('reserves register quota before reading, hashing or writing account data', async () => {
    const repository = { reserveRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 42 })), findUserByEmail: vi.fn(), createUser: vi.fn() }
    const service = createAuthService({ repository, quotaKeyring: keyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    await expect(service.register({ email: 'user@example.com', password: 'long-enough-password', request: request() })).rejects.toMatchObject({ status: 429, retryAfter: 42 })
    expect(repository.findUserByEmail).not.toHaveBeenCalled()
    expect(repository.createUser).not.toHaveBeenCalled()
  })

  it('fails closed for stale session version and suspended users', async () => {
    const repository = {
      findSessionByTokenHash: vi.fn(async () => ({ _id: 'session-1', userId: 'user-1', userSessionVersion: 0, expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) })),
      findUserById: vi.fn(async () => ({ ...user, status: 'suspended', sessionVersion: 1 })),
    }
    const service = createAuthService({ repository, quotaKeyring: keyring() })
    await expect(service.authenticate({ token: 'opaque-session-token-1234' })).rejects.toMatchObject({ status: 401 })
  })

  it('exposes HMAC versions but rejects unknown or retired versions', () => {
    const ring = keyring()
    expect(ring.acceptsVersion(10)).toBe(true)
    expect(ring.acceptsVersion(8)).toBe(true)
    expect(ring.acceptsVersion(3)).toBe(false)
    expect(() => ring.digest('scope', 3)).toThrow(/unknown or retired/)
    expect(validateRetiringKey({ retiringSince: new Date('2026-07-01T00:00:00.000Z'), dependentCount: 0, now: new Date('2026-08-09T00:00:00.000Z') }).eligible).toBe(true)
    expect(validateRetiringKey({ retiringSince: new Date('2026-07-01T00:00:00.000Z'), dependentCount: 1, now: new Date('2026-08-09T00:00:00.000Z') }).eligible).toBe(false)
  })

  it('returns one stable in-memory CSRF token for concurrent current-user bootstraps', async () => {
    const token = 'opaque-session-token-1234'
    const repository = {
      findSessionByTokenHash: vi.fn(async () => ({ _id: 'session-1', userId: 'user-1', userSessionVersion: 0, csrfSecretHash: hashCsrfToken('old-csrf-token-long-enough'), expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) })),
      findUserById: vi.fn(async () => user),
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      touchSession: vi.fn(async () => ({ _id: 'session-1' })),
    }
    const service = createAuthService({ repository })

    const [first, second] = await Promise.all([
      service.currentUser({ token }),
      service.currentUser({ token }),
    ])

    expect(first.csrfToken).toBe(second.csrfToken)
  })

  it('keeps admin status mutation and audit in one repository transaction', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      assertActiveSessionForUser: vi.fn(async () => true),
      reserveRateLimit: vi.fn(async () => ({ allowed: true })),
      updateUserStatus: vi.fn(async () => ({ ...user, role: 'user', status: 'suspended', sessionVersion: 1 })),
      revokeSessionsByUserId: vi.fn(async () => undefined),
      insertAudit: vi.fn(async () => undefined),
    }
    const service = createAuthService({ repository, quotaKeyring: keyring() })
    const admin = { ...user, _id: '507f1f77bcf86cd799439010', role: 'admin' }
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: admin, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) } }
    const targetUserId = '507f1f77bcf86cd799439011'
    const result = await service.updateUserStatus({ auth, userId: targetUserId, status: 'suspended', reasonCode: 'user_suspended', csrfToken })
    expect(result.status).toBe('suspended')
    expect(repository.updateUserStatus).toHaveBeenCalledWith(targetUserId, 'suspended', 'user_suspended', { session: 'mongo-session' })
    expect(repository.revokeSessionsByUserId).toHaveBeenCalledWith(targetUserId, { session: 'mongo-session' })
    expect(repository.insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user_suspended' }), { session: 'mongo-session' })
    expect(repository.assertActiveSessionForUser).toHaveBeenCalledWith(expect.objectContaining({ sessionVersion: 0, role: 'admin' }), { session: 'mongo-session' })
    expect(repository.reserveRateLimit).toHaveBeenCalledWith(expect.objectContaining({ scope: 'admin-trigger', subjectType: 'admin' }), { session: 'mongo-session' })
  })

  it('does not require the admin role when a normal user logs out', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      assertActiveSessionForUser: vi.fn(async () => true),
      revokeSession: vi.fn(async () => undefined),
      insertAudit: vi.fn(async () => undefined),
    }
    const service = createAuthService({ repository })
    const csrfToken = 'csrf-token-for-user-1234567890'
    const auth = { user: { ...user, _id: '507f1f77bcf86cd799439010' }, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) } }

    await service.logout({ auth, csrfToken })

    expect(repository.assertActiveSessionForUser).toHaveBeenCalledWith({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: 0 }, { session: 'mongo-session' })
  })

  it('rejects an admin user mutation when transactional admission is denied', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      assertActiveSessionForUser: vi.fn(async () => true),
      reserveRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 12 })),
      updateUserStatus: vi.fn(),
    }
    const service = createAuthService({ repository, quotaKeyring: { currentVersion: 1, versions: [1], digest: () => 'a'.repeat(64) } })
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: { ...user, _id: '507f1f77bcf86cd799439010', role: 'admin' }, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) } }
    await expect(service.updateUserStatus({ auth, userId: '507f1f77bcf86cd799439011', status: 'suspended', reasonCode: 'user_suspended', csrfToken })).rejects.toMatchObject({ status: 429, retryAfter: 12 })
    expect(repository.updateUserStatus).not.toHaveBeenCalled()
  })

  it('maps an admin admission outage to canonical service unavailable', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      assertActiveSessionForUser: vi.fn(async () => true),
      updateUserStatus: vi.fn(),
    }
    const service = createAuthService({ repository, rateLimitAdmission: { reserve: vi.fn(async () => { throw new Error('private limiter diagnostic') }) } })
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: { ...user, _id: '507f1f77bcf86cd799439010', role: 'admin' }, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) } }

    await expect(service.updateUserStatus({ auth, userId: '507f1f77bcf86cd799439011', status: 'suspended', reasonCode: 'user_suspended', csrfToken })).rejects.toMatchObject({ status: 503, code: 'service_unavailable', message: 'Admin admission is unavailable' })
    expect(repository.updateUserStatus).not.toHaveBeenCalled()
  })

  it('does not create a conflicting audit identity when a privileged transition does not commit', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      assertActiveSessionForUser: vi.fn(async () => true),
      reserveRateLimit: vi.fn(async () => ({ allowed: true })),
      updateUserStatus: vi.fn(async () => ({ conflict: true })),
      insertAudit: vi.fn(async () => undefined),
    }
    const service = createAuthService({ repository, quotaKeyring: keyring() })
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: { ...user, _id: '507f1f77bcf86cd799439010', role: 'admin' }, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) } }
    const targetUserId = '507f1f77bcf86cd799439011'

    await expect(service.updateUserStatus({ auth, userId: targetUserId, status: 'suspended', reasonCode: 'user_suspended', csrfToken })).rejects.toMatchObject({ status: 409 })
    expect(repository.insertAudit).not.toHaveBeenCalled()
  })

  it('maps a malformed admin target identifier to canonical not-found without invoking Mongo', async () => {
    const repository = { findUserById: vi.fn(async () => { throw new Error('invalid opaque identifier') }) }
    const service = createAuthService({ repository })
    const auth = { user: { ...user, _id: 'admin-1', role: 'admin' }, session: { _id: 'session-1', userSessionVersion: 0 } }

    await expect(service.getAdminUser({ auth, userId: 'not-a-mongo-id' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(repository.findUserById).not.toHaveBeenCalled()
  })

  it('maps a malformed admin transition target to canonical not-found before a Mongo mutation', async () => {
    const repository = { updateUserStatus: vi.fn() }
    const service = createAuthService({ repository })
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: { ...user, _id: 'admin-1', role: 'admin' }, session: { csrfSecretHash: hashCsrfToken(csrfToken) } }

    await expect(service.updateUserStatus({ auth, userId: 'not-a-mongo-id', status: 'suspended', reasonCode: 'user_suspended', csrfToken })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(repository.updateUserStatus).not.toHaveBeenCalled()
  })

  it('denies non-admin access to admin user reads', async () => {
    const service = createAuthService({ repository: { listUsers: vi.fn() } })
    await expect(service.listAdminUsers({ auth: { user } })).rejects.toMatchObject({ status: 403 })
  })

  it('bounds and forwards admin list query pagination', async () => {
    const repository = { listUsers: vi.fn(async () => []) }
    const service = createAuthService({ repository })
    const admin = { ...user, _id: '507f1f77bcf86cd799439011', role: 'admin' }
    await service.listAdminUsers({ auth: { user: admin, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0 } }, query: { limit: '2', status: 'active', email: 'user@example.com' } })
    expect(repository.listUsers).toHaveBeenCalledWith({ limit: 3, status: 'active', emailNormalized: 'user@example.com', cursor: undefined })
    await expect(service.listAdminUsers({ auth: { user: admin, session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 0 } }, query: { limit: '1000' } })).rejects.toMatchObject({ status: 422 })
  })
})

describe('change password', () => {
  const currentPassword = 'correct-horse-battery'
  const newPassword = 'brand-new-password-1'
  const csrfToken = 'csrf-token-for-user-1234567890'

  function repositoryFor(updatedUser) {
    return {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      reserveRateLimit: vi.fn(async () => ({ allowed: true })),
      assertActiveSessionForUser: vi.fn(async () => true),
      updatePassword: vi.fn(async () => updatedUser),
      revokeSessionsByUserId: vi.fn(async () => undefined),
      createSession: vi.fn(async () => undefined),
      insertAudit: vi.fn(async () => undefined),
    }
  }
  function serviceFor(repository) {
    return createAuthService({ repository, quotaKeyring: keyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
  }
  it('rejects wrong-password attempts at the password-change quota before scrypt and without echoing secrets', async () => {
    const repository = repositoryFor(null)
    repository.reserveRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 })
    const service = serviceFor(repository)
    const currentSecret = 'current-secret-not-echoed'
    const newSecret = 'new-secret-not-echoed'

    await expect(service.changePassword({
      auth: authFor('not-a-valid-password-hash', true),
      csrfToken,
      currentPassword: currentSecret,
      newPassword: newSecret,
      request: request(),
    })).rejects.toSatisfy((error) => error.status === 429 && error.code === 'rate_limit_exceeded' && error.retryAfter === 17 && !error.message.includes(currentSecret) && !error.message.includes(newSecret))
    expect(repository.reserveRateLimit).toHaveBeenCalledWith(expect.objectContaining({ scope: 'password-change', subjectType: 'ip' }))
    expect(repository.updatePassword).not.toHaveBeenCalled()
    expect(repository.assertActiveSessionForUser).not.toHaveBeenCalled()
  })

  it('rejects an in-flight password change when the initiating session was invalidated', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const repository = repositoryFor({ ...user, passwordHash: await hashPassword(newPassword), passwordEnabled: true, sessionVersion: 1 })
    repository.assertActiveSessionForUser.mockResolvedValue(false)
    const service = serviceFor(repository)

    await expect(service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword, newPassword, request: request() })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(repository.updatePassword).not.toHaveBeenCalled()
    expect(repository.revokeSessionsByUserId).not.toHaveBeenCalled()
    expect(repository.insertAudit).not.toHaveBeenCalled()
  })

  it('changes the password only after quota admission and an active-session fence', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const updatedUser = { ...user, passwordHash: await hashPassword(newPassword), passwordEnabled: true, sessionVersion: 1 }
    const repository = repositoryFor(updatedUser)
    const service = serviceFor(repository)
    const result = await service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword, newPassword, request: request() })

    expect(result.user.hasPassword).toBe(true)
    expect(repository.reserveRateLimit).toHaveBeenCalledWith(expect.objectContaining({ scope: 'password-change', subjectType: 'ip' }))
    expect(repository.assertActiveSessionForUser).toHaveBeenCalledWith({ sessionId: 'session-1', userId: user._id, sessionVersion: 0 }, { session: 'mongo-session' })
    expect(repository.updatePassword).toHaveBeenCalledWith(user._id, expect.any(String), { session: 'mongo-session', expectedSessionVersion: 0 })
  })

  function authFor(passwordHash, passwordEnabled) {
    return {
      user: { ...user, passwordHash, passwordEnabled },
      session: { _id: 'session-1', userSessionVersion: 0, csrfSecretHash: hashCsrfToken(csrfToken) },
    }
  }

  it('rejects a wrong current password without touching the repository', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const repository = repositoryFor(null)
    const service = serviceFor(repository)
    await expect(service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword: 'wrong-password', newPassword, request: request() })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(repository.updatePassword).not.toHaveBeenCalled()
  })

  it('rejects a too-short new password before any write', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const repository = repositoryFor(null)
    const service = serviceFor(repository)
    await expect(service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword, newPassword: 'short', request: request() })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(repository.updatePassword).not.toHaveBeenCalled()
  })

  it('rejects an invalid CSRF token before verifying the current password', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const repository = repositoryFor(null)
    const service = serviceFor(repository)
    await expect(service.changePassword({ auth: authFor(passwordHash, true), csrfToken: 'tampered-csrf-token-value-123456', currentPassword, newPassword, request: request() })).rejects.toMatchObject({ status: 403, code: 'csrf_invalid' })
    expect(repository.updatePassword).not.toHaveBeenCalled()
  })

  it('changes the password, revokes prior sessions and issues a fresh session', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const updatedUser = { ...user, passwordHash: await hashPassword(newPassword), passwordEnabled: true, sessionVersion: 1 }
    const repository = repositoryFor(updatedUser)
    const service = serviceFor(repository)
    const result = await service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword, newPassword, request: request() })
    expect(result.user.hasPassword).toBe(true)
    expect(typeof result.sessionToken).toBe('string')
    expect(typeof result.csrfToken).toBe('string')
    expect(repository.updatePassword).toHaveBeenCalledWith(user._id, expect.any(String), { session: 'mongo-session', expectedSessionVersion: 0 })
    expect(repository.revokeSessionsByUserId).toHaveBeenCalledWith(user._id, { session: 'mongo-session' })
    expect(repository.createSession).toHaveBeenCalled()
    expect(repository.insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user_password_changed', reasonCode: 'password_changed' }), { session: 'mongo-session' })
  })

  it('lets a Google-only account set a first password without a current password', async () => {
    const dummyHash = await hashPassword('oauth-dummy:irrelevant')
    const updatedUser = { ...user, passwordHash: await hashPassword(newPassword), passwordEnabled: true, sessionVersion: 1 }
    const repository = repositoryFor(updatedUser)
    const service = serviceFor(repository)
    const result = await service.changePassword({ auth: authFor(dummyHash, false), csrfToken, newPassword, request: request() })
    expect(result.user.hasPassword).toBe(true)
    expect(repository.updatePassword).toHaveBeenCalledWith(user._id, expect.any(String), { session: 'mongo-session', expectedSessionVersion: 0 })
  })

  it('returns 401 when the session-version compare-and-set fails', async () => {
    const passwordHash = await hashPassword(currentPassword)
    const repository = repositoryFor(null)
    const service = serviceFor(repository)
    await expect(service.changePassword({ auth: authFor(passwordHash, true), csrfToken, currentPassword, newPassword, request: request() })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(repository.revokeSessionsByUserId).not.toHaveBeenCalled()
    expect(repository.insertAudit).not.toHaveBeenCalled()
  })
})
