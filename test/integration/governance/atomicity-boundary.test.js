import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createTakedownService } from '../../../server/application/takedowns/service.js'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../../../server/repositories/mongo/account-deletion-repository.js'
import { createAccountDeletionQueueAdapter } from '../../../server/jobs/account-deletion-queue.js'
import { deletionCompletion } from '../../../server/application/account-deletion/service.js'
import { buildRemovedArticleTombstone } from '../../../server/domain/article/removed-tombstone.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')
const adminId = new ObjectId('507f1f77bcf86cd799439501')
const sessionId = new ObjectId('507f1f77bcf86cd799439502')
const articleId = new ObjectId('507f1f77bcf86cd799439503')
const articleSourceId = new ObjectId('507f1f77bcf86cd799439507')
const takedownId = new ObjectId('507f1f77bcf86cd799439504')
const deletionId = new ObjectId('507f1f77bcf86cd799439505')
const userId = new ObjectId('507f1f77bcf86cd799439506')

function keyring() { return { versions: [1], currentVersion: 1, digest: () => 'f'.repeat(64) } }

describe('Step 11 terminal governance atomicity boundaries', () => {
  it('rolls back the service/repository takedown transition when suppression insert is denied', async () => {
    const mongo = createStep11Mongo({
      app: {
        users: [{ _id: adminId, role: 'admin', status: 'active', sessionVersion: 3, updatedAt: now }],
        sessions: [{ _id: sessionId, userId: adminId, userSessionVersion: 3, status: 'active', expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000), lastSeenAt: now }],
        articles: [buildRemovedArticleTombstone({
          _id: articleId,
          sourceId: articleSourceId,
          connectorType: 'rss',
          canonicalUrlHash: 'a'.repeat(64),
          removalPolicyVersion: 3,
          createdAt: now,
          updatedAt: now,
        }, { now })],
        takedownRequests: [{ _id: takedownId, status: 'approved', targetType: 'article', targetIds: [articleId], requestedScope: ['metadata'], completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true }, updatedAt: now }],
        adminAuditLogs: [],
      },
      governance: { governanceSuppressions: [] },
    })
    mongo.governanceDb.collection('governanceSuppressions').insertOne = vi.fn(async () => { throw new Error('suppression permission denied') })
    const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb, governanceKeyring: keyring(), now: () => now })
    const service = createTakedownService({ repository, clock: () => now, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) } })

    await expect(service.update({
      auth: { user: { _id: adminId, role: 'admin', status: 'active' }, session: { _id: sessionId, userSessionVersion: 3 } },
      takedownRequestId: takedownId.toHexString(), input: { status: 'completed', reasonCode: 'takedown_completed' }, request: { serverRequestId: 'step11-terminal-takedown' },
    })).rejects.toThrow('suppression permission denied')
    expect(await mongo.db.collection('takedownRequests').findOne({ _id: takedownId })).toMatchObject({ status: 'approved' })
    expect(await mongo.db.collection('adminAuditLogs').countDocuments({})).toBe(0)
    expect(await mongo.governanceDb.collection('governanceSuppressions').countDocuments({})).toBe(0)
  })

  it('rolls back worker terminal completion when governance suppression is denied', async () => {
    const mongo = createStep11Mongo({
      app: {
        accountDeletionRequests: [{ _id: deletionId, userId, status: 'queued', attempt: 1, priority: 50, availableAt: now, agingEligibleAt: new Date(now.getTime() + 300_000), leaseGeneration: 0, completion: deletionCompletion({ sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: true, userQuotaDataDeleted: true, identityAnonymized: true }), error: null, requestedAt: now, updatedAt: now }],
        adminAuditLogs: [],
      },
      governance: { governanceSuppressions: [] },
    })
    mongo.governanceDb.collection('governanceSuppressions').insertOne = vi.fn(async () => { throw new Error('suppression permission denied') })
    const repository = new MongoAccountDeletionRepository({ db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb, quotaKeyring: keyring(), governanceKeyring: keyring(), now: () => now })
    const adapter = createAccountDeletionQueueAdapter({ repository, ownerToken: () => 'b'.repeat(64) })
    const candidate = await adapter.selectDue({ now })

    await expect(adapter.claimAndExecute({ candidate, now })).rejects.toThrow('suppression permission denied')
    const request = await repository.findById(deletionId)
    expect(request).toMatchObject({ status: 'running', attempt: 1, completion: deletionCompletion({ sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: true, userQuotaDataDeleted: true, identityAnonymized: true }) })
    expect(await mongo.db.collection('adminAuditLogs').countDocuments({})).toBe(0)
    expect(await mongo.governanceDb.collection('governanceSuppressions').countDocuments({})).toBe(0)
  })
})
