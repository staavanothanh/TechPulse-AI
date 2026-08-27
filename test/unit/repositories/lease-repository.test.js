import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoLeaseRepository } from '../../../server/repositories/mongo/lease-repository.js'

const key = 'ingestion:source:source-1'
const reconciliationKey = 'reconciliation:source:source-1'
const indexingKey = 'indexing:article:article-1'
const jobId = new ObjectId('507f1f77bcf86cd799439011')
const acquiredAt = new Date('2026-08-20T08:00:00.000Z')

function repositoryWith({ document = null, matchedCount = 1, now = acquiredAt } = {}) {
  const cursor = {
    sort: vi.fn(() => cursor),
    hint: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => ['expired-lease']),
  }
  const collection = {
    updateOne: vi.fn(async () => ({ matchedCount })),
    findOneAndUpdate: vi.fn(async () => document),
    find: vi.fn(() => cursor),
  }
  const repository = new MongoLeaseRepository({
    db: { collection: vi.fn(() => collection) },
    now: () => now,
  })
  return { repository, collection, cursor }
}

describe('MongoLeaseRepository', () => {
  it('requires a Mongo context and falls back to a local clock', () => {
    expect(() => new MongoLeaseRepository()).toThrow('Mongo context is required')
    const db = { collection: vi.fn() }
    const repository = new MongoLeaseRepository({ db })
    expect(repository.db).toBe(db)
    expect(repository.collection()).toBeUndefined()
    expect(db.collection).toHaveBeenCalledWith('jobLeases')
  })

  it('acquires a canonical lease and returns normalized ownership data', async () => {
    const document = { activeOwner: { leaseGeneration: 3 } }
    const { repository, collection } = repositoryWith({ document })

    const lease = await repository.acquire({ key, jobId: jobId.toHexString(), ownerToken: 'owner-token', leaseMs: 500 })

    expect(lease).toEqual({
      key,
      jobId: jobId.toHexString(),
      ownerTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseGeneration: 3,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: new Date(acquiredAt.getTime() + 500),
    })
    expect(collection.updateOne).toHaveBeenCalledWith(
      { key },
      { $setOnInsert: expect.objectContaining({ key, generationHighWater: 0, createdAt: acquiredAt, updatedAt: acquiredAt }) },
      { upsert: true },
    )
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { key, activeOwner: { $exists: false } },
      [
        { $set: expect.objectContaining({ generationHighWater: expect.any(Object), activeOwner: expect.objectContaining({ jobId, acquiredAt, heartbeatAt: acquiredAt }) }) },
      ],
      { returnDocument: 'after' },
    )
  })

  it('rejects invalid acquire inputs and reports active lease conflicts', async () => {
    const { repository, collection } = repositoryWith()
    await expect(repository.acquire({ key: 'invalid', jobId, ownerToken: 'owner-token' })).rejects.toThrow(/canonical lease/i)
    await expect(repository.acquire({ key, jobId, ownerToken: 'owner-token', leaseMs: 99 })).rejects.toThrow(/duration/i)
    await expect(repository.acquire({ key, jobId, ownerToken: 'owner-token', leaseMs: 900001 })).rejects.toThrow(/duration/i)
    await expect(repository.acquire({ key, jobId, ownerToken: 'short' })).rejects.toThrow(/owner token/i)
    await expect(repository.acquire({ key, jobId: 'not-an-id', ownerToken: 'owner-token' })).rejects.toThrow(/identifier/i)
    expect(collection.updateOne).not.toHaveBeenCalled()

    const conflict = repositoryWith({ document: null }).repository
    await expect(conflict.acquire({ key, jobId, ownerToken: 'owner-token' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('supports ObjectId jobs and validates authoritative clock dates', async () => {
    const { repository } = repositoryWith({ document: { activeOwner: { leaseGeneration: 1 } }, now: new Date('invalid') })
    await expect(repository.acquire({ key, jobId, ownerToken: 'owner-token' })).rejects.toThrow(/clock/i)
  })

  it('heartbeats an unexpired lease with either a token or supplied hash', async () => {
    const { repository, collection } = repositoryWith({ matchedCount: 1 })
    await expect(repository.heartbeat({ key, jobId: jobId.toHexString(), leaseGeneration: 2, ownerToken: 'owner-token', leaseMs: 1000 })).resolves.toBe(true)
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ key, 'activeOwner.jobId': jobId, 'activeOwner.leaseGeneration': 2, 'activeOwner.expiresAt': { $gt: acquiredAt } }),
      { $set: { 'activeOwner.heartbeatAt': acquiredAt, 'activeOwner.expiresAt': new Date(acquiredAt.getTime() + 1000), updatedAt: acquiredAt } },
    )

    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(repository.heartbeat({ key, jobId, leaseGeneration: 2, ownerTokenHash: 'hash-value' })).resolves.toBe(false)
    expect(collection.updateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'activeOwner.ownerTokenHash': 'hash-value' }),
      expect.anything(),
    )
  })

  it('rejects heartbeat input and does not claim expired or malformed owners', async () => {
    const { repository, collection } = repositoryWith()
    await expect(repository.heartbeat({ key: 'invalid', jobId, leaseGeneration: 1, ownerToken: 'owner-token' })).rejects.toThrow(/canonical lease/i)
    await expect(repository.heartbeat({ key, jobId, leaseGeneration: 1, ownerToken: 'owner-token', leaseMs: 99 })).rejects.toThrow(/duration/i)
    await expect(repository.heartbeat({ key, jobId: 'invalid', leaseGeneration: 1, ownerToken: 'owner-token' })).rejects.toThrow(/identifier/i)
    expect(collection.updateOne).not.toHaveBeenCalled()
  })

  it('releases matching ownership and forwards an optional Mongo session', async () => {
    const session = { id: 'session' }
    const { repository, collection } = repositoryWith({ matchedCount: 1 })
    await expect(repository.release({ key, jobId, leaseGeneration: 4, ownerTokenHash: 'hash-value', session })).resolves.toBe(true)
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ key, 'activeOwner.jobId': jobId, 'activeOwner.ownerTokenHash': 'hash-value', 'activeOwner.leaseGeneration': 4 }),
      { $unset: { activeOwner: '' }, $set: { lastReleasedAt: acquiredAt, updatedAt: acquiredAt } },
      { session },
    )

    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(repository.release({ key, jobId, leaseGeneration: 4, ownerToken: 'owner-token' })).resolves.toBe(false)
  })

  it('lists expired ingestion and indexing leases with bounded query options', async () => {
    const now = new Date('2026-08-20T09:00:00.000Z')
    const { repository, collection, cursor } = repositoryWith()
    await expect(repository.listExpired({ now, limit: 4 })).resolves.toEqual(['expired-lease'])
    expect(collection.find).toHaveBeenCalledWith({ key: /^ingestion:source:/, 'activeOwner.expiresAt': { $lte: now } })
    expect(cursor.sort).toHaveBeenCalledWith({ 'activeOwner.expiresAt': 1 })
    expect(cursor.hint).toHaveBeenCalledWith('job_lease_expiry')
    expect(cursor.limit).toHaveBeenCalledWith(4)

    await repository.listExpired({ now, limit: 2, namespace: 'indexing:article:' })
    expect(collection.find).toHaveBeenLastCalledWith({ key: /^indexing:article:/, 'activeOwner.expiresAt': { $lte: now } })
  })

  it('rejects invalid expiry queries and clears only expired reconciliation ownership', async () => {
    const { repository, collection } = repositoryWith({ matchedCount: 1 })
    await expect(repository.listExpired({ limit: 0 })).rejects.toThrow(/recovery query/i)
    await expect(repository.listExpired({ limit: 101 })).rejects.toThrow(/recovery query/i)
    await expect(repository.listExpired({ namespace: 'reconciliation:source:' })).rejects.toThrow(/recovery query/i)
    await expect(repository.listExpired({ now: 'not-a-date' })).rejects.toThrow(/recovery time/i)

    await expect(repository.clearExpiredReconciliation({ key: reconciliationKey })).resolves.toBe(true)
    expect(collection.updateOne).toHaveBeenLastCalledWith(
      { key: reconciliationKey, 'activeOwner.expiresAt': { $lte: acquiredAt } },
      { $unset: { activeOwner: '' }, $set: { lastReleasedAt: acquiredAt, updatedAt: acquiredAt } },
    )
    collection.updateOne.mockResolvedValueOnce({ matchedCount: 0 })
    await expect(repository.clearExpiredReconciliation({ key: reconciliationKey, now: new Date('2026-08-21T00:00:00.000Z') })).resolves.toBe(false)
    await expect(repository.clearExpiredReconciliation({ key: indexingKey })).rejects.toThrow(/reconciliation/i)
    await expect(repository.clearExpiredReconciliation({ key: reconciliationKey, now: 'not-a-date' })).rejects.toThrow(/recovery time/i)
  })
})
