import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { JobError } from '../../domain/jobs/idempotency.js'
import { assertCanonicalLeaseKey } from '../../domain/jobs/lease-keys.js'

function idValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new JobError(400, 'bad_request', 'Job identifier is invalid')
}

function tokenHash(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 512) throw new Error('Lease owner token is invalid')
  return createHash('sha256').update(value).digest('hex')
}

function validDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid`)
  return value
}

export class MongoLeaseRepository {
  constructor(context) {
    if (!context?.db) throw new Error('Mongo context is required')
    this.db = context.db
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  collection() { return this.db.collection('jobLeases') }

  async acquire({ key, jobId, ownerToken, leaseMs = 30_000 } = {}) {
    assertCanonicalLeaseKey(key)
    const acquiredAt = validDate(this.clock(), 'Authoritative lease clock')
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 15 * 60 * 1000) throw new Error('Lease duration is invalid')
    const ownerTokenHash = tokenHash(ownerToken)
    const normalizedJobId = idValue(jobId)
    await this.collection().updateOne(
      { key },
      { $setOnInsert: { _id: new ObjectId(), key, generationHighWater: 0, createdAt: acquiredAt, updatedAt: acquiredAt } },
      { upsert: true },
    )
    const expiresAt = new Date(acquiredAt.getTime() + leaseMs)
    const document = await this.collection().findOneAndUpdate(
      { key, activeOwner: { $exists: false } },
      [{ $set: {
        generationHighWater: { $add: ['$generationHighWater', 1] },
        activeOwner: {
          ownerTokenHash, jobId: normalizedJobId,
          leaseGeneration: { $add: ['$generationHighWater', 1] },
          acquiredAt, heartbeatAt: acquiredAt, expiresAt,
        },
        updatedAt: acquiredAt,
      } }],
      { returnDocument: 'after' },
    )
    if (!document) throw new JobError(409, 'conflict', 'Logical resource already has an active lease')
    return {
      key, jobId: normalizedJobId.toHexString(), ownerTokenHash,
      leaseGeneration: Number(document.activeOwner.leaseGeneration),
      acquiredAt, heartbeatAt: acquiredAt, expiresAt,
    }
  }

  async heartbeat({ key, jobId, leaseGeneration, ownerToken, ownerTokenHash: suppliedHash, leaseMs = 30_000 } = {}) {
    assertCanonicalLeaseKey(key)
    const heartbeatAt = validDate(this.clock(), 'Authoritative lease clock')
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 15 * 60 * 1000) throw new Error('Lease duration is invalid')
    const hash = suppliedHash ?? tokenHash(ownerToken)
    const result = await this.collection().updateOne({
      key,
      'activeOwner.jobId': idValue(jobId),
      'activeOwner.ownerTokenHash': hash,
      'activeOwner.leaseGeneration': leaseGeneration,
      'activeOwner.expiresAt': { $gt: heartbeatAt },
    }, { $set: { 'activeOwner.heartbeatAt': heartbeatAt, 'activeOwner.expiresAt': new Date(heartbeatAt.getTime() + leaseMs), updatedAt: heartbeatAt } })
    return result.matchedCount === 1
  }

  async release({ key, jobId, leaseGeneration, ownerToken, ownerTokenHash: suppliedHash, session } = {}) {
    assertCanonicalLeaseKey(key)
    const releasedAt = validDate(this.clock(), 'Authoritative lease clock')
    const hash = suppliedHash ?? tokenHash(ownerToken)
    const result = await this.collection().updateOne({
      key,
      'activeOwner.jobId': idValue(jobId),
      'activeOwner.ownerTokenHash': hash,
      'activeOwner.leaseGeneration': leaseGeneration,
      'activeOwner.expiresAt': { $gt: releasedAt },
    }, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: releasedAt, updatedAt: releasedAt } }, { session })
    return result.matchedCount === 1
  }

  async listExpired({ now = new Date(), limit = 10, namespace = 'ingestion:source:' } = {}) {
    const authoritativeNow = validDate(now, 'Lease recovery time')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !['ingestion:source:', 'indexing:article:'].includes(namespace)) throw new Error('Lease recovery query is invalid')
    const key = namespace === 'indexing:article:' ? /^indexing:article:/ : /^ingestion:source:/
    return this.collection().find({ key, 'activeOwner.expiresAt': { $lte: authoritativeNow } }).sort({ 'activeOwner.expiresAt': 1 }).hint('job_lease_expiry').limit(limit).toArray()
  }

  async clearExpiredReconciliation({ key, now = this.clock() } = {}) {
    assertCanonicalLeaseKey(key)
    if (!key.startsWith('reconciliation:source:')) throw new Error('Only reconciliation ownership may be cleared directly')
    const authoritativeNow = validDate(now, 'Reconciliation recovery time')
    const result = await this.collection().updateOne({ key, 'activeOwner.expiresAt': { $lte: authoritativeNow } }, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: authoritativeNow, updatedAt: authoritativeNow } })
    return result.matchedCount === 1
  }
}
