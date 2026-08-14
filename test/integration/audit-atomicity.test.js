import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoAdminRepository } from '../../server/repositories/mongo/admin-repository.js'
import { MongoTakedownRepository } from '../../server/repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../../server/repositories/mongo/account-deletion-repository.js'

describe('Step 11 audit atomicity integration', () => {
  it('rolls back the domain mutation when the mandatory audit write is denied', async () => {
    const articleId = new ObjectId('507f1f77bcf86cd799439010')
    const sourceId = new ObjectId('507f1f77bcf86cd799439011')
    const state = {
      article: { _id: articleId, sourceId, status: 'published', topics: ['AI'], rightsSnapshot: { sourcePolicyVersion: 3 }, updatedAt: new Date('2026-08-13T00:00:00.000Z') },
    }
    const stage = (session, change) => { session.changes.push(change); return { matchedCount: 1 } }
    const session = {
      changes: [],
      withTransaction: async (work) => {
        session.changes = []
        try { await work() } catch (error) { session.changes = []; throw error }
        for (const change of session.changes) change()
      },
      endSession: async () => {},
    }
    const collections = new Map([
      ['articles', {
        findOne: vi.fn(async () => ({ ...state.article })),
        updateOne: vi.fn(async (_filter, update, options) => stage(options.session, () => { state.article = { ...state.article, ...update.$set } })),
      }],
      ['sources', {
        findOne: vi.fn(async () => ({ _id: sourceId, policyVersion: 3, updatedAt: new Date('2026-08-13T00:00:00.000Z') })),
        updateOne: vi.fn(async (_filter, _update, options) => stage(options.session, () => {})),
      }],
      ['users', { updateOne: vi.fn(async (_filter, _update, options) => stage(options.session, () => {})) }],
      ['sessions', { updateOne: vi.fn(async (_filter, _update, options) => stage(options.session, () => {})) }],
      ['indexingJobs', { updateOne: vi.fn(async (_filter, _update, options) => stage(options.session, () => {})) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async () => { throw new Error('audit permission denied') }) }],
    ])
    const client = { startSession: () => session }
    const repository = new MongoAdminRepository({ db: { collection: (name) => collections.get(name) }, client, now: () => new Date('2026-08-13T00:01:00.000Z') })

    await expect(repository.updateAdminArticle(articleId.toHexString(), {
      category: 'status', value: 'hidden', actor: { id: '507f1f77bcf86cd799439001' },
      actorFence: { userId: '507f1f77bcf86cd799439001', sessionId: '507f1f77bcf86cd799439002', sessionVersion: 4 },
      reasonCode: 'article_status_changed', request: { serverRequestId: 'step11-audit-atomicity' },
      rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
    })).rejects.toThrow('audit permission denied')

    expect(state.article.status).toBe('published')
    expect(collections.get('adminAuditLogs').insertOne).toHaveBeenCalledTimes(1)
  })

  it('rolls back terminal takedown state and audit when suppression persistence is denied', async () => {
    const requestId = new ObjectId('507f1f77bcf86cd799439020')
    const targetId = new ObjectId('507f1f77bcf86cd799439021')
    const actorId = new ObjectId('507f1f77bcf86cd799439022')
    const state = { status: 'approved', audits: [] }
    const session = {
      changes: [],
      withTransaction: async (work) => {
        session.changes = []
        try { await work() } catch (error) { session.changes = []; throw error }
        for (const change of session.changes) change()
      },
      endSession: async () => {},
    }
    const workflow = { _id: requestId, status: 'approved', targetType: 'article', targetIds: [targetId], requestedScope: ['metadata'], completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true } }
    const collections = new Map([
      ['articles', { updateMany: vi.fn(async () => ({ matchedCount: 1 })) }],
      ['takedownRequests', { findOneAndUpdate: vi.fn(async (_filter, update, options) => { options.session.changes.push(() => { state.status = update.$set.status }); return { ...workflow, ...update.$set } }) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async (document, options) => { options.session.changes.push(() => state.audits.push(document)); return { insertedId: document._id } }) }],
    ])
    const repository = new MongoTakedownRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => session }, governanceDb: { collection: () => ({ insertOne: vi.fn(async () => { throw new Error('suppression permission denied') }) }) }, governanceKeyring: { currentVersion: 1, versions: [1], digest: () => 'a'.repeat(64) }, now: () => new Date('2026-08-14T00:00:00.000Z') })

    await expect(repository.withTransaction((transaction) => repository.transition({ current: workflow, status: 'completed', reasonCode: 'takedown_completed', actor: { _id: actorId }, request: { serverRequestId: 'takedown-terminal-denied' }, session: transaction, now: new Date('2026-08-14T00:00:00.000Z') }))).rejects.toThrow('suppression permission denied')

    expect(state.status).toBe('approved')
    expect(state.audits).toHaveLength(0)
  })

  it('rolls back account-deletion completion and audit when suppression persistence is denied', async () => {
    const requestId = new ObjectId('507f1f77bcf86cd799439030')
    const userId = new ObjectId('507f1f77bcf86cd799439031')
    const state = { status: 'running', audits: [] }
    const session = {
      changes: [],
      withTransaction: async (work) => {
        session.changes = []
        try { await work() } catch (error) { session.changes = []; throw error }
        for (const change of session.changes) change()
      },
      endSession: async () => {},
    }
    const collections = new Map([
      ['accountDeletionRequests', { updateOne: vi.fn(async (_filter, update, options) => { options.session.changes.push(() => { state.status = update.$set.status }); return { matchedCount: 1 } }) }],
      ['adminAuditLogs', { findOne: vi.fn(async () => null), insertOne: vi.fn(async (document, options) => { options.session.changes.push(() => state.audits.push(document)); return { insertedId: document._id } }) }],
    ])
    const keyring = { currentVersion: 1, versions: [1], digest: () => 'b'.repeat(64) }
    const repository = new MongoAccountDeletionRepository({ db: { collection: (name) => collections.get(name) }, client: { startSession: () => session }, governanceDb: { collection: () => ({ insertOne: vi.fn(async () => { throw new Error('suppression permission denied') }) }) }, quotaKeyring: keyring, governanceKeyring: keyring })
    const completion = Object.fromEntries(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'].map((field) => [field, true]))
    const job = { _id: requestId, userId, status: 'running', leaseGeneration: 2, leaseOwner: 'c'.repeat(64), attempt: 1 }

    await expect(repository.complete({ job, completion, now: new Date('2026-08-14T00:00:00.000Z') })).rejects.toThrow('suppression permission denied')

    expect(state.status).toBe('running')
    expect(state.audits).toHaveLength(0)
  })
})
