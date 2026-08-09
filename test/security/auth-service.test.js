import { describe, expect, it, vi } from 'vitest'
import { createAuthService } from '../../server/application/auth/service.js'
import { createHmacKeyring, validateRetiringKey } from '../../server/security/hmac-keyring.js'
import { hashCsrfToken } from '../../server/security/session-token.js'

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
    const service = createAuthService({ repository })
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
      updateUserStatus: vi.fn(async () => ({ ...user, role: 'user', status: 'suspended', sessionVersion: 1 })),
      revokeSessionsByUserId: vi.fn(async () => undefined),
      insertAudit: vi.fn(async () => undefined),
    }
    const service = createAuthService({ repository })
    const admin = { ...user, _id: 'admin-1', role: 'admin' }
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: admin, session: { csrfSecretHash: hashCsrfToken(csrfToken) } }
    const targetUserId = '507f1f77bcf86cd799439011'
    const result = await service.updateUserStatus({ auth, userId: targetUserId, status: 'suspended', reasonCode: 'user_suspended', csrfToken })
    expect(result.status).toBe('suspended')
    expect(repository.updateUserStatus).toHaveBeenCalledWith(targetUserId, 'suspended', 'user_suspended', { session: 'mongo-session' })
    expect(repository.revokeSessionsByUserId).toHaveBeenCalledWith(targetUserId, { session: 'mongo-session' })
    expect(repository.insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user_suspended' }), { session: 'mongo-session' })
  })

  it('persists a failed audit event before reporting a conflicting privileged transition', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('mongo-session')),
      updateUserStatus: vi.fn(async () => ({ conflict: true })),
      insertAudit: vi.fn(async () => undefined),
    }
    const service = createAuthService({ repository })
    const csrfToken = 'csrf-token-for-admin-1234567890'
    const auth = { user: { ...user, _id: 'admin-1', role: 'admin' }, session: { csrfSecretHash: hashCsrfToken(csrfToken) } }
    const targetUserId = '507f1f77bcf86cd799439011'

    await expect(service.updateUserStatus({ auth, userId: targetUserId, status: 'suspended', reasonCode: 'user_suspended', csrfToken })).rejects.toMatchObject({ status: 409 })
    expect(repository.insertAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user_suspended', result: 'failed' }), { session: 'mongo-session' })
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
