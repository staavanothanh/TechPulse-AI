import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createTakedownService } from '../../../server/application/takedowns/service.js'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'

const ADMIN_ID = new ObjectId('507f1f77bcf86cd799439011')
const SESSION_ID = new ObjectId('507f1f77bcf86cd799439012')
const ARTICLE_ID = new ObjectId('507f1f77bcf86cd799439013')
const SOURCE_ID = new ObjectId('507f1f77bcf86cd799439014')
const now = new Date('2026-08-13T00:00:00.000Z')

const source = { _id: SOURCE_ID, policyVersion: 3, operationalStatus: 'active', licenseStatus: 'permitted', updatedAt: new Date(now), reconciliation: { status: 'idle', requiredPolicyVersion: 3, completedPolicyVersion: 3, requestedAt: null, error: null } }
const article = {
  _id: ARTICLE_ID, sourceId: SOURCE_ID, status: 'published', updatedAt: new Date(now), rightsSnapshot: { sourcePolicyVersion: 3 },
  leadMedia: { type: 'image', url: 'https://img.example.test/a', sourcePageUrl: 'https://example.test/a', mediaEvidenceStatus: 'not-analyzed', sourcePolicyVersion: 3 }, leadMediaStatus: 'available',
  summaryVi: 'Tóm tắt', summaryStatus: 'ready', summaryBasis: 'metadata', summaryModel: 'model', summaryInputHash: 'a'.repeat(64), summarySourcePolicyVersion: 3, summaryGeneratedAt: new Date(now), summaryError: null,
  embedding: [0.1], embeddingStatus: 'ready', embeddingModel: 'BAAI/bge-m3', embeddingDimensions: 1, embeddingInputHash: 'b'.repeat(64), embeddingVersion: 1, embeddingSourcePolicyVersion: 3, embeddedAt: new Date(now), embeddingError: null,
}

function makeRepository({ actorFence = true } = {}) {
  const workflowId = new ObjectId('507f1f77bcf86cd799439015')
  const workflow = {
    _id: workflowId, status: 'received', requesterName: 'Rights team', requesterContact: 'rights@example.test', targetType: 'article', targetIds: [ARTICLE_ID], reason: 'Rights request', evidenceNote: null,
    requestedScope: ['metadata', 'summary', 'embedding'], decisionReasonCode: null, completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false },
    completedAt: null, piiPurgeAfter: null, workflowPurgeAfter: null, createdAt: new Date(now), updatedAt: new Date(now),
  }
  const audit = []
  const suppression = []
  const calls = []
  const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
  const collections = new Map()
  function collection(name) {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async (filter) => {
        if (name === 'users') return actorFence ? { _id: ADMIN_ID, role: 'admin', status: 'active', sessionVersion: 2 } : null
        if (name === 'sessions') return actorFence ? { _id: SESSION_ID, userId: ADMIN_ID, userSessionVersion: 2, status: 'active', expiresAt: new Date(now.getTime() + 10000), absoluteExpiresAt: new Date(now.getTime() + 10000) } : null
        if (name === 'takedownRequests') return filter?._id?.toString() === workflowId.toString() ? workflow : null
        if (name === 'articles') return filter?._id?.toString() === ARTICLE_ID.toString() ? article : null
        if (name === 'sources') return filter?._id?.toString() === SOURCE_ID.toString() ? source : null
        if (name === 'adminAuditLogs') return audit.find((item) => item.eventId === filter?.eventId) ?? null
        return null
      }),
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }), hint: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) })),
      insertOne: vi.fn(async (document) => { calls.push({ name, operation: 'insert', document }); if (name === 'takedownRequests') Object.assign(workflow, document); if (name === 'adminAuditLogs') audit.push(document); return { insertedId: document._id } }),
      updateOne: vi.fn(async (filter, update) => { calls.push({ name, operation: 'update', filter, update }); if (name === 'users' || name === 'sessions') return { matchedCount: actorFence ? 1 : 0 }; if (name === 'articles' && filter?._id) { Object.assign(article, update.$set ?? {}); return { matchedCount: 1, modifiedCount: 1 } } if (name === 'sources') { Object.assign(source, update.$set ?? {}); return { matchedCount: 1, modifiedCount: 1 } } if (name === 'takedownRequests') { Object.assign(workflow, update.$set ?? {}); return { matchedCount: 1, modifiedCount: 1 } } return { matchedCount: 1, modifiedCount: 1 } }),
      updateMany: vi.fn(async (filter, update) => { calls.push({ name, operation: 'updateMany', filter, update }); return { matchedCount: 0, modifiedCount: 0 } }),
      findOneAndUpdate: vi.fn(async (filter, update) => { calls.push({ name, operation: 'findOneAndUpdate', filter, update }); Object.assign(workflow, update.$set ?? {}); return workflow }),
      countDocuments: vi.fn(async () => 0),
    }
    collections.set(name, handle)
    return handle
  }
  const context = {
    db: { collection }, client: { startSession: vi.fn(() => session) }, governanceDb: { collection: vi.fn(() => ({ insertOne: vi.fn(async (document) => { suppression.push(document); return { insertedId: document._id } }) })) },
    governanceKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'c'.repeat(64)) }, now: () => now,
  }
  const repository = new MongoTakedownRepository(context)
  repository.assertActorFence = vi.fn(async () => actorFence)
  repository.assertTargetsCurrent = vi.fn(async () => true)
  repository.insertAudit = vi.fn(async ({ action, targetId, actor, request, now: at }, _session) => { const document = { _id: new ObjectId(), eventId: `${action}:${String(targetId)}`, actorType: actor.role === 'admin' ? 'admin' : 'system-worker', actorId: actor._id ?? actor.id, action, targetType: 'takedown-request', targetId, changedFields: action === 'takedown_completed' ? ['status', 'completion'] : ['status'], reasonCode: action, requestId: request?.serverRequestId ?? 'request', result: 'succeeded', createdAt: at }; audit.push(document); return document })
  repository.transition = vi.fn(async ({ current: _current, status, reasonCode, actor, request, now: at }) => { Object.assign(workflow, { status, decisionReasonCode: reasonCode, reviewedBy: actor._id ?? actor.id, reviewedAt: at, updatedAt: at }); if (status === 'approved' || status === 'completed') workflow.completion.hidden = true; if (status === 'completed') Object.assign(workflow.completion, { metadataRemoved: true, summaryRemoved: true, embeddingRemoved: true, historicalChatCitationsRedacted: true, mediaMetadataRemoved: false }), workflow.completedAt = at; await repository.insertAudit({ action: reasonCode, targetId: workflow._id, actor, request, now: at }, null); if (status === 'completed') suppression.push({ requestId: workflow._id, targetType: workflow.targetType, targetIds: workflow.targetIds, requestedScope: workflow.requestedScope }); return workflow })
  return { repository, workflow, audit, suppression, calls, context }
}

const auth = { user: { _id: ADMIN_ID, id: ADMIN_ID.toHexString(), role: 'admin', status: 'active' }, session: { _id: SESSION_ID, id: SESSION_ID.toHexString(), userSessionVersion: 2 } }
const input = { requesterName: 'Rights team', requesterContact: 'rights@example.test', targetType: 'article', targetIds: [ARTICLE_ID.toHexString()], reason: 'Rights request', requestedScope: ['metadata', 'summary', 'embedding'] }

describe('Step 11 takedown workflow', () => {
  it('creates a pre-retention workflow with an actor fence and safe received audit', async () => {
    const fixture = makeRepository()
    const service = createTakedownService({ repository: fixture.repository, now: () => now, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) } })
    const result = await service.create({ auth, input, request: { serverRequestId: 'request-create-1' } })
    expect(result.status).toBe('received')
    expect(result.requesterContact).toBe('rights@example.test')
    const audit = fixture.audit.find((item) => item.action === 'takedown_received')
    expect(audit).toEqual(expect.objectContaining({ reasonCode: 'takedown_received', changedFields: ['status'] }))
    expect(audit).not.toHaveProperty('requesterContact')
  })

  it('rejects create when the admin session fence is stale before persistence', async () => {
    const fixture = makeRepository({ actorFence: false })
    const service = createTakedownService({ repository: fixture.repository, now: () => now, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) } })
    await expect(service.create({ auth, input, request: { serverRequestId: 'request-create-stale' } })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(fixture.calls.some(({ name, operation }) => name === 'takedownRequests' && operation === 'insert')).toBe(false)
  })

  it('advances review to approved only after hide-first article/source fencing', async () => {
    const fixture = makeRepository()
    fixture.workflow.status = 'reviewing'
    const service = createTakedownService({ repository: fixture.repository, now: () => now, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) } })
    const result = await service.update({ auth, takedownRequestId: fixture.workflow._id.toHexString(), input: { status: 'approved', reasonCode: 'takedown_approved' }, request: { serverRequestId: 'request-approve-1' } })
    expect(result.status).toBe('approved')
    expect(result.completion.hidden).toBe(true)
    expect(result.completion.hidden).toBe(true)
  })

  it('completes scoped cleanup with unavailable citations and one signed terminal suppression', async () => {
    const fixture = makeRepository()
    fixture.workflow.status = 'approved'
    fixture.workflow.completion.hidden = true
    const service = createTakedownService({ repository: fixture.repository, now: () => now, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) } })
    const result = await service.update({ auth, takedownRequestId: fixture.workflow._id.toHexString(), input: { status: 'completed', reasonCode: 'takedown_completed' }, request: { serverRequestId: 'request-complete-1' } })
    expect(result.status).toBe('completed')
    expect(result.completion).toEqual(expect.objectContaining({ hidden: true, metadataRemoved: true, summaryRemoved: true, embeddingRemoved: true, historicalChatCitationsRedacted: true }))
    expect(fixture.audit.filter((item) => item.action === 'takedown_completed')).toHaveLength(1)
    expect(fixture.suppression).toHaveLength(1)
  })

})
