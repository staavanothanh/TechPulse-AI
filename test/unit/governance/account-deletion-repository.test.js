import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoAccountDeletionRepository } from '../../../server/repositories/mongo/account-deletion-repository.js'

const USER_ID = new ObjectId('507f1f77bcf86cd799439011')
const REQUEST_ID = new ObjectId('507f1f77bcf86cd799439012')

function makeContext({ leaseMatched = 1, failCollection = null, user = {} } = {}) {
  const calls = []
  const request = {
    _id: REQUEST_ID,
    userId: USER_ID,
    status: 'running',
    leaseGeneration: 2,
    leaseOwner: 'a'.repeat(64),
    leaseExpiresAt: new Date('2026-08-13T01:00:00.000Z'),
    completion: {
      sessionsRevoked: true,
      sessionsDeleted: false,
      savedArticlesDeleted: false,
      chatSessionsDeleted: false,
      answerAttemptsDeleted: false,
      userQuotaDataDeleted: false,
      identityAnonymized: false,
    },
    requestedAt: new Date('2026-08-13T00:00:00.000Z'),
    updatedAt: new Date('2026-08-13T00:00:00.000Z'),
  }
  const collections = new Map()
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async () => name === 'accountDeletionRequests' ? request : name === 'users' ? { _id: USER_ID, status: 'deletion-pending', sessionVersion: 3, deletionRequestedAt: new Date('2026-08-13T00:00:00.000Z'), createdAt: new Date('2026-08-12T00:00:00.000Z') } : name === 'adminAuditLogs' ? null : user),
      updateOne: vi.fn(async (filter, update, options) => {
        calls.push({ name, method: 'updateOne', filter, update, options })
        if (name === 'accountDeletionRequests' && leaseMatched === 0) return { matchedCount: 0 }
        return { matchedCount: 1 }
      }),
      replaceOne: vi.fn(async (filter, replacement, options) => {
        calls.push({ name, method: 'replaceOne', filter, replacement, options })
        return { matchedCount: 1 }
      }),
      insertOne: vi.fn(async (document, options) => {
        calls.push({ name, method: 'insertOne', document, options })
        return { insertedId: document._id }
      }),
      deleteMany: vi.fn(async (filter, options) => {
        calls.push({ name, method: 'deleteMany', filter, options })
        if (name === failCollection) throw new Error('cleanup failed')
        return { deletedCount: 1 }
      }),
      countDocuments: vi.fn(async () => 0),
    }
    collections.set(name, handle)
    return handle
  }
  const session = { withTransaction: vi.fn(async (work) => work(session)), endSession: vi.fn(async () => {}) }
  const governanceDb = { collection: vi.fn(() => ({ insertOne: vi.fn(async () => ({ insertedId: new ObjectId() })) })) }
  const quotaKeyring = { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) }
  const governanceKeyring = { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) }
  const context = { db: { collection }, client: { startSession: vi.fn(() => session) }, governanceDb, quotaKeyring, governanceKeyring, now: () => new Date('2026-08-13T00:30:00.000Z') }
  return { context, request, calls, collections, session }
}

function job(request) {
  return { ...request, id: REQUEST_ID, _id: REQUEST_ID }
}

describe('Mongo account deletion cleanup fencing', () => {
  it('requests only canonical progress fields from Mongo for admin lists', async () => {
    const fixture = makeContext()
    const find = vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }))
    fixture.collections.set('accountDeletionRequests', { find })
    await new MongoAccountDeletionRepository(fixture.context).list({})
    expect(find).toHaveBeenCalledWith({}, { projection: { _id: 1, status: 1, priority: 1, attempt: 1, availableAt: 1, completion: 1, error: 1, requestedAt: 1, startedAt: 1, completedAt: 1 } })
  })
  it('rejects invalid account deletion list bounds and status before Mongo', async () => {
    const fixture = makeContext()
    const find = vi.fn()
    fixture.collections.set('accountDeletionRequests', { find })
    const repository = new MongoAccountDeletionRepository(fixture.context)
    await expect(repository.list({ limit: 0 })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(repository.list({ status: 'private' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(find).not.toHaveBeenCalled()
  })
  it('checkpoints each cleanup flag and replaces user with the exact closed tombstone', async () => {
    const fixture = makeContext()
    const repository = new MongoAccountDeletionRepository(fixture.context)
    const completion = await repository.applyCleanup({ job: job(fixture.request), now: new Date('2026-08-13T00:30:00.000Z') })

    expect(completion).toEqual(expect.objectContaining({
      sessionsDeleted: true,
      savedArticlesDeleted: true,
      chatSessionsDeleted: true,
      answerAttemptsDeleted: true,
      userQuotaDataDeleted: true,
      identityAnonymized: true,
    }))
    expect(fixture.session.withTransaction).toHaveBeenCalled()
    const checkpointWrites = fixture.calls.filter((call) => call.name === 'accountDeletionRequests' && call.method === 'updateOne')
    expect(checkpointWrites.some(({ update }) => update.$set?.['completion.sessionsDeleted'] === true)).toBe(true)
    const tombstone = fixture.calls.find((call) => call.name === 'users' && call.method === 'replaceOne')
    expect(tombstone?.replacement).toEqual({
      _id: USER_ID,
      status: 'deleted',
      deletionRequestedAt: expect.any(Date),
      deletionRequestId: REQUEST_ID,
      deletedAt: expect.any(Date),
      sessionVersion: 3,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    })
  })

  it('rejects a stale lease before deleting any user-owned collection', async () => {
    const fixture = makeContext({ leaseMatched: 0 })
    const repository = new MongoAccountDeletionRepository(fixture.context)
    await expect(repository.applyCleanup({ job: job(fixture.request), now: new Date('2026-08-13T00:30:00.000Z') })).rejects.toThrow(/lease/i)
    expect(fixture.calls.filter(({ method }) => method === 'deleteMany')).toHaveLength(0)
    expect(fixture.calls.filter(({ method }) => method === 'replaceOne')).toHaveLength(0)
  })

  it('keeps a completed checkpoint when a later collection cleanup fails', async () => {
    const fixture = makeContext({ failCollection: 'chatSessions' })
    const repository = new MongoAccountDeletionRepository(fixture.context)
    await expect(repository.applyCleanup({ job: job(fixture.request), now: new Date('2026-08-13T00:30:00.000Z') })).rejects.toThrow('cleanup failed')
    expect(fixture.calls.some(({ name, update }) => name === 'accountDeletionRequests' && update.$set?.['completion.sessionsDeleted'] === true)).toBe(true)
    expect(fixture.calls.some(({ name, method }) => name === 'users' && method === 'replaceOne')).toBe(false)
  })

  it('fences failure transition to the current unexpired lease', async () => {
    const fixture = makeContext()
    const repository = new MongoAccountDeletionRepository(fixture.context)
    await repository.fail({ job: job(fixture.request), error: { code: 'cleanup_incomplete' }, now: new Date('2026-08-13T00:30:00.000Z') })
    const failure = fixture.calls.find(({ name, method }) => name === 'accountDeletionRequests' && method === 'updateOne')
    expect(failure.filter.leaseExpiresAt).toEqual({ $gt: new Date('2026-08-13T00:30:00.000Z') })
  })

  it('clears transient error on exact-fenced expired lease recovery', async () => {
    const fixture = makeContext()
    const repository = new MongoAccountDeletionRepository(fixture.context)
    const find = vi.fn(() => cursor)
    const cursor = {
      sort: vi.fn(() => cursor),
      limit: vi.fn(() => cursor),
      toArray: vi.fn(async () => [{ ...fixture.request, error: { code: 'cleanup_incomplete' } }]),
    }
    fixture.collections.set('accountDeletionRequests', {
      find,
      updateOne: vi.fn(async (filter, update) => { fixture.calls.push({ name: 'accountDeletionRequests', method: 'updateOne', filter, update }); return { matchedCount: 1 } }),
    })
    const now = new Date('2026-08-13T02:00:00.000Z')
    await repository.recoverExpired({ now, limit: 1 })
    expect(find).toHaveBeenCalledWith({
      status: 'running',
      leaseExpiresAt: { $type: 'date', $lte: now },
    })
    const recovery = fixture.calls.at(-1)
    expect(recovery.filter.leaseGeneration).toBe(2)
    expect(recovery.update.$set.error).toBeNull()
  })

  it('commits workflow completion, terminal audit and signed suppression in one transaction', async () => {
    const fixture = makeContext()
    const repository = new MongoAccountDeletionRepository(fixture.context)
    const completion = Object.fromEntries(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'].map((field) => [field, true]))
    await expect(repository.complete({ job: job(fixture.request), completion, now: new Date('2026-08-13T00:30:00.000Z') })).resolves.toBe(true)
    expect(fixture.collections.get('adminAuditLogs').insertOne).toHaveBeenCalledWith(expect.objectContaining({ action: 'workflow_completed', result: 'succeeded' }), { session: fixture.session })
    expect(fixture.context.governanceDb.collection).toHaveBeenCalledWith('governanceSuppressions')
  })
})
