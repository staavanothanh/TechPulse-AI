import { ObjectId } from 'mongodb'
import { isScopeSubjectPairValid, rateLimitForScope } from '../../security/rate-limit-scope.js'
import { AUDIT_RULES } from '../../audit/writer.js'

const DAY_MS = 24 * 60 * 60 * 1000

function idValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  throw new Error('invalid opaque identifier')
}

function auditIdValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value)) return value
  throw new Error('invalid audit identifier')
}

function nowDate(value) {
  return value instanceof Date ? value : new Date(value ?? Date.now())
}

function cloneForApi(document) {
  if (!document) return null
  return {
    id: String(document._id),
    emailDisplay: document.emailDisplay,
    role: document.role,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function auditIdentityMatches(existing, expected) {
  return existing.action === expected.action && existing.actorType === expected.actorType && String(existing.actorId) === String(expected.actorId) && existing.targetType === expected.targetType && String(existing.targetId) === String(expected.targetId) && existing.reasonCode === expected.reasonCode && existing.requestId === expected.requestId && existing.result === expected.result && JSON.stringify(existing.changedFields ?? []) === JSON.stringify(expected.changedFields ?? []) && JSON.stringify(existing.stateTransition ?? null) === JSON.stringify(expected.stateTransition ?? null)
}

export class MongoAuthRepository {
  constructor(context) {
    if (!context?.db || !context.client) throw new Error('MongoDB context is required')
    this.context = context
    this.db = context.db
  }

  collection(name) {
    return this.db.collection(name)
  }

  async withTransaction(work) {
    const session = this.context.client.startSession()
    try {
      return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    } finally {
      await session.endSession()
    }
  }

  async createUser(input, options = {}) {
    const createdAt = nowDate(input.createdAt)
    const document = {
      _id: input._id ?? new ObjectId(),
      emailNormalized: input.emailNormalized,
      emailDisplay: input.emailDisplay,
      passwordHash: input.passwordHash,
      role: input.role ?? 'user',
      status: input.status ?? 'active',
      topicPreferences: input.topicPreferences ?? [],
      sessionVersion: input.sessionVersion ?? 0,
      createdAt,
      updatedAt: nowDate(input.updatedAt ?? createdAt),
    }
    if (input.suspendedAt) document.suspendedAt = input.suspendedAt
    if (input.suspensionReason) document.suspensionReason = input.suspensionReason
    await this.collection('users').insertOne(document, options)
    return document
  }

  async seedAdmin(input, options = {}) {
    const createdAt = nowDate(input.createdAt)
    const document = {
      _id: input._id ?? new ObjectId(),
      emailNormalized: input.emailNormalized,
      emailDisplay: input.emailDisplay,
      passwordHash: input.passwordHash,
      role: 'admin',
      status: 'active',
      topicPreferences: [],
      sessionVersion: 0,
      createdAt,
      updatedAt: nowDate(input.updatedAt ?? createdAt),
    }
    try {
      const result = await this.collection('users').updateOne(
        { emailNormalized: document.emailNormalized },
        { $setOnInsert: document },
        { ...options, upsert: true },
      )
      if (result.upsertedCount === 1) return { seeded: true, existing: false, user: document }
    } catch (error) {
      if (error?.code !== 11000) throw error
    }
    const existing = await this.findUserByEmail(document.emailNormalized, options)
    if (!existing || existing.role !== 'admin' || existing.status !== 'active') throw new Error('existing account is not an active admin')
    return { seeded: false, existing: true, user: existing }
  }

  async findUserByEmail(emailNormalized, options = {}) {
    return this.collection('users').findOne({ emailNormalized }, options)
  }

  async findUserById(userId, options = {}) {
    return this.collection('users').findOne({ _id: idValue(userId) }, options)
  }

  async listUsers({ skip = 0, limit = 50, status, emailNormalized, cursor } = {}, options = {}) {
    const filter = status ? { status } : { status: { $ne: 'deleted' } }
    if (emailNormalized) filter.emailNormalized = emailNormalized
    if (cursor?.createdAt && cursor?.id) {
      const cursorDate = nowDate(cursor.createdAt)
      const cursorId = idValue(cursor.id)
      filter.$or = [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: cursorId } }]
    }
    const documents = await this.collection('users').find(filter, { ...options, projection: { _id: 1, emailDisplay: 1, role: 1, status: 1, createdAt: 1, updatedAt: 1 } }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray()
    return documents.map(cloneForApi)
  }

  async updatePreferences(userId, topicPreferences, options = {}) {
    const { expectedSessionId, expectedSessionVersion, ...mongoOptions } = options
    if (expectedSessionId !== undefined && !(await this.assertActiveSessionForUser({ sessionId: expectedSessionId, userId, sessionVersion: expectedSessionVersion }, mongoOptions))) return null
    const result = await this.collection('users').findOneAndUpdate(
      { _id: idValue(userId), status: 'active', ...(expectedSessionVersion === undefined ? {} : { sessionVersion: expectedSessionVersion }) },
      { $set: { topicPreferences, updatedAt: new Date() } },
      { ...mongoOptions, returnDocument: 'after' },
    )
    return result
  }

  async updateUserStatus(userId, status, reasonCode, options = {}) {
    const now = new Date()
    const expectedStatus = status === 'suspended' ? 'active' : 'suspended'
    const set = { status, updatedAt: now }
    const unset = {}
    if (status === 'suspended') {
      set.suspendedAt = now
      set.suspensionReason = reasonCode
    } else {
      unset.suspendedAt = ''
      unset.suspensionReason = ''
    }
    const targetId = idValue(userId)
    const current = await this.collection('users').findOne({ _id: targetId }, options)
    if (!current) return null
    if (current.status !== expectedStatus) return { conflict: true }
    const result = await this.collection('users').findOneAndUpdate(
      { _id: targetId, status: expectedStatus },
      { $set: set, $inc: { sessionVersion: 1 }, $unset: unset },
      { ...options, returnDocument: 'after' },
    )
    return result
  }

  async createSession(input, options = {}) {
    const { expectedUserSessionVersion, expectedUserStatus = 'active', ...mongoOptions } = options
    const createdAt = nowDate(input.createdAt)
    const expiresAt = nowDate(input.expiresAt ?? new Date(createdAt.getTime() + DAY_MS))
    const document = {
      _id: input._id ?? new ObjectId(),
      tokenHash: input.tokenHash,
      userId: idValue(input.userId),
      userSessionVersion: input.userSessionVersion ?? 0,
      csrfSecretHash: input.csrfSecretHash,
      status: 'active',
      absoluteExpiresAt: nowDate(input.absoluteExpiresAt ?? new Date(createdAt.getTime() + 7 * DAY_MS)),
      expiresAt,
      lastSeenAt: createdAt,
      createdAt,
    }
    if (input.createdIpHmac) document.createdIpHmac = input.createdIpHmac
    if (input.ipHmacKeyVersion) document.ipHmacKeyVersion = input.ipHmacKeyVersion
    if (input.userAgentSummary) document.userAgentSummary = input.userAgentSummary
    if (expectedUserSessionVersion !== undefined) {
      const user = await this.collection('users').findOne({ _id: document.userId, status: expectedUserStatus, sessionVersion: expectedUserSessionVersion }, mongoOptions)
      if (!user) throw new Error('session user fence mismatch')
    }
    await this.collection('sessions').insertOne(document, mongoOptions)
    return document
  }

  async findSessionByTokenHash(tokenHash, options = {}) {
    return this.collection('sessions').findOne({ tokenHash, status: 'active' }, options)
  }

  async touchSession(sessionId, now = new Date(), options = {}) {
    const { userId, expectedSessionVersion, ...mongoOptions } = options
    if (userId !== undefined && !(await this.assertActiveSessionForUser({ sessionId, userId, sessionVersion: expectedSessionVersion, now }, mongoOptions))) return null
    const idleExpiresAt = new Date(now.getTime() + DAY_MS)
    const result = await this.collection('sessions').findOneAndUpdate(
      { _id: idValue(sessionId), status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } },
      [
        { $set: { lastSeenAt: now } },
        { $set: { expiresAt: { $cond: [{ $lt: ['$absoluteExpiresAt', idleExpiresAt] }, '$absoluteExpiresAt', idleExpiresAt] } } },
      ],
      { ...mongoOptions, returnDocument: 'after' },
    )
    return result
  }

  async revokeSession(sessionId, options = {}) {
    return this.collection('sessions').updateOne({ _id: idValue(sessionId), status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date(), expiresAt: new Date() } }, options)
  }

  async revokeSessionsByUserId(userId, options = {}) {
    return this.collection('sessions').updateMany({ userId: idValue(userId), status: 'active' }, { $set: { status: 'revoked', revokedAt: new Date(), expiresAt: new Date() } }, options)
  }

  async deleteSessionsByUserId(userId, options = {}) {
    return this.collection('sessions').deleteMany({ userId: idValue(userId) }, options)
  }

  async deleteSessionsByUserIdAndVerify(userId, options = {}) {
    const result = await this.deleteSessionsByUserId(userId, options)
    const remaining = await this.collection('sessions').countDocuments({ userId: idValue(userId) }, options)
    return { deletedCount: result.deletedCount, remaining, zeroMatch: remaining === 0 }
  }

  async deleteUserQuotaBucketsAllVersions({ keyHashes = [] } = {}, options = {}) {
    if (!Array.isArray(keyHashes) || keyHashes.length === 0) return { acknowledged: true, deletedCount: 0, remaining: 0, zeroMatch: true }
    const filter = { subjectType: 'user', keyHash: { $in: keyHashes } }
    const result = await this.collection('rateLimitBuckets').deleteMany(filter, options)
    const remaining = await this.collection('rateLimitBuckets').countDocuments(filter, options)
    return { ...result, remaining, zeroMatch: remaining === 0 }
  }

  async deleteUserQuotaBucketsByHashes(keyHashes, options = {}) {
    return this.deleteUserQuotaBucketsAllVersions({ keyHashes }, options)
  }

  async readRateLimitBucket({ scope, subjectType, keyHash, keyring } = {}, options = {}) {
    const bucket = await this.collection('rateLimitBuckets').findOne({ scope, subjectType, keyHash }, options)
    if (bucket && (!keyring?.acceptsVersion?.(bucket.keyVersion) || !keyring.matchesFingerprint?.(bucket.keyVersion, bucket.keyFingerprint))) throw new Error('unknown or retired rate-limit key version')
    return bucket
  }

  async countRateLimitDependentsByKeyVersion(keyVersion, options = {}) {
    return this.collection('rateLimitBuckets').countDocuments({ keyVersion }, options)
  }

  async countUnknownRateLimitKeyVersions(acceptedVersions, options = {}) {
    if (!Array.isArray(acceptedVersions) || acceptedVersions.length === 0) throw new Error('accepted HMAC versions are required')
    return this.collection('rateLimitBuckets').countDocuments({ keyVersion: { $nin: acceptedVersions } }, options)
  }

  async countRateLimitFingerprintMismatches(keyring, options = {}) {
    if (!keyring?.acceptsVersion || !keyring.matchesFingerprint) throw new Error('HMAC keyring is required')
    let count = 0
    for (const version of keyring.versions ?? []) {
      count += await this.collection('rateLimitBuckets').countDocuments({ keyVersion: version, keyFingerprint: { $ne: keyring.fingerprint(version) } }, options)
    }
    return count
  }

  async countUnknownIpHmacKeyVersions(acceptedVersions, options = {}) {
    if (!Array.isArray(acceptedVersions) || acceptedVersions.length === 0) throw new Error('accepted HMAC versions are required')
    const sessions = await this.collection('sessions').countDocuments({ $or: [
      { createdIpHmac: { $exists: true }, ipHmacKeyVersion: { $exists: false } },
      { ipHmacKeyVersion: { $exists: true, $nin: acceptedVersions } },
    ] }, options)
    const audits = await this.collection('adminAuditLogs').countDocuments({ $or: [
      { ipAddressHmac: { $exists: true }, ipHmacKeyVersion: { $exists: false } },
      { ipHmacKeyVersion: { $exists: true, $nin: acceptedVersions } },
    ] }, options)
    return sessions + audits
  }

  async listHmacLifecycleSnapshots(options = {}) {
    const snapshots = await this.collection('hmacKeyLifecycleSnapshots')
      .find({ inventoryId: 'quota-hmac' }, options)
      .sort({ revision: 1 })
      .limit(129)
      .toArray()
    if (snapshots.length > 128) throw new Error('quota HMAC lifecycle history is unbounded')
    return snapshots
  }

  async appendHmacLifecycleSnapshot(snapshot, options = {}) {
    await this.collection('hmacKeyLifecycleSnapshots').insertOne(snapshot, options)
    return snapshot
  }

  async countHmacDependentsByKeyVersion(keyVersion, options = {}) {
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('quota HMAC key version is invalid')
    const rateLimitBuckets = await this.collection('rateLimitBuckets').countDocuments({ keyVersion }, options)
    const sessions = await this.collection('sessions').countDocuments({ ipHmacKeyVersion: keyVersion }, options)
    const adminAuditLogs = await this.collection('adminAuditLogs').countDocuments({ ipHmacKeyVersion: keyVersion }, options)
    return { rateLimitBuckets, sessions, adminAuditLogs, total: rateLimitBuckets + sessions + adminAuditLogs }
  }

  async reserveRateLimit({ scope, subjectType, keyHash, keyVersion, keyring, rotationKeyHashes = [], now = new Date() }, options = {}) {
    if (!isScopeSubjectPairValid(scope, subjectType)) throw new Error('invalid rate-limit scope ownership')
    const policy = rateLimitForScope(scope)
    if (!policy) throw new Error('unknown rate-limit scope')
    if (!keyring?.acceptsVersion || !keyring.matchesFingerprint) throw new Error('HMAC keyring is required')
    if (!keyring.matchesFingerprint(keyVersion, keyring.fingerprint(keyVersion))) throw new Error('unknown or retired rate-limit key version')
    const keyFingerprint = keyring.fingerprint(keyVersion)
    const windowStart = new Date(Math.floor(now.getTime() / (policy.windowSeconds * 1000)) * policy.windowSeconds * 1000)
    const windowEnd = new Date(windowStart.getTime() + policy.windowSeconds * 1000)
    const expiresAt = new Date(windowEnd.getTime() + 60_000)
    const work = async (session) => {
      const txOptions = { ...options, ...(session ? { session } : {}) }
      for (const oldKeyHash of rotationKeyHashes) {
        const oldBuckets = await this.collection('rateLimitBuckets').find({ scope, subjectType, keyHash: oldKeyHash }, txOptions).toArray()
        for (const oldBucket of oldBuckets) {
          if (!keyring.acceptsVersion(oldBucket.keyVersion) || !keyring.matchesFingerprint(oldBucket.keyVersion, oldBucket.keyFingerprint)) throw new Error('unknown or retired rate-limit key version')
          const current = await this.collection('rateLimitBuckets').findOne({ scope, subjectType, keyHash, windowStart: oldBucket.windowStart }, txOptions)
          if (current) {
            if (current.keyVersion !== keyVersion || !keyring.matchesFingerprint(current.keyVersion, current.keyFingerprint)) throw new Error('unknown or retired rate-limit key version')
            const merged = await this.collection('rateLimitBuckets').updateOne({ _id: current._id, keyVersion, keyFingerprint, count: current.count }, { $set: { count: Math.min(current.limit, current.count + oldBucket.count), updatedAt: now } }, txOptions)
            if (merged.matchedCount !== 1) throw new Error('rate-limit rotation compare-and-set failed')
            await this.collection('rateLimitBuckets').deleteOne({ _id: oldBucket._id }, txOptions)
          } else {
            const moved = await this.collection('rateLimitBuckets').updateOne({ _id: oldBucket._id, keyHash: oldKeyHash, keyVersion: oldBucket.keyVersion, keyFingerprint: oldBucket.keyFingerprint }, { $set: { keyHash, keyVersion, keyFingerprint, updatedAt: now } }, txOptions)
            if (moved.matchedCount !== 1) throw new Error('rate-limit rotation compare-and-set failed')
          }
        }
      }
      const existing = await this.collection('rateLimitBuckets').findOne({ scope, subjectType, keyHash, windowStart }, txOptions)
      if (existing && (existing.keyVersion !== keyVersion || !keyring.matchesFingerprint(existing.keyVersion, existing.keyFingerprint))) throw new Error('unknown or retired rate-limit key version')
      if (existing && existing.count >= policy.limit) return { allowed: false, count: existing.count, limit: policy.limit, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1000)), bucket: existing }
      const filter = { scope, subjectType, keyHash, windowStart, keyVersion, keyFingerprint, count: { $lt: policy.limit } }
      const update = { $set: { limit: policy.limit, expiresAt, updatedAt: now, keyFingerprint }, $setOnInsert: { _id: new ObjectId() }, $inc: { count: 1 } }
      const bucket = await this.collection('rateLimitBuckets').findOneAndUpdate(filter, update, { ...txOptions, upsert: !existing, returnDocument: 'after' })
      return { allowed: Boolean(bucket && bucket.count <= policy.limit), count: bucket?.count ?? policy.limit, limit: policy.limit, retryAfterSeconds: Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1000)), bucket }
    }
    if (options.session) return work(options.session)
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.withTransaction(work)
      } catch (error) {
        if (error?.code !== 11000 || attempt === 2) throw error
        lastError = error
      }
    }
    throw lastError
  }

  async consolidateRateLimitKey({ scope, subjectType, oldKeyHash, currentKeyHash, currentKeyVersion, keyring }, options = {}) {
    if (!isScopeSubjectPairValid(scope, subjectType)) throw new Error('invalid rate-limit scope ownership')
    const work = async (session) => {
      const txOptions = { ...options, ...(session ? { session } : {}) }
      const oldBucket = await this.collection('rateLimitBuckets').findOne({ scope, subjectType, keyHash: oldKeyHash }, txOptions)
      if (!oldBucket) return { moved: false }
      if (!keyring?.acceptsVersion?.(oldBucket.keyVersion) || !keyring.matchesFingerprint(oldBucket.keyVersion, oldBucket.keyFingerprint)) throw new Error('unknown or retired rate-limit key version')
      const current = await this.collection('rateLimitBuckets').findOne({ scope, subjectType, keyHash: currentKeyHash, windowStart: oldBucket.windowStart }, txOptions)
      if (current) {
        if (current.keyVersion !== currentKeyVersion || !keyring.matchesFingerprint(current.keyVersion, current.keyFingerprint)) throw new Error('unknown or retired rate-limit key version')
        const currentKeyFingerprint = keyring.fingerprint(currentKeyVersion)
        const merged = await this.collection('rateLimitBuckets').updateOne({ _id: current._id, keyVersion: currentKeyVersion, keyFingerprint: currentKeyFingerprint, count: current.count }, { $set: { count: Math.min(current.limit, current.count + oldBucket.count), updatedAt: new Date() } }, txOptions)
        if (merged.matchedCount !== 1) throw new Error('rate-limit rotation compare-and-set failed')
        await this.collection('rateLimitBuckets').deleteOne({ _id: oldBucket._id }, txOptions)
        return { moved: true, merged: true }
      }
      const moved = await this.collection('rateLimitBuckets').updateOne({ _id: oldBucket._id, keyHash: oldKeyHash, keyVersion: oldBucket.keyVersion, keyFingerprint: oldBucket.keyFingerprint }, { $set: { keyHash: currentKeyHash, keyVersion: currentKeyVersion, keyFingerprint: keyring.fingerprint(currentKeyVersion), updatedAt: new Date() } }, txOptions)
      if (moved.matchedCount !== 1) throw new Error('rate-limit rotation compare-and-set failed')
      return { moved: true, merged: false }
    }
    return options.session ? work(options.session) : this.withTransaction(work)
  }

  async assertActiveSessionForUser({ sessionId, userId, sessionVersion, role, now = new Date() } = {}, options = {}) {
    const session = options.session
    const touchedSession = await this.collection('sessions').updateOne({ _id: idValue(sessionId), userId: idValue(userId), userSessionVersion: sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { $set: { lastSeenAt: now } }, { ...(session ? { session } : {}) })
    if (touchedSession.matchedCount !== 1) return false
    const touchedUser = await this.collection('users').updateOne({ _id: idValue(userId), status: 'active', sessionVersion, ...(role ? { role } : {}) }, { $set: { updatedAt: now } }, { ...(session ? { session } : {}) })
    return touchedUser.matchedCount === 1
  }

  async insertAudit(document, options = {}) {
    const rule = AUDIT_RULES[document.action]
    if (!rule || document.reasonCode !== rule.reasonCode || !Array.isArray(document.changedFields) || document.changedFields.length !== rule.changedFields.length || document.changedFields.some((field, index) => field !== rule.changedFields[index])) throw new Error('audit action or reason code is not allowlisted')
    if (document.stateTransition && !((document.action === 'user_suspended' && document.stateTransition.from === 'active' && document.stateTransition.to === 'suspended') || (document.action === 'user_restored' && document.stateTransition.from === 'suspended' && document.stateTransition.to === 'active'))) throw new Error('audit state transition is not allowlisted')
    if (!document.eventId || !document.actorId || !document.targetId || !document.requestId) throw new Error('audit identity fields are required')
    if (!['admin', 'user', 'system-worker'].includes(document.actorType) || document.targetType !== 'user' || !['pending', 'succeeded', 'failed'].includes(document.result ?? 'succeeded')) throw new Error('audit identity is invalid')
    const safe = {
      _id: document._id ?? new ObjectId(),
      eventId: String(document.eventId), actorType: document.actorType, actorId: auditIdValue(document.actorId), action: document.action,
      targetType: document.targetType, targetId: auditIdValue(document.targetId), changedFields: [...document.changedFields], reasonCode: document.reasonCode,
      stateTransition: document.stateTransition, requestId: String(document.requestId), result: document.result ?? 'succeeded', createdAt: nowDate(document.createdAt),
    }
    if (safe.stateTransition === undefined) delete safe.stateTransition
    const existing = await this.collection('adminAuditLogs').findOne({ eventId: safe.eventId }, options)
    if (existing) {
      if (!auditIdentityMatches(existing, safe)) throw new Error('audit event identity collision')
      return existing
    }
    try {
      await this.collection('adminAuditLogs').insertOne(safe, options)
    } catch (error) {
      if (error?.code !== 11000) throw error
      const replay = await this.collection('adminAuditLogs').findOne({ eventId: safe.eventId }, options)
      if (replay) {
        if (!auditIdentityMatches(replay, safe)) throw new Error('audit event identity collision', { cause: error })
        return replay
      }
      throw error
    }
    return safe
  }

  async listAudit(filter = {}, options = {}) {
    return this.collection('adminAuditLogs').find(filter, options).sort({ createdAt: -1, _id: -1 }).limit(100).toArray()
  }

  async saveArticle(userId, articleId, options = {}) {
    const document = { _id: new ObjectId(), userId: idValue(userId), articleId: idValue(articleId), createdAt: new Date() }
    await this.collection('savedArticles').updateOne({ userId: document.userId, articleId: document.articleId }, { $setOnInsert: document }, { ...options, upsert: true })
    return document
  }

  async unsaveArticle(userId, articleId, options = {}) {
    return this.collection('savedArticles').deleteOne({ userId: idValue(userId), articleId: idValue(articleId) }, options)
  }

  async listSavedArticles(userId, { skip = 0, limit = 50 } = {}, options = {}) {
    return this.collection('savedArticles').find({ userId: idValue(userId) }, options).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray()
  }
}

export { idValue, cloneForApi }
