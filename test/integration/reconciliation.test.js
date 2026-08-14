import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoAdminRepository } from '../../server/repositories/mongo/admin-repository.js'

describe('Step 11 reconciliation integration', () => {
  it('writes article, reconciliation intent and audit under the same transaction session', async () => {
    const articleId = new ObjectId('507f1f77bcf86cd799439010')
    const sourceId = new ObjectId('507f1f77bcf86cd799439011')
    const article = { _id: articleId, sourceId, status: 'published', topics: ['AI'], rightsSnapshot: { sourcePolicyVersion: 2 }, updatedAt: new Date('2026-08-13T00:00:00.000Z') }
    const session = { transaction: 'step11-reconciliation', withTransaction: async (work) => work(), endSession: async () => {} }
    const articleUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const jobUpdate = vi.fn(async () => ({ upsertedCount: 1 }))
    const auditInsert = vi.fn(async () => ({ insertedId: new ObjectId() }))
    const collections = new Map([
      ['articles', { findOne: vi.fn(async () => article), updateOne: articleUpdate }],
      ['sources', { findOne: vi.fn(async () => ({ _id: sourceId, policyVersion: 2, updatedAt: article.updatedAt })), updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['users', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['sessions', { updateOne: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['indexingJobs', { updateOne: jobUpdate }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: auditInsert }],
    ])
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => session }, now: () => new Date('2026-08-13T00:01:00.000Z') })

    await repository.updateAdminArticle(articleId.toHexString(), {
      category: 'topics', value: ['security'], actor: { id: '507f1f77bcf86cd799439001' },
      actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 },
      reasonCode: 'article_topics_changed', request: { serverRequestId: 'step11-reconciliation' },
      rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
    })

    expect(articleUpdate).toHaveBeenCalledWith(expect.anything(), expect.anything(), { session })
    expect(jobUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $setOnInsert: expect.objectContaining({ task: 'visibility-reconcile', trigger: 'admin' }) }), { upsert: true, session })
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'article_topics_changed', changedFields: ['topics'] }), { session })
  })
})
