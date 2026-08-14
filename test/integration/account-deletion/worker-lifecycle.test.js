import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoAccountDeletionRepository } from '../../../server/repositories/mongo/account-deletion-repository.js'
import { createAccountDeletionQueueAdapter } from '../../../server/jobs/account-deletion-queue.js'
import { createAccountDeletionService, deletionCompletion } from '../../../server/application/account-deletion/service.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')
const userId = new ObjectId('507f1f77bcf86cd799439201')
const requestId = new ObjectId('507f1f77bcf86cd799439202')
const adminId = new ObjectId('507f1f77bcf86cd799439203')
const adminSessionId = new ObjectId('507f1f77bcf86cd799439211')

function setup() {
  const quotaHashes = ['quota-v1', 'quota-v2']
  const mongo = createStep11Mongo({
    app: {
      accountDeletionRequests: [{
        _id: requestId, userId, status: 'queued', attempt: 1, priority: 50, availableAt: now, agingEligibleAt: new Date(now.getTime() + 300_000),
        leaseGeneration: 0, completion: deletionCompletion({ sessionsRevoked: true }), error: null, requestedAt: now, updatedAt: now,
      }],
      users: [{ _id: userId, status: 'deletion-pending', sessionVersion: 4, role: 'user', email: 'deleted@example.test', preferences: { topics: ['ai'] }, createdAt: now, updatedAt: now }, { _id: adminId, status: 'active', sessionVersion: 5, role: 'admin', updatedAt: now }],
      sessions: [{ _id: new ObjectId('507f1f77bcf86cd799439204'), userId }, { _id: adminSessionId, userId: adminId, userSessionVersion: 5, status: 'active', expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000), lastSeenAt: now }],
      savedArticles: [{ _id: new ObjectId('507f1f77bcf86cd799439205'), userId }],
      chatSessions: [{ _id: new ObjectId('507f1f77bcf86cd799439206'), userId }],
      answerAttempts: [{ _id: new ObjectId('507f1f77bcf86cd799439207'), userId }],
      rateLimitBuckets: [{ _id: new ObjectId('507f1f77bcf86cd799439208'), subjectType: 'user', keyHash: quotaHashes[0] }, { _id: new ObjectId('507f1f77bcf86cd799439209'), subjectType: 'user', keyHash: quotaHashes[1] }, { _id: new ObjectId('507f1f77bcf86cd799439210'), subjectType: 'ip', keyHash: 'shared-ip' }],
      adminAuditLogs: [],
    },
    governance: { governanceSuppressions: [] },
  })
  const repository = new MongoAccountDeletionRepository({
    db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb,
    quotaKeyring: { versions: [1, 2], digest: (_value, version) => `quota-v${version}` },
    governanceKeyring: { versions: [1], currentVersion: 1, digest: () => 'd'.repeat(64) }, now: () => now,
  })
  const adapter = createAccountDeletionQueueAdapter({ repository, ownerToken: () => 'a'.repeat(64) })
  const service = createAccountDeletionService({ repository, rateLimitAdmission: { reserve: async () => ({ allowed: true }) }, clock: () => now })
  return { mongo, repository, adapter, service }
}

describe('Step 11 account deletion worker lifecycle', () => {
  it('preserves seven completion flags across a crash and same-request retry', async () => {
    const fixture = setup()
    const answerAttempts = fixture.mongo.db.collection('answerAttempts')
    const originalDelete = answerAttempts.deleteMany.bind(answerAttempts)
    let crash = true
    answerAttempts.deleteMany = async (...args) => {
      if (crash) { crash = false; throw new Error('simulated worker crash') }
      return originalDelete(...args)
    }

    const candidate = await fixture.adapter.selectDue({ now })
    const failed = await fixture.adapter.claimAndExecute({ candidate, now })
    expect(failed).toEqual({ claimed: true, status: 'failed' })
    const partial = await fixture.repository.findById(requestId)
    expect(partial).toMatchObject({ status: 'failed', attempt: 1, completion: { sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false } })

    const retried = await fixture.service.retry({ auth: { user: { _id: adminId, role: 'admin', status: 'active' }, session: { _id: adminSessionId, userSessionVersion: 5 } }, deletionRequestId: requestId.toHexString(), reasonCode: 'account_deletion_retry_requested', idempotencyKey: 'step11-retry-1', request: { serverRequestId: 'step11-retry-1', requestHash: 'e'.repeat(64) } })
    expect(retried).toMatchObject({ status: 'queued', attempt: 2 })
    const retryCandidate = await fixture.adapter.selectDue({ now })
    const completed = await fixture.adapter.claimAndExecute({ candidate: retryCandidate, now })
    expect(completed).toEqual({ claimed: true, status: 'succeeded' })

    const finalRequest = await fixture.repository.findById(requestId)
    expect(finalRequest).toMatchObject({ status: 'completed', attempt: 2, completion: { sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: true, userQuotaDataDeleted: true, identityAnonymized: true } })
    expect(await fixture.mongo.db.collection('sessions').countDocuments({ userId })).toBe(0)
    expect(await fixture.mongo.db.collection('savedArticles').countDocuments({ userId })).toBe(0)
    expect(await fixture.mongo.db.collection('chatSessions').countDocuments({ userId })).toBe(0)
    expect(await fixture.mongo.db.collection('answerAttempts').countDocuments({ userId })).toBe(0)
    expect(await fixture.mongo.db.collection('rateLimitBuckets').countDocuments({ subjectType: 'user', keyHash: { $in: ['quota-v1', 'quota-v2'] } })).toBe(0)
    expect(await fixture.mongo.db.collection('rateLimitBuckets').countDocuments({ subjectType: 'ip', keyHash: 'shared-ip' })).toBe(1)
    expect(await fixture.mongo.db.collection('users').findOne({ _id: userId })).toEqual(expect.objectContaining({ _id: userId, status: 'deleted', deletionRequestId: requestId }))
    expect(await fixture.mongo.governanceDb.collection('governanceSuppressions').countDocuments({ kind: 'account-deletion' })).toBe(1)
  })
})
