import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app.js'
import { ARTICLE_PROJECTION, MongoAdminRepository } from '../../../server/repositories/mongo/admin-repository.js'

const adminToken = 'admin-remediation-session'
const adminAuthService = {
  authenticate: vi.fn(async () => ({ user: { id: '507f1f77bcf86cd799439001', role: 'admin', status: 'active' }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 4 } })),
  verifyCsrf: vi.fn(async () => true),
}
const allowAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }

describe('Step 11 backend remediation regressions', () => {
  it('validates the full AdminOverview response at the HTTP boundary', async () => {
    const app = createApp({
      authService: adminAuthService,
      adminGovernanceService: { getAdminOverview: vi.fn(async () => ({ activeSources: 'not-an-integer' })) },
    })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/overview`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
      expect(response.status).toBe(500)
      expect((await response.json()).error.code).toBe('internal_error')
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })

  it('uses a valid Mongo inclusion projection without mixed include/exclude fields', () => {
    const keys = Object.entries(ARTICLE_PROJECTION).filter(([key]) => key !== '_id')
    const includes = keys.filter(([, value]) => value === 1)
    const excludes = keys.filter(([, value]) => value === 0)
    expect(includes.length).toBeGreaterThan(0)
    expect(excludes).toHaveLength(0)
  })

  it('fences article mutation in a transaction against active admin and session version', async () => {
    const article = { _id: { toHexString: () => '507f1f77bcf86cd799439010' }, sourceId: '507f1f77bcf86cd799439011', rightsSnapshot: { sourcePolicyVersion: 1 }, updatedAt: new Date('2026-01-01'), status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none' }
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }))
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => article), updateOne }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => ({})) }],
    ])
    const session = {}
    const client = { startSession: vi.fn(() => ({ withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) })) }
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client, now: () => new Date('2026-01-02') })
    await repository.updateAdminArticle(article._id.toHexString(), { category: 'topics', value: ['security'], actor: { id: '507f1f77bcf86cd799439001', role: 'admin' }, actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 }, reasonCode: 'article_topics_changed', request: { serverRequestId: 'admin-remediation-1' }, rateLimitAdmission: allowAdmission })
    expect(client.startSession).toHaveBeenCalledTimes(1)
    expect(collections.get('users').updateOne).toHaveBeenCalled()
    expect(collections.get('sessions').updateOne).toHaveBeenCalled()
  })

  it('aborts the article mutation when deterministic audit persistence is denied', async () => {
    const article = { _id: { toHexString: () => '507f1f77bcf86cd799439010' }, sourceId: '507f1f77bcf86cd799439011', rightsSnapshot: { sourcePolicyVersion: 1 }, updatedAt: new Date('2026-01-01'), status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none' }
    const articleUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const audit = { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => { throw new Error('audit write denied') }) }
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => article), updateOne: articleUpdate }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['adminAuditLogs', audit],
    ])
    const session = {}
    const client = { startSession: vi.fn(() => ({ withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) })) }
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client, now: () => new Date('2026-01-02') })
    await expect(repository.updateAdminArticle(article._id.toHexString(), { category: 'topics', value: ['security'], actor: { id: '507f1f77bcf86cd799439001', role: 'admin' }, actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 }, reasonCode: 'article_topics_changed', request: { serverRequestId: 'admin-remediation-audit-denied' }, rateLimitAdmission: allowAdmission })).rejects.toThrow('audit write denied')
    expect(articleUpdate).toHaveBeenCalled()
    expect(audit.insertOne).toHaveBeenCalledTimes(1)
  })

  it('atomically records reconciliation intent for visibility and topic mutations', async () => {
    const article = { _id: { toHexString: () => '507f1f77bcf86cd799439010' }, sourceId: '507f1f77bcf86cd799439011', rightsSnapshot: { sourcePolicyVersion: 1 }, updatedAt: new Date('2026-01-01'), status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none' }
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }))
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => article), updateOne }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => ({})) }],
      ['indexingJobs', { updateOne: vi.fn(async () => ({ upsertedCount: 1 })) }],
    ])
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => ({ withTransaction: async (work) => work({}), endSession: async () => {} }) }, now: () => new Date('2026-01-02') })

    await repository.updateAdminArticle(article._id.toHexString(), { category: 'status', value: 'hidden', actor: { id: '507f1f77bcf86cd799439001' }, actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 }, reasonCode: 'article_status_changed', request: { serverRequestId: 'admin-remediation-reconcile-1' }, rateLimitAdmission: allowAdmission })

    expect(collections.get('indexingJobs').updateOne).toHaveBeenCalledWith(expect.objectContaining({ actorScope: expect.stringContaining('admin:'), idempotencyKey: expect.stringContaining('admin:') }), expect.objectContaining({ $setOnInsert: expect.objectContaining({ articleId: expect.anything(), task: 'visibility-reconcile', trigger: 'admin', status: 'queued', expectedSourcePolicyVersion: expect.any(Number) }) }), expect.objectContaining({ upsert: true, session: expect.anything() }))
    expect(collections.get('indexingJobs').updateOne.mock.calls[0][1].$setOnInsert).not.toHaveProperty('reasonCode')
  })

  it('rejects duplicate merge idempotency reuse when the duplicate set changes', async () => {
    const canonicalId = '507f1f77bcf86cd799439010'
    const prior = { eventId: 'admin:duplicate_merge_confirmed:507f1f77bcf86cd799439010:merge-key-123:507f1f77bcf86cd799439001:prior', targetId: canonicalId, requestId: 'merge-key-123', action: 'duplicate_merge_confirmed', actorId: '507f1f77bcf86cd799439001' }
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => ({ _id: { toHexString: () => canonicalId }, updatedAt: new Date('2026-01-01') })) }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => prior), insertOne: vi.fn(async () => ({})) }],
    ])
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => ({ withTransaction: async (work) => work({}), endSession: async () => {} }) }, now: () => new Date('2026-01-02') })

    await expect(repository.mergeDuplicateArticles({
      canonicalArticleId: canonicalId,
      duplicateArticleIds: ['507f1f77bcf86cd799439012'],
      actor: { id: '507f1f77bcf86cd799439001' },
      actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 },
      reasonCode: 'duplicate_merge_confirmed',
      idempotencyKey: 'merge-key-123',
      request: { serverRequestId: 'admin-merge-replay' },
      rateLimitAdmission: allowAdmission,
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
  })

  it('fences duplicate merge against the current source lifecycle before article writes', async () => {
    const canonicalId = new (await import('mongodb')).ObjectId('507f1f77bcf86cd799439010')
    const duplicateId = new (await import('mongodb')).ObjectId('507f1f77bcf86cd799439012')
    const sourceId = new (await import('mongodb')).ObjectId('507f1f77bcf86cd799439011')
    const canonical = { _id: canonicalId, sourceId, rightsSnapshot: { sourcePolicyVersion: 3, licenseStatus: 'permitted', llmInputScope: 'excerpt' }, updatedAt: new Date('2026-01-01'), provenance: [], status: 'published' }
    const duplicate = { _id: duplicateId, sourceId, rightsSnapshot: canonical.rightsSnapshot, updatedAt: new Date('2026-01-01'), provenance: [], status: 'published' }
    const articleUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const articleUpdateMany = vi.fn(async () => ({ matchedCount: 1 }))
    const sourceUpdate = vi.fn(async () => ({ matchedCount: 0 }))
    const collections = new Map([
      ['articles', {
        findOne: vi.fn(async ({ _id }) => _id?.equals?.(canonicalId) ? canonical : _id?.equals?.(duplicateId) ? duplicate : null),
        find: vi.fn(() => ({ toArray: vi.fn(async () => [duplicate]) })), updateOne: articleUpdate, updateMany: articleUpdateMany,
      }],
      ['sources', { findOne: vi.fn(async () => ({ _id: sourceId, policyVersion: 3, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'excerpt', updatedAt: new Date('2026-01-01') })), updateOne: sourceUpdate }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => ({})) }],
    ])
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => ({ withTransaction: async (work) => work({}), endSession: async () => {} }) }, now: () => new Date('2026-01-02') })

    await expect(repository.mergeDuplicateArticles({ canonicalArticleId: canonicalId.toHexString(), duplicateArticleIds: [duplicateId.toHexString()], actor: { id: '507f1f77bcf86cd799439001' }, actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 }, reasonCode: 'duplicate_merge_confirmed', idempotencyKey: 'merge-source-fence-1', request: { serverRequestId: 'admin-merge-source-fence' }, rateLimitAdmission: allowAdmission })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(sourceUpdate).toHaveBeenCalled()
    expect(articleUpdate).not.toHaveBeenCalled()
    expect(articleUpdateMany).not.toHaveBeenCalled()
  })

  it('fails closed before article writes when admin admission is missing or unavailable', async () => {
    const article = { _id: { toHexString: () => '507f1f77bcf86cd799439010' }, sourceId: '507f1f77bcf86cd799439011', rightsSnapshot: { sourcePolicyVersion: 1 }, updatedAt: new Date('2026-01-01'), status: 'published', topics: ['AI'] }
    const articleUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => article), updateOne: articleUpdate }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
    ])
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => ({ withTransaction: async (work) => work({}), endSession: async () => {} }) }, now: () => new Date('2026-01-02') })
    const input = { category: 'topics', value: ['security'], actor: { id: '507f1f77bcf86cd799439001' }, actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 }, reasonCode: 'article_topics_changed', request: { serverRequestId: 'admin-admission-fail-closed' } }

    await expect(repository.updateAdminArticle(article._id.toHexString(), input)).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    await expect(repository.updateAdminArticle(article._id.toHexString(), { ...input, rateLimitAdmission: { reserve: vi.fn(async () => { throw new Error('private limiter failure') }) } })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(articleUpdate).not.toHaveBeenCalled()
  })
})
