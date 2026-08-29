import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createSourceAuditEvent } from '../../../server/audit/source-writer.js'
import { MongoSourceRepository } from '../../../server/repositories/mongo/source-repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const actorId = new ObjectId('507f1f77bcf86cd799439012')
const sessionId = new ObjectId('507f1f77bcf86cd799439013')
const now = new Date('2026-08-29T01:00:00.000Z')

function audit() {
  return createSourceAuditEvent({
    actor: { id: actorId.toHexString(), role: 'admin' },
    action: 'source_policy_reconciliation_requested',
    targetId: sourceId.toHexString(),
    changedFields: ['reconciliation'],
    reasonCode: 'source_policy_reconciliation_requested',
    request: { serverRequestId: 'reconciliation-key-1', idempotencyKey: 'reconciliation-key-1', actorSessionId: sessionId.toHexString(), requestHash: 'a'.repeat(64) },
    result: 'pending',
    createdAt: now,
  })
}

function mongoFixture() {
  return createStep11Mongo({ app: {
    users: [{ _id: actorId, role: 'admin', status: 'active', sessionVersion: 1 }],
    sessions: [{ _id: sessionId, userId: actorId, userSessionVersion: 1, status: 'active', expiresAt: new Date(Date.now() + 60_000), absoluteExpiresAt: new Date(Date.now() + 60_000) }],
    adminAuditLogs: [],
  } })
}

describe('source reconciliation audit repository', () => {
  it('claims a request append-only and returns the same identity on replay', async () => {
    const mongo = mongoFixture()
    const repository = new MongoSourceRepository({ db: mongo.db, client: mongo.client })
    const input = audit()
    const actorFence = { userId: actorId.toHexString(), sessionId: sessionId.toHexString(), sessionVersion: 1 }
    const reserve = vi.fn(async ({ scope, subject, session }) => ({ allowed: Boolean(scope === 'admin-trigger' && subject === actorId.toHexString() && session) }))
    const rateLimitAdmission = { reserve }

    const admission = { scope: 'admin-trigger', subject: actorId.toHexString() }
    const first = await repository.commitReconciliationAudit({ audit: input, actorFence, rateLimitAdmission, admission })
    const found = await repository.findReconciliationRequest({ actorId: actorId.toHexString(), requestId: 'reconciliation-key-1' })
    const replay = await repository.commitReconciliationAudit({ audit: input, actorFence, rateLimitAdmission, admission })

    expect(first).toEqual(expect.objectContaining({ replay: false, document: expect.objectContaining({ eventId: input.eventId, result: 'pending' }) }))
    expect(found).toEqual(expect.objectContaining({ eventId: input.eventId, targetId: sourceId, actorId }))
    expect(replay).toEqual(expect.objectContaining({ replay: true, document: expect.objectContaining({ eventId: input.eventId }) }))
    expect(await mongo.db.collection('adminAuditLogs').countDocuments({})).toBe(1)
    expect(reserve).toHaveBeenCalledOnce()
  })

  it('retries the atomic audit+admission transaction on a rate-bucket duplicate-key race', async () => {
    const mongo = mongoFixture()
    const repository = new MongoSourceRepository({ db: mongo.db, client: mongo.client })
    const input = audit()
    const actorFence = { userId: actorId.toHexString(), sessionId: sessionId.toHexString(), sessionVersion: 1 }
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }
    const admission = { scope: 'admin-trigger', subject: actorId.toHexString() }
    let attempts = 0
    repository.withTransaction = async (work) => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('duplicate key'), { code: 11000 })
      return work({})
    }

    const committed = await repository.commitReconciliationAudit({ audit: input, actorFence, rateLimitAdmission, admission })

    expect(attempts).toBe(2)
    expect(committed).toEqual(expect.objectContaining({ replay: false, document: expect.objectContaining({ eventId: input.eventId }) }))
    expect(await mongo.db.collection('adminAuditLogs').countDocuments({})).toBe(1)
  })

  it('surfaces a persistent quota race after bounded retries', async () => {
    const mongo = mongoFixture()
    const repository = new MongoSourceRepository({ db: mongo.db, client: mongo.client })
    const input = audit()
    const actorFence = { userId: actorId.toHexString(), sessionId: sessionId.toHexString(), sessionVersion: 1 }
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }
    const admission = { scope: 'admin-trigger', subject: actorId.toHexString() }
    let attempts = 0
    repository.withTransaction = async () => {
      attempts += 1
      throw Object.assign(new Error('duplicate key'), { code: 11000 })
    }

    await expect(repository.commitReconciliationAudit({ audit: input, actorFence, rateLimitAdmission, admission })).rejects.toMatchObject({ code: 11000 })
    expect(attempts).toBe(3)
  })
})
