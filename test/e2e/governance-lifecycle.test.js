import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { createApp } from '../../server/app.js'
import { createTakedownService } from '../../server/application/takedowns/service.js'
import { createAccountDeletionService } from '../../server/application/account-deletion/service.js'
import { MongoTakedownRepository } from '../../server/repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../../server/repositories/mongo/account-deletion-repository.js'
import { MongoChatRepository } from '../../server/repositories/mongo/chat-repository.js'
import { createAccountDeletionQueueAdapter } from '../../server/jobs/account-deletion-queue.js'
import { createStep11Mongo } from '../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')
const adminId = new ObjectId('507f1f77bcf86cd799439701')
const adminSessionId = new ObjectId('507f1f77bcf86cd799439702')
const deletionUserId = new ObjectId('507f1f77bcf86cd799439703')
const deletionSessionId = new ObjectId('507f1f77bcf86cd799439704')
const viewerId = new ObjectId('507f1f77bcf86cd799439705')
const viewerSessionId = new ObjectId('507f1f77bcf86cd799439706')
const articleId = new ObjectId('507f1f77bcf86cd799439707')
const sourceId = new ObjectId('507f1f77bcf86cd799439708')
const chatId = new ObjectId('507f1f77bcf86cd799439709')

const adminToken = 'step11-e2e-admin'
const deletionToken = 'step11-e2e-deletion-user'
const viewerToken = 'step11-e2e-viewer'

function keyring(prefix) {
  return { versions: [1, 2], currentVersion: 2, digest: (_value, version = 2) => `${prefix}-${version}`.padEnd(64, '0').slice(0, 64) }
}

function authFixture() {
  const identities = new Map([
    [adminToken, { user: { _id: adminId, id: adminId.toHexString(), role: 'admin', status: 'active' }, session: { _id: adminSessionId, id: adminSessionId.toHexString(), userSessionVersion: 3 } }],
    [deletionToken, { user: { _id: deletionUserId, id: deletionUserId.toHexString(), role: 'user', status: 'active' }, session: { _id: deletionSessionId, id: deletionSessionId.toHexString(), userSessionVersion: 4 } }],
    [viewerToken, { user: { _id: viewerId, id: viewerId.toHexString(), role: 'user', status: 'active' }, session: { _id: viewerSessionId, id: viewerSessionId.toHexString(), userSessionVersion: 5 } }],
  ])
  return {
    authenticate: async ({ token }) => {
      const identity = identities.get(token)
      if (!identity) throw Object.assign(new Error('Authentication is required'), { status: 401, code: 'unauthorized' })
      return identity
    },
    verifyCsrf: async () => true,
  }
}

function baseDocuments() {
  return {
    users: [
      { _id: adminId, id: adminId.toHexString(), role: 'admin', status: 'active', sessionVersion: 3, createdAt: now, updatedAt: now },
      { _id: deletionUserId, id: deletionUserId.toHexString(), role: 'user', status: 'active', sessionVersion: 4, email: 'delete-me@example.test', preferences: { topics: ['ai'] }, createdAt: now, updatedAt: now },
      { _id: viewerId, id: viewerId.toHexString(), role: 'user', status: 'active', sessionVersion: 5, createdAt: now, updatedAt: now },
    ],
    sessions: [
      { _id: adminSessionId, userId: adminId, userSessionVersion: 3, status: 'active', expiresAt: new Date(now.getTime() + 86400000), absoluteExpiresAt: new Date(now.getTime() + 86400000), lastSeenAt: now },
      { _id: deletionSessionId, userId: deletionUserId, userSessionVersion: 4, status: 'active', expiresAt: new Date(now.getTime() + 86400000), absoluteExpiresAt: new Date(now.getTime() + 86400000), lastSeenAt: now },
      { _id: viewerSessionId, userId: viewerId, userSessionVersion: 5, status: 'active', expiresAt: new Date(now.getTime() + 86400000), absoluteExpiresAt: new Date(now.getTime() + 86400000), lastSeenAt: now },
    ],
    sources: [{ _id: sourceId, name: 'Nguon bien tap', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, technicalCheck: { status: 'passed' }, updatedAt: now }],
    articles: [{ _id: articleId, sourceId, connectorType: 'rss', status: 'published', evidenceEligible: true, version: 1, titleOriginal: 'Bai viet can takedown', originalUrl: 'https://example.test/article', canonicalUrl: 'https://example.test/article', canonicalUrlHash: 'b'.repeat(64), excerptOriginal: 'Noi dung cong khai.', publishedAt: now, searchTextNormalized: 'bai viet can takedown', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt', capturedAt: now }, createdAt: now, updatedAt: now }],
    chatSessions: [{ _id: chatId, userId: viewerId, scope: { articleId }, messageCount: 1, createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 86400000), messages: [{ id: 'assistant-1', role: 'assistant', status: 'answered', paragraphs: [{ text: 'Ket luan.', citationIds: ['C1'] }], citations: [{ id: 'C1', status: 'available', articleId, sourceId, originalUrl: 'https://example.test/article', titleOriginal: 'Bai viet can takedown', publishedAt: now }], refusalReason: null, createdAt: now }] }],
    savedArticles: [{ _id: new ObjectId('507f1f77bcf86cd799439710'), userId: deletionUserId, articleId }],
    answerAttempts: [{ _id: new ObjectId('507f1f77bcf86cd799439711'), userId: deletionUserId, sessionId: deletionSessionId, expectedSessionVersion: 4, status: 'reserved', expiresAt: new Date(now.getTime() + 86400000) }],
    rateLimitBuckets: [{ _id: new ObjectId('507f1f77bcf86cd799439712'), subjectType: 'user', keyHash: 'quota-1' }, { _id: new ObjectId('507f1f77bcf86cd799439713'), subjectType: 'user', keyHash: 'quota-2' }, { _id: new ObjectId('507f1f77bcf86cd799439714'), subjectType: 'ip', keyHash: 'shared-ip' }],
    adminAuditLogs: [], takedownRequests: [], accountDeletionRequests: [],
  }
}

function wireServices(mongo, authService) {
  const admission = { reserve: async () => ({ allowed: true }) }
  const governanceKeyring = keyring('governance')
  const quotaKeyring = { versions: [1, 2], digest: (_value, version) => `quota-${version}` }
  const takedownRepository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb, governanceKeyring, now: () => now })
  const accountDeletionRepository = new MongoAccountDeletionRepository({ db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb, governanceKeyring, quotaKeyring, now: () => now })
  const takedownService = createTakedownService({ repository: takedownRepository, rateLimitAdmission: admission, clock: () => now })
  const accountDeletionService = createAccountDeletionService({ repository: accountDeletionRepository, rateLimitAdmission: admission, clock: () => now })
  const chatRepository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
  const adminGovernanceService = {
    listTakedownRequests: ({ auth, query }) => takedownService.list({ auth, query }),
    getTakedownRequest: ({ auth, takedownRequestId }) => takedownService.get({ auth, takedownRequestId }),
    createTakedownRequest: ({ auth, input, request }) => takedownService.create({ auth, input, request }),
    updateTakedownRequest: ({ auth, takedownRequestId, input, request }) => takedownService.update({ auth, takedownRequestId, input, request }),
    listAccountDeletionRequests: ({ auth, query }) => accountDeletionService.list({ auth, query }).then(({ data, hasNext, nextCursor }) => ({ requests: data, hasNext, nextCursor })),
    getAccountDeletionRequest: ({ auth, deletionRequestId }) => accountDeletionService.get({ auth, deletionRequestId }),
    retryAccountDeletionRequest: ({ auth, deletionRequestId, input, idempotencyKey, request }) => accountDeletionService.retry({ auth, deletionRequestId, reasonCode: input.reasonCode, idempotencyKey, request }),
  }
  const qaService = {
    getChatSession: async ({ auth, chatSessionId }) => ({ session: await chatRepository.getChatSession({ actor: { userId: auth.user._id, sessionId: auth.session._id, sessionVersion: auth.session.userSessionVersion }, chatSessionId, now }) }),
  }
  const app = createApp({ authService, adminGovernanceService, accountDeletionService, qaService, allowedOrigins: 'http://localhost:3000' })
  return { app, takedownRepository, accountDeletionRepository }
}

async function json(response) {
  return response.json()
}

describe('Step 11 governance lifecycle', () => {
  let mongo
  let server
  let origin
  let services

  beforeAll(async () => {
    mongo = createStep11Mongo({ app: baseDocuments(), governance: { governanceSuppressions: [] } })
    services = wireServices(mongo, authFixture())
    server = await new Promise((resolve) => { const listener = services.app.listen(0, () => resolve(listener)) })
    origin = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)) })

  it('rejects an unauthenticated governance request at the HTTP boundary', async () => {
    const response = await fetch(`${origin}/api/v1/admin/takedown-requests`, { headers: { Origin: 'http://localhost:3000' } })
    expect(response.status).toBe(401)
  })

  it('runs takedown through HTTP transitions, bounded worker cleanup and public citation redaction', async () => {
    const adminHeaders = { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'step11-csrf', 'Content-Type': 'application/json' }
    const createdResponse = await fetch(`${origin}/api/v1/admin/takedown-requests`, { method: 'POST', headers: { ...adminHeaders, 'Idempotency-Key': 'step11-takedown-create' }, body: JSON.stringify({ requesterName: 'Rights team', requesterContact: 'rights@example.test', targetType: 'article', targetIds: [articleId.toHexString()], reason: 'Rights request', requestedScope: ['metadata'] }) })
    expect(createdResponse.status).toBe(201)
    const created = await json(createdResponse)
    const takedownId = created.data.id

    const reviewingResponse = await fetch(`${origin}/api/v1/admin/takedown-requests/${takedownId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'reviewing', reasonCode: 'takedown_review_started' }) })
    expect(reviewingResponse.status).toBe(200)
    const approvedResponse = await fetch(`${origin}/api/v1/admin/takedown-requests/${takedownId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'approved', reasonCode: 'takedown_approved' }) })
    expect(approvedResponse.status).toBe(200)
    expect((await mongo.db.collection('articles').findOne({ _id: articleId })).status).toBe('hidden')

    let cleanup
    do { cleanup = await services.takedownRepository.materializeCleanupBatch({ now, limit: 1 }) } while (cleanup.hasMore)
    expect(cleanup.completion).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true }))

    const completedResponse = await fetch(`${origin}/api/v1/admin/takedown-requests/${takedownId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'completed', reasonCode: 'takedown_completed' }) })
    expect(completedResponse.status).toBe(200)
    expect((await json(completedResponse)).data).toMatchObject({ status: 'completed', completion: { hidden: true, metadataRemoved: true, historicalChatCitationsRedacted: true } })

    const publicResponse = await fetch(`${origin}/api/v1/chat-sessions/${chatId.toHexString()}`, { headers: { Cookie: `__Host-techpulse_session=${viewerToken}` } })
    expect(publicResponse.status).toBe(200)
    const citation = (await json(publicResponse)).data.messages[0].citations[0]
    expect(citation).toEqual(expect.objectContaining({ status: 'unavailable', unavailableReason: 'takedown' }))
    expect(citation).not.toHaveProperty('originalUrl')
    expect(citation).not.toHaveProperty('titleOriginal')
    expect(await mongo.governanceDb.collection('governanceSuppressions').countDocuments({ kind: 'takedown' })).toBe(1)
  })

  it('runs account deletion through HTTP request/retry and worker crash recovery with seven flags', async () => {
    const userHeaders = { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${deletionToken}`, 'X-CSRF-Token': 'step11-csrf', 'Content-Type': 'application/json', 'Idempotency-Key': 'step11-delete-request' }
    const requestedResponse = await fetch(`${origin}/api/v1/me/deletion-requests`, { method: 'POST', headers: userHeaders, body: '{}' })
    expect(requestedResponse.status).toBe(202)
    const requested = await json(requestedResponse)
    const deletionId = requested.data.id
    expect(requested.data).not.toHaveProperty('userId')

    const answerAttempts = mongo.db.collection('answerAttempts')
    const originalDelete = answerAttempts.deleteMany.bind(answerAttempts)
    let crash = true
    answerAttempts.deleteMany = async (...args) => { if (crash) { crash = false; throw new Error('simulated worker crash') } return originalDelete(...args) }
    const queue = createAccountDeletionQueueAdapter({ repository: services.accountDeletionRepository, ownerToken: () => 'c'.repeat(64) })
    const failed = await queue.claimAndExecute({ candidate: await queue.selectDue({ now }), now })
    expect(failed).toEqual({ claimed: true, status: 'failed' })
    expect((await services.accountDeletionRepository.findById(deletionId)).completion).toEqual(expect.objectContaining({ sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false }))

    const adminHeaders = { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'step11-csrf', 'Content-Type': 'application/json', 'Idempotency-Key': 'step11-delete-retry' }
    const retryResponse = await fetch(`${origin}/api/v1/admin/account-deletion-requests/${deletionId}/retries`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ reasonCode: 'account_deletion_retry_requested' }) })
    expect(retryResponse.status).toBe(202)
    const completed = await queue.claimAndExecute({ candidate: await queue.selectDue({ now }), now })
    expect(completed).toEqual({ claimed: true, status: 'succeeded' })

    const finalResponse = await fetch(`${origin}/api/v1/admin/account-deletion-requests/${deletionId}`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    expect(finalResponse.status).toBe(200)
    expect((await json(finalResponse)).data).toMatchObject({ status: 'completed', completion: { sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: true, userQuotaDataDeleted: true, identityAnonymized: true } })
    expect(await mongo.db.collection('rateLimitBuckets').countDocuments({ subjectType: 'ip', keyHash: 'shared-ip' })).toBe(1)
    expect(await mongo.db.collection('users').findOne({ _id: deletionUserId })).toEqual(expect.objectContaining({ _id: deletionUserId, status: 'deleted', deletionRequestId: new ObjectId(deletionId) }))
    expect(await mongo.governanceDb.collection('governanceSuppressions').countDocuments({ kind: 'account-deletion' })).toBe(1)
  })
})
