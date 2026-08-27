import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoSourceRepository, serializeSource } from '../../../server/repositories/mongo/source-repository.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const userId = new ObjectId('507f1f77bcf86cd799439012')
const sessionId = new ObjectId('507f1f77bcf86cd799439013')
const createdAt = new Date('2026-08-20T08:00:00.000Z')
const updatedAt = new Date('2026-08-20T09:00:00.000Z')

function sourceData(overrides = {}) {
  return {
    id: sourceId.toHexString(),
    name: 'Example Source',
    sourceKey: 'rss:example',
    publisherName: 'Example Publisher',
    domain: 'example.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    operationalStatus: 'draft',
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { metadata: false, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    attributionRequired: false,
    attributionText: null,
    termsUrl: null,
    licenseUrl: null,
    evidenceNote: null,
    reviewedAt: null,
    reviewedBy: null,
    policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt,
    updatedAt,
    ...overrides,
  }
}

function document(overrides = {}) {
  const source = sourceData(overrides)
  const { id, ...rest } = source
  return { ...rest, _id: sourceId }
}

function audit(overrides = {}) {
  return {
    eventId: 'source-audit-1',
    actorType: 'admin',
    actorId: userId,
    action: 'source_created',
    targetType: 'source',
    targetId: sourceId,
    changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'],
    reasonCode: 'source_created',
    requestId: 'request-1',
    result: 'succeeded',
    createdAt: createdAt,
    ...overrides,
  }
}

function cursor(values = []) {
  const result = {
    sort: vi.fn(() => result),
    limit: vi.fn(() => result),
    toArray: vi.fn(async () => values),
  }
  return result
}

function createContext({ findOne = {}, findResults = {}, updateResults = {}, insertResults = {}, replaceResults = {}, session = null } = {}) {
  const collections = new Map()
  const take = (input, name, fallback) => {
    const queue = input[name]
    return Array.isArray(queue) && queue.length > 0 ? queue.shift() : fallback
  }
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async () => take(findOne, name, null)),
      find: vi.fn(() => cursor(take(findResults, name, []))),
      updateOne: vi.fn(async () => take(updateResults, name, { matchedCount: 1 })),
      insertOne: vi.fn(async () => take(insertResults, name, { acknowledged: true })),
      replaceOne: vi.fn(async () => take(replaceResults, name, { matchedCount: 1 })),
    }
    collections.set(name, handle)
    return handle
  }
  const transactionSession = session ?? {
    withTransaction: vi.fn(async (work) => work(transactionSession)),
    endSession: vi.fn(async () => {}),
  }
  const context = { db: { collection }, client: { startSession: vi.fn(() => transactionSession) } }
  return { repository: new MongoSourceRepository(context), context, collections, session: transactionSession }
}

function actorFence() {
  return { userId, sessionId, sessionVersion: 2 }
}

describe('MongoSourceRepository lifecycle', () => {
  it('serializes public source fields without internal identifiers or mutable aliases', () => {
    const internal = document({ reviewedBy: userId, qnaFenceToken: 'private-token' })
    const serialized = serializeSource(internal)
    expect(serialized).toEqual(expect.objectContaining({ id: sourceId.toHexString(), reviewedBy: userId.toHexString() }))
    expect(serialized).not.toHaveProperty('_id')
    expect(serialized).not.toHaveProperty('qnaFenceToken')
    serialized.mediaPolicy.allowedHosts.push('mutated.example.com')
    expect(internal.mediaPolicy.allowedHosts).toEqual([])
  })

  it('runs actor-fenced create and failed-audit transactions', async () => {
    const fixture = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [null] } })
    await expect(fixture.repository.commitCreate({ source: sourceData(), audit: audit(), actorFence: actorFence() })).resolves.toEqual(sourceData())
    expect(fixture.collections.get('sources').insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: sourceId }), { session: fixture.session })
    expect(fixture.collections.get('adminAuditLogs').insertOne).toHaveBeenCalled()

    const failed = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [null] } })
    await expect(failed.repository.commitFailedAudit({ audit: audit({ result: 'failed' }), actorFence: actorFence() })).resolves.toEqual(expect.objectContaining({ eventId: 'source-audit-1' }))
    const unauthorized = createContext({ findOne: { users: [null] } })
    await expect(unauthorized.repository.commitCreate({ source: sourceData(), audit: audit(), actorFence: actorFence() })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    await expect(unauthorized.repository.assertActorFence({ userId, sessionId, sessionVersion: 1 }, unauthorized.session)).resolves.toBe(false)
  })

  it('seeds drafts idempotently and handles duplicate races', async () => {
    const existing = createContext({ findOne: { sources: [document()] } })
    await expect(existing.repository.seedDraft({ source: sourceData(), audit: audit() })).resolves.toEqual(expect.objectContaining({ seeded: false, existing: true }))

    const created = createContext({ findOne: { sources: [null], adminAuditLogs: [null] } })
    await expect(created.repository.seedDraft({ source: sourceData(), audit: audit() })).resolves.toEqual(expect.objectContaining({ seeded: true, existing: false }))

    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 })
    const race = createContext({ findOne: { sources: [null, document()] }, insertResults: { sources: [Promise.reject(duplicate)] } })
    await expect(race.repository.seedDraft({ source: sourceData(), audit: audit() })).resolves.toEqual(expect.objectContaining({ seeded: false, existing: true }))
    const missing = createContext({ findOne: { sources: [null, null] }, insertResults: { sources: [Promise.reject(duplicate)] } })
    await expect(missing.repository.seedDraft({ source: sourceData(), audit: audit() })).rejects.toMatchObject({ code: 11000 })
  })

  it('finds sources and audit replays with normalized identifiers', async () => {
    const fixture = createContext({ findOne: { sources: [document(), document()], adminAuditLogs: [{ eventId: 'source-audit-1' }] } })
    await expect(fixture.repository.findSourceById(sourceId.toHexString())).resolves.toEqual(expect.objectContaining({ id: sourceId.toHexString() }))
    await expect(fixture.repository.findSourceByKey('rss:example')).resolves.toEqual(expect.objectContaining({ sourceKey: 'rss:example' }))
    await expect(fixture.repository.findAuditReplay({ eventId: 'source-audit-1' })).resolves.toEqual({ eventId: 'source-audit-1' })
  })

  it('commits replacements with CAS and supports deterministic audit replay', async () => {
    const replacement = sourceData({ operationalStatus: 'testing', updatedAt })
    const statusAudit = audit({ action: 'source_status_updated', changedFields: ['operationalStatus'], reasonCode: 'source_status_changed', stateTransition: { from: 'draft', to: 'testing' } })
    const fixture = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [null] } })
    await expect(fixture.repository.commitReplacement({ source: replacement, expectedUpdatedAt: createdAt, expectedPolicyVersion: 1, audit: statusAudit, actorFence: actorFence() })).resolves.toEqual(replacement)
    expect(fixture.collections.get('sources').replaceOne).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: createdAt, policyVersion: 1 }), expect.objectContaining({ _id: sourceId }), { session: fixture.session })

    const replayFixture = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [statusAudit], sources: [document(replacement)] } })
    await expect(replayFixture.repository.commitReplacement({ source: replacement, expectedUpdatedAt: createdAt, expectedPolicyVersion: 1, audit: statusAudit, actorFence: actorFence() })).resolves.toEqual(expect.objectContaining({ id: sourceId.toHexString() }))
    await expect(fixture.repository.commitReplacement({ source: replacement, expectedUpdatedAt: updatedAt, expectedPolicyVersion: 1, audit: statusAudit, actorFence: actorFence() })).rejects.toMatchObject({ code: 'source_validation' })

    const changed = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [null] }, replaceResults: { sources: [{ matchedCount: 0 }] } })
    await expect(changed.repository.commitReplacement({ source: replacement, expectedUpdatedAt: createdAt, expectedPolicyVersion: 1, audit: statusAudit, actorFence: actorFence() })).rejects.toMatchObject({ code: 'source_conflict' })
  })

  it('rejects audit replays that collide with another identity', async () => {
    const statusAudit = audit({ action: 'source_status_updated', changedFields: ['operationalStatus'], reasonCode: 'source_status_changed', stateTransition: { from: 'draft', to: 'testing' } })
    const collision = createContext({ findOne: { adminAuditLogs: [{ ...statusAudit, requestId: 'other-request' }] } })
    await expect(collision.repository.insertAudit(statusAudit)).rejects.toMatchObject({ code: 'source_conflict' })
    const idempotency = createContext({ findOne: { adminAuditLogs: [{ ...statusAudit, requestId: 'other-request' }] } })
    await expect(idempotency.repository.insertAudit({ ...statusAudit, action: 'source_policy_re_review_requested', reasonCode: 'source_policy_re_review_requested', changedFields: ['operationalStatus'], stateTransition: { from: 'active', to: 'paused' } })).rejects.toMatchObject({ code: 'idempotency_mismatch' })
    await expect(collision.repository.insertAudit({ ...statusAudit, result: 'pending' })).rejects.toThrow(/identity/i)
  })
})
