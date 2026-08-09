import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoAuthRepository } from '../../server/repositories/mongo/auth-repository.js'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
let client
let context
let repository
let databaseName
const quotaKeyring = createHmacKeyring({ currentEnv: 'CURRENT', retiringEnvs: ['OLD'], currentVersion: 1, retiringVersions: [2], values: { CURRENT: 'c'.repeat(32), OLD: 'o'.repeat(32) } })

beforeAll(async () => {
  if (!hasMongo) return
  configureDns()
  databaseName = databaseNameForSuite('mongo')
  client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  context = createMongoContext({ client, database: databaseName })
  await runAuthCoreMigration({ db: context.db })
  repository = new MongoAuthRepository(context)
})

afterAll(async () => {
  if (context) await dropTestDatabase({ context, expectedDatabase: databaseName })
  if (client) await client.close()
})

describeMongo('Step 2 Mongo integration', () => {
  it('creates validators/indexes and keeps session tokens hashed', async () => {
    const user = await repository.createUser({
      emailNormalized: 'mongo@example.com',
      emailDisplay: 'mongo@example.com',
      passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64),
      role: 'user',
      status: 'active',
      topicPreferences: [],
      sessionVersion: 0,
    })
    await repository.createSession({ userId: user._id, tokenHash: 'a'.repeat(64), csrfSecretHash: 'c'.repeat(64), userSessionVersion: 0 })
    const session = await context.db.collection('sessions').findOne({ userId: user._id })
    expect(session.tokenHash).toHaveLength(64)
    expect(session.tokenHash).not.toContain('opaque-session')
    const indexes = await context.db.collection('sessions').indexes()
    expect(indexes.some((index) => index.name === 'sessions_expires_ttl')).toBe(true)
  })

  it('rolls back domain mutation when audit insertion fails in the same transaction', async () => {
    const userId = new ObjectId()
    await expect(
      repository.withTransaction(async (session) => {
        await context.db.collection('users').insertOne(
          {
            _id: userId,
            emailNormalized: 'rollback@example.com',
            emailDisplay: 'rollback@example.com',
            passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64),
            role: 'user',
            status: 'active',
            topicPreferences: [],
            sessionVersion: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { session },
        )
        throw new Error('simulated audit insert denial')
      }),
    ).rejects.toThrow('simulated audit insert denial')
    expect(await context.db.collection('users').findOne({ _id: userId })).toBeNull()
  })

  it('atomically enforces login bucket limits and closed scope ownership', async () => {
    const now = new Date()
    const keyHash = 'b'.repeat(64)
    const windowStart = new Date(Math.floor(now.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000)
    await context.db.collection('rateLimitBuckets').insertOne({ _id: new ObjectId(), scope: 'login', subjectType: 'ip', keyHash, keyVersion: 1, keyFingerprint: quotaKeyring.fingerprint(1), windowStart, count: 9, limit: 10, expiresAt: new Date(windowStart.getTime() + 900_000), updatedAt: now })
    const allowed = await repository.reserveRateLimit({ scope: 'login', subjectType: 'ip', keyHash, keyVersion: 1, keyring: quotaKeyring, now })
    const denied = await repository.reserveRateLimit({ scope: 'login', subjectType: 'ip', keyHash, keyVersion: 1, keyring: quotaKeyring, now })
    expect(allowed.allowed).toBe(true)
    expect(denied.allowed).toBe(false)
    await expect(repository.reserveRateLimit({ scope: 'login', subjectType: 'user', keyHash, keyVersion: 1, keyring: quotaKeyring, now })).rejects.toThrow(/scope ownership/)
  }, 20_000)

  it('fills an empty rate-limit window under concurrent reservations without false denials', async () => {
    const now = new Date()
    const keyHash = 'e'.repeat(64)
    const results = await Promise.all(Array.from({ length: 10 }, () => repository.reserveRateLimit({
      scope: 'login', subjectType: 'ip', keyHash, keyVersion: 1, keyring: quotaKeyring, now,
    })))

    expect(results.every((result) => result.allowed)).toBe(true)
    expect(await context.db.collection('rateLimitBuckets').findOne({ scope: 'login', subjectType: 'ip', keyHash })).toEqual(expect.objectContaining({ count: 10 }))
  }, 20_000)

  it('rejects identity fields on tombstones and non-allowlisted audit reason codes', async () => {
    const tombstoneId = new ObjectId()
    const tombstone = { _id: tombstoneId, status: 'deleted', deletionRequestedAt: new Date(), deletionRequestId: new ObjectId(), deletedAt: new Date(), sessionVersion: 2, createdAt: new Date(), updatedAt: new Date() }
    await context.db.collection('users').insertOne(tombstone)
    await expect(context.db.collection('users').insertOne({ ...tombstone, _id: new ObjectId(), emailNormalized: 'leak@example.com' })).rejects.toThrow(/validation/)
    await expect(repository.createUser({ emailNormalized: 'duplicate-topics@example.com', emailDisplay: 'duplicate-topics@example.com', passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64), topicPreferences: ['AI', 'AI'] })).rejects.toThrow(/validation/)
    await expect(repository.insertAudit({ eventId: 'bad-audit-1', actorType: 'user', actorId: tombstoneId, action: 'user_registered', targetType: 'user', targetId: tombstoneId, changedFields: ['email'], reasonCode: 'free_form', requestId: 'request-1', result: 'succeeded', createdAt: new Date() })).rejects.toThrow(/allowlisted/)
    const auditBase = { actorType: 'system-worker', actorId: tombstoneId, targetType: 'user', targetId: tombstoneId, requestId: 'request-2', result: 'succeeded', createdAt: new Date() }
    await expect(context.db.collection('adminAuditLogs').insertOne({ ...auditBase, _id: new ObjectId(), eventId: 'bad-audit-2', action: 'user_registered', changedFields: ['passwordHash'], reasonCode: 'user_registered' })).rejects.toThrow(/validation/)
    await expect(context.db.collection('adminAuditLogs').insertOne({ ...auditBase, _id: new ObjectId(), eventId: 'bad-audit-3', action: 'user_suspended', changedFields: ['status', 'sessionVersion'], reasonCode: 'user_suspended' })).rejects.toThrow(/validation/)
    const ipAuditId = new ObjectId()
    await context.db.collection('adminAuditLogs').insertOne({ ...auditBase, _id: ipAuditId, eventId: 'ip-audit-missing-version', action: 'user_logged_in', changedFields: [], reasonCode: 'user_login', ipAddressHmac: 'a'.repeat(64) })
    expect(await repository.countUnknownIpHmacKeyVersions([1])).toBe(1)
    await context.db.collection('adminAuditLogs').deleteOne({ _id: ipAuditId })
  })

  it('consolidates an old HMAC bucket and reserves the current bucket in one transaction', async () => {
    const now = new Date()
    const windowStart = new Date(Math.floor(now.getTime() / (15 * 60 * 1000)) * 15 * 60 * 1000)
    const oldKeyHash = 'c'.repeat(64)
    const currentKeyHash = 'd'.repeat(64)
    await context.db.collection('rateLimitBuckets').insertOne({ _id: new ObjectId(), scope: 'login', subjectType: 'ip', keyHash: oldKeyHash, keyVersion: 2, keyFingerprint: quotaKeyring.fingerprint(2), windowStart, count: 5, limit: 10, expiresAt: new Date(windowStart.getTime() + 900_000), updatedAt: now })
    const result = await repository.reserveRateLimit({ scope: 'login', subjectType: 'ip', keyHash: currentKeyHash, keyVersion: 1, rotationKeyHashes: [oldKeyHash], keyring: quotaKeyring, now })
    expect(result.allowed).toBe(true)
    expect(result.count).toBe(6)
    expect(await context.db.collection('rateLimitBuckets').countDocuments({ keyHash: oldKeyHash })).toBe(0)
  })

  it('uses compound deadline indexes for stable audit cleanup cursors', async () => {
    const now = new Date()
    const targetId = new ObjectId()
    await context.db.collection('adminAuditLogs').insertMany([
      { _id: new ObjectId(), eventId: `cleanup-ip-${targetId}`, actorType: 'system-worker', actorId: targetId, action: 'user_logged_in', targetType: 'user', targetId, changedFields: [], reasonCode: 'user_login', requestId: `cleanup-ip-${targetId}`, result: 'succeeded', createdAt: now, ipHmacPurgeAfter: now },
      { _id: new ObjectId(), eventId: `cleanup-all-${targetId}`, actorType: 'system-worker', actorId: targetId, action: 'user_logged_in', targetType: 'user', targetId, changedFields: [], reasonCode: 'user_login', requestId: `cleanup-all-${targetId}`, result: 'succeeded', createdAt: now, purgeAfter: now },
    ])
    const stagesFor = async (filter, sort) => {
      const explain = await context.db.collection('adminAuditLogs').find(filter).sort(sort).explain('queryPlanner')
      const stages = []
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.stage) stages.push(node.stage)
        Object.values(node).forEach(visit)
      }
      visit(explain.queryPlanner?.winningPlan)
      return stages
    }

    expect(await stagesFor({ ipHmacPurgeAfter: { $lte: now } }, { ipHmacPurgeAfter: 1, _id: 1 })).not.toContain('SORT')
    expect(await stagesFor({ purgeAfter: { $lte: now } }, { purgeAfter: 1, _id: 1 })).not.toContain('SORT')
  })

  it('seeds the same admin concurrently with one creation and one idempotent reuse', async () => {
    const input = {
      emailNormalized: 'seed-race@example.com', emailDisplay: 'seed-race@example.com',
      passwordHash: 'scrypt$16384$8$1$s:' + 'z'.repeat(64),
    }
    const outcomes = await Promise.all([repository.seedAdmin(input), repository.seedAdmin(input)])

    expect(outcomes.filter((outcome) => outcome.seeded)).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.existing)).toHaveLength(1)
    expect(await context.db.collection('users').countDocuments({ emailNormalized: input.emailNormalized })).toBe(1)
  })
})
