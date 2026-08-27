import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoAuthRepository } from '../../../server/repositories/mongo/auth-repository.js'

const userId = new ObjectId('507f1f77bcf86cd799439011')
const sessionId = new ObjectId('507f1f77bcf86cd799439012')
const articleId = new ObjectId('507f1f77bcf86cd799439013')
const now = new Date('2026-08-20T08:00:00.000Z')

function createCursor(values = []) {
  const cursor = {
    sort: vi.fn(() => cursor),
    skip: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    project: vi.fn(() => cursor),
    toArray: vi.fn(async () => values),
  }
  return cursor
}

function createContext({
  findOne = {},
  findResults = {},
  updateResults = {},
  updateManyResults = {},
  findOneAndUpdateResults = {},
  insertResults = {},
  deleteResults = {},
  countResults = {},
  session = null,
} = {}) {
  const collections = new Map()
  const take = (input, name, fallback) => {
    const queue = input[name]
    return Array.isArray(queue) && queue.length > 0 ? queue.shift() : fallback
  }
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async () => take(findOne, name, null)),
      find: vi.fn(() => createCursor(take(findResults, name, []))),
      updateOne: vi.fn(async () => take(updateResults, name, { matchedCount: 1, upsertedCount: 0 })),
      updateMany: vi.fn(async () => take(updateManyResults, name, { matchedCount: 1, modifiedCount: 1 })),
      findOneAndUpdate: vi.fn(async () => take(findOneAndUpdateResults, name, null)),
      insertOne: vi.fn(async () => take(insertResults, name, { acknowledged: true })),
      deleteOne: vi.fn(async () => take(deleteResults, name, { deletedCount: 1 })),
      deleteMany: vi.fn(async () => take(deleteResults, name, { deletedCount: 1 })),
      countDocuments: vi.fn(async () => take(countResults, name, 0)),
    }
    collections.set(name, handle)
    return handle
  }
  const transactionSession = session ?? {
    withTransaction: vi.fn(async (work) => work(transactionSession)),
    endSession: vi.fn(async () => {}),
  }
  const context = { db: { collection }, client: { startSession: vi.fn(() => transactionSession) } }
  return { repository: new MongoAuthRepository(context), context, collections, session: transactionSession }
}

const actor = { _id: userId, role: 'admin' }

function audit(overrides = {}) {
  return {
    eventId: 'user-suspended:user-1:req-1',
    actorType: 'admin',
    actorId: userId,
    action: 'user_suspended',
    targetType: 'user',
    targetId: userId,
    changedFields: ['status', 'sessionVersion'],
    reasonCode: 'user_suspended',
    stateTransition: { from: 'active', to: 'suspended' },
    requestId: 'req-1',
    result: 'succeeded',
    createdAt: now,
    ...overrides,
  }
}

const keyring = {
  versions: [1, 2],
  fingerprint: vi.fn((version) => `fingerprint-${version}`),
  acceptsVersion: vi.fn((version) => version === 1 || version === 2),
  matchesFingerprint: vi.fn((version, fingerprint) => fingerprint === `fingerprint-${version}`),
}

describe('MongoAuthRepository', () => {
  it('requires Mongo context, creates users, seeds admins, and queries identities', async () => {
    expect(() => new MongoAuthRepository()).toThrow(/MongoDB context/i)
    const fixture = createContext({ updateResults: { users: [{ upsertedCount: 1 }] }, findOne: { users: [{ _id: userId, role: 'admin', status: 'active' }, { _id: userId, googleSub: 'google-sub' }, { _id: userId }] } })
    const created = await fixture.repository.createUser({ _id: userId, emailNormalized: 'user@example.com', emailDisplay: 'User', passwordHash: 'hash', suspendedAt: now, suspensionReason: 'reason', googleSub: 'google-sub', createdAt: now, updatedAt: now })
    expect(created).toEqual(expect.objectContaining({ _id: userId, role: 'user', status: 'active', topicPreferences: [], sessionVersion: 0 }))
    expect(fixture.collections.get('users').insertOne).toHaveBeenCalled()

    await expect(fixture.repository.seedAdmin({ emailNormalized: 'admin@example.com', emailDisplay: 'Admin', passwordHash: 'hash', createdAt: now })).resolves.toEqual(expect.objectContaining({ seeded: true, existing: false }))
    await expect(fixture.repository.findUserByEmail('admin@example.com')).resolves.toEqual(expect.objectContaining({ role: 'admin' }))
    await expect(fixture.repository.findUserByGoogleSub('google-sub')).resolves.toEqual(expect.objectContaining({ googleSub: 'google-sub' }))
    await expect(fixture.repository.findUserById(userId.toHexString())).resolves.toEqual(expect.objectContaining({ _id: userId }))
  })

  it('handles seed races and refuses an existing non-admin account', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 })
    const fixture = createContext({ updateResults: { users: [duplicate] }, findOne: { users: [{ role: 'admin', status: 'active' }] } })
    await expect(fixture.repository.seedAdmin({ emailNormalized: 'admin@example.com', emailDisplay: 'Admin', passwordHash: 'hash' })).resolves.toEqual(expect.objectContaining({ seeded: false, existing: true }))

    const invalid = createContext({ updateResults: { users: [{ upsertedCount: 0 }] }, findOne: { users: [{ role: 'user', status: 'active' }] } })
    await expect(invalid.repository.seedAdmin({ emailNormalized: 'user@example.com', emailDisplay: 'User', passwordHash: 'hash' })).rejects.toThrow(/active admin/i)
    const failed = createContext({ updateResults: { users: [Promise.reject(new Error('storage failed'))] } })
    await expect(failed.repository.seedAdmin({ emailNormalized: 'admin@example.com', emailDisplay: 'Admin', passwordHash: 'hash' })).rejects.toThrow('storage failed')
  })

  it('lists users with status, email, cursor and API-safe projections', async () => {
    const documents = [{ _id: userId, emailDisplay: 'User', role: 'user', status: 'active', createdAt: now, updatedAt: now }]
    const fixture = createContext({ findResults: { users: [documents] } })
    await expect(fixture.repository.listUsers({ skip: 2, limit: 3, status: 'active', emailNormalized: 'user@example.com', cursor: { createdAt: now, id: sessionId } })).resolves.toEqual([{ id: userId.toString(), emailDisplay: 'User', role: 'user', status: 'active', createdAt: now, updatedAt: now }])
    const query = fixture.collections.get('users').find.mock.calls[0][0]
    expect(query).toEqual(expect.objectContaining({ status: 'active', emailNormalized: 'user@example.com', $or: expect.any(Array) }))
    const cursor = fixture.collections.get('users').find.mock.results[0].value
    expect(cursor.skip).toHaveBeenCalledWith(2)
    await expect(fixture.repository.listUsers({})).resolves.toEqual([])
  })

  it('updates preferences and user status with session fences and CAS conflicts', async () => {
    const fenced = createContext({ updateResults: { sessions: [{ matchedCount: 1 }], users: [{ matchedCount: 1 }] }, findOneAndUpdateResults: { users: [{ _id: userId, topicPreferences: ['ai'] }] } })
    await expect(fenced.repository.updatePreferences(userId, ['ai'], { expectedSessionId: sessionId, expectedSessionVersion: 2, session: { tx: true } })).resolves.toEqual(expect.objectContaining({ topicPreferences: ['ai'] }))
    const blocked = createContext({ updateResults: { sessions: [{ matchedCount: 0 }] } })
    await expect(blocked.repository.updatePreferences(userId, ['ai'], { expectedSessionId: sessionId, expectedSessionVersion: 2 })).resolves.toBeNull()

    const missing = createContext({ findOne: { users: [null] } })
    await expect(missing.repository.updateUserStatus(userId, 'suspended', 'user_suspended')).resolves.toBeNull()
    const conflict = createContext({ findOne: { users: [{ status: 'deleted' }] } })
    await expect(conflict.repository.updateUserStatus(userId, 'suspended', 'user_suspended')).resolves.toEqual({ conflict: true })
    const suspend = createContext({ findOne: { users: [{ status: 'active' }] }, findOneAndUpdateResults: { users: [{ status: 'suspended' }] } })
    await expect(suspend.repository.updateUserStatus(userId, 'suspended', 'user_suspended')).resolves.toEqual({ status: 'suspended' })
    const restore = createContext({ findOne: { users: [{ status: 'suspended' }] }, findOneAndUpdateResults: { users: [{ status: 'active' }] } })
    await expect(restore.repository.updateUserStatus(userId, 'active', 'user_restored')).resolves.toEqual({ status: 'active' })
  })

  it('creates, touches and revokes sessions with user lifecycle fences', async () => {
    const fixture = createContext({ findOne: { users: [{}], sessions: [{ _id: sessionId, status: 'active' }] }, findOneAndUpdateResults: { sessions: [{ _id: sessionId, status: 'active' }] } })
    const session = await fixture.repository.createSession({ _id: sessionId, tokenHash: 'token', userId, userSessionVersion: 2, csrfSecretHash: 'csrf', createdIpHmac: 'ip', ipHmacKeyVersion: 1, userAgentSummary: 'browser', createdAt: now, absoluteExpiresAt: new Date(now.getTime() + 1000) }, { expectedUserSessionVersion: 2 })
    expect(session).toEqual(expect.objectContaining({ _id: sessionId, status: 'active', userId }))
    await expect(fixture.repository.findSessionByTokenHash('token')).resolves.toEqual(expect.objectContaining({ status: 'active' }))
    await expect(fixture.repository.touchSession(sessionId, now, { userId, expectedSessionVersion: 2 })).resolves.toEqual(expect.objectContaining({ status: 'active' }))
    await expect(fixture.repository.revokeSession(sessionId)).resolves.toEqual(expect.objectContaining({ matchedCount: expect.anything() }))
    await expect(fixture.repository.revokeSessionsByUserId(userId)).resolves.toEqual(expect.objectContaining({ matchedCount: expect.anything() }))
    await expect(fixture.repository.deleteSessionsByUserId(userId)).resolves.toEqual(expect.objectContaining({ deletedCount: expect.anything() }))
    await expect(fixture.repository.deleteSessionsByUserIdAndVerify(userId)).resolves.toEqual(expect.objectContaining({ remaining: 0, zeroMatch: true }))

    const badFence = createContext({ findOne: { users: [null] } })
    await expect(badFence.repository.createSession({ userId, tokenHash: 'token', csrfSecretHash: 'csrf', createdAt: now }, { expectedUserSessionVersion: 3 })).rejects.toThrow(/fence/i)
    await expect(badFence.repository.touchSession(sessionId, now, { userId, expectedSessionVersion: 3 })).resolves.toBeNull()
  })

  it('supports quota bucket cleanup, reads, counts, and lifecycle snapshots', async () => {
    const empty = createContext()
    await expect(empty.repository.deleteUserQuotaBucketsAllVersions()).resolves.toEqual({ acknowledged: true, deletedCount: 0, remaining: 0, zeroMatch: true })
    await expect(empty.repository.deleteUserQuotaBucketsByHashes(['hash'])).resolves.toEqual(expect.objectContaining({ remaining: 0, zeroMatch: true }))
    await expect(empty.repository.countUnknownRateLimitKeyVersions([])).rejects.toThrow(/versions/i)
    await expect(empty.repository.countRateLimitDependentsByKeyVersion(1)).resolves.toBe(0)
    await expect(empty.repository.countHmacDependentsByKeyVersion(1)).resolves.toEqual({ rateLimitBuckets: 0, sessions: 0, adminAuditLogs: 0, total: 0 })
    await expect(empty.repository.countUnknownIpHmacKeyVersions([1])).resolves.toBe(0)
    await expect(empty.repository.countRateLimitFingerprintMismatches(keyring)).resolves.toBe(0)
    await expect(empty.repository.countRateLimitFingerprintMismatches({})).rejects.toThrow(/keyring/i)

    const bucket = { scope: 'answer-minute', subjectType: 'user', keyHash: 'hash', keyVersion: 1, keyFingerprint: 'fingerprint-1' }
    const read = createContext({ findOne: { rateLimitBuckets: [bucket] } })
    await expect(read.repository.readRateLimitBucket({ ...bucket, keyring })).resolves.toBe(bucket)
    const unknown = createContext({ findOne: { rateLimitBuckets: [{ ...bucket, keyVersion: 3 }] } })
    await expect(unknown.repository.readRateLimitBucket({ ...bucket, keyring: { acceptsVersion: () => false, matchesFingerprint: () => false } })).rejects.toThrow(/retired/i)

    const snapshots = createContext({ findResults: { hmacKeyLifecycleSnapshots: [[{ revision: 1 }]] } })
    await expect(snapshots.repository.listHmacLifecycleSnapshots()).resolves.toEqual([{ revision: 1 }])
    await expect(snapshots.repository.appendHmacLifecycleSnapshot({ revision: 2 })).resolves.toEqual({ revision: 2 })
  })

  it('reserves rate limits for new, exhausted and rotated buckets', async () => {
    const newBucket = { _id: articleId, count: 1, limit: 10, keyVersion: 1, keyFingerprint: 'fingerprint-1' }
    const fresh = createContext({ findOne: { rateLimitBuckets: [null] }, findOneAndUpdateResults: { rateLimitBuckets: [newBucket] } })
    await expect(fresh.repository.reserveRateLimit({ scope: 'answer-minute', subjectType: 'user', keyHash: 'current', keyVersion: 1, keyring, now })).resolves.toEqual(expect.objectContaining({ allowed: true, count: 1 }))

    const exhausted = createContext({ findOne: { rateLimitBuckets: [{ ...newBucket, count: 10 }] } })
    await expect(exhausted.repository.reserveRateLimit({ scope: 'answer-minute', subjectType: 'user', keyHash: 'current', keyVersion: 1, keyring, now }, { session: {} })).resolves.toEqual(expect.objectContaining({ allowed: false, count: 10, limit: 10 }))

    const oldBucket = { _id: sessionId, count: 2, limit: 10, keyVersion: 1, keyFingerprint: 'fingerprint-1', windowStart: now }
    const current = { _id: articleId, count: 3, limit: 10, keyVersion: 1, keyFingerprint: 'fingerprint-1', windowStart: now }
    const rotated = createContext({ findResults: { rateLimitBuckets: [[oldBucket]] }, findOne: { rateLimitBuckets: [current, current] }, updateResults: { rateLimitBuckets: [{ matchedCount: 1 }] }, findOneAndUpdateResults: { rateLimitBuckets: [{ ...current, count: 4 }] } })
    await expect(rotated.repository.reserveRateLimit({ scope: 'answer-minute', subjectType: 'user', keyHash: 'current', keyVersion: 1, keyring, rotationKeyHashes: ['old'], now }, { session: {} })).resolves.toEqual(expect.objectContaining({ allowed: true }))
    expect(rotated.collections.get('rateLimitBuckets').deleteOne).toHaveBeenCalledWith({ _id: sessionId }, { session: {} })

    await expect(fresh.repository.reserveRateLimit({ scope: 'login', subjectType: 'user', keyHash: 'x', keyVersion: 1, keyring, now }, { session: {} })).rejects.toThrow(/scope ownership/i)
    await expect(fresh.repository.reserveRateLimit({ scope: 'answer-minute', subjectType: 'user', keyHash: 'x', keyVersion: 1, keyring: {}, now }, { session: {} })).rejects.toThrow(/keyring/i)
  })

  it('consolidates rotated keys and retries transient duplicate transactions', async () => {
    const oldBucket = { _id: sessionId, count: 2, limit: 10, keyVersion: 1, keyFingerprint: 'fingerprint-1', windowStart: now }
    const absent = createContext({ findOne: { rateLimitBuckets: [null] } })
    await expect(absent.repository.consolidateRateLimitKey({ scope: 'answer-minute', subjectType: 'user', oldKeyHash: 'old', currentKeyHash: 'new', currentKeyVersion: 2, keyring })).resolves.toEqual({ moved: false })

    const merged = createContext({ findOne: { rateLimitBuckets: [oldBucket, { ...oldBucket, _id: articleId, keyVersion: 2, keyFingerprint: 'fingerprint-2', count: 3 }] }, updateResults: { rateLimitBuckets: [{ matchedCount: 1 }] } })
    await expect(merged.repository.consolidateRateLimitKey({ scope: 'answer-minute', subjectType: 'user', oldKeyHash: 'old', currentKeyHash: 'new', currentKeyVersion: 2, keyring }, { session: {} })).resolves.toEqual({ moved: true, merged: true })

    const moved = createContext({ findOne: { rateLimitBuckets: [oldBucket, null] }, updateResults: { rateLimitBuckets: [{ matchedCount: 1 }] } })
    await expect(moved.repository.consolidateRateLimitKey({ scope: 'answer-minute', subjectType: 'user', oldKeyHash: 'old', currentKeyHash: 'new', currentKeyVersion: 2, keyring }, { session: {} })).resolves.toEqual({ moved: true, merged: false })
    await expect(moved.repository.consolidateRateLimitKey({ scope: 'login', subjectType: 'user', oldKeyHash: 'old', currentKeyHash: 'new', currentKeyVersion: 2, keyring }, { session: {} })).rejects.toThrow(/scope ownership/i)

    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 })
    const session = { withTransaction: vi.fn().mockRejectedValueOnce(duplicate).mockRejectedValueOnce(duplicate).mockImplementation(async (work) => work(session)), endSession: vi.fn(async () => {}) }
    const retry = createContext({ session, findOne: { rateLimitBuckets: [null] }, findOneAndUpdateResults: { rateLimitBuckets: [{ count: 1, limit: 10 }] } })
    await expect(retry.repository.reserveRateLimit({ scope: 'answer-minute', subjectType: 'user', keyHash: 'current', keyVersion: 1, keyring, now })).resolves.toEqual(expect.objectContaining({ allowed: true }))
    expect(session.withTransaction).toHaveBeenCalledTimes(3)
  })

  it('checks active sessions and writes replay-safe audit events', async () => {
    const active = createContext({ updateResults: { sessions: [{ matchedCount: 1 }], users: [{ matchedCount: 1 }] } })
    await expect(active.repository.assertActiveSessionForUser({ sessionId, userId, sessionVersion: 2, role: 'admin', now }, { session: {} })).resolves.toBe(true)
    const inactive = createContext({ updateResults: { sessions: [{ matchedCount: 0 }] } })
    await expect(inactive.repository.assertActiveSessionForUser({ sessionId, userId, sessionVersion: 2, now })).resolves.toBe(false)

    const created = createContext({ findOne: { adminAuditLogs: [null] } })
    await expect(created.repository.insertAudit(audit())).resolves.toEqual(expect.objectContaining({ eventId: audit().eventId }))
    const replay = createContext({ findOne: { adminAuditLogs: [audit()] } })
    await expect(replay.repository.insertAudit(audit())).resolves.toEqual(expect.objectContaining({ eventId: audit().eventId }))
    const collision = createContext({ findOne: { adminAuditLogs: [{ ...audit(), requestId: 'other' }] } })
    await expect(collision.repository.insertAudit(audit())).rejects.toThrow(/collision/i)
    await expect(created.repository.insertAudit({ ...audit(), reasonCode: 'wrong' })).rejects.toThrow(/allowlisted/i)
  })

  it('lists audit records and manages saved article ownership', async () => {
    const auditRow = { action: 'user_logged_in' }
    const fixture = createContext({ findResults: { adminAuditLogs: [[auditRow]], savedArticles: [[{ articleId }]] } })
    await expect(fixture.repository.listAudit({ action: 'user_logged_in' })).resolves.toEqual([auditRow])
    await expect(fixture.repository.saveArticle(userId, articleId)).resolves.toEqual(expect.objectContaining({ userId, articleId }))
    await expect(fixture.repository.unsaveArticle(userId.toHexString(), articleId.toHexString())).resolves.toEqual(expect.objectContaining({ deletedCount: expect.anything() }))
    await expect(fixture.repository.listSavedArticles(userId, { skip: 1, limit: 2 })).resolves.toEqual([{ articleId }])
  })
})
