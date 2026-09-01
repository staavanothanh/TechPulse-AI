import { ObjectId } from 'mongodb'
import {
  canCompleteDeletion,
  deletionCompletion,
} from '../../application/account-deletion/service.js'

const CURSOR_PREFIX = 'v1.'

function objectId(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  throw new Error('account deletion identifier is invalid')
}
function operationOptions({ signal, deadline } = {}) {
  const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : new Date(deadline).getTime()
  if (!Number.isFinite(deadlineAt) && deadlineAt !== Number.POSITIVE_INFINITY) throw new Error('Account deletion operation deadline is invalid')
  const remainingMs = deadlineAt === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadlineAt - Date.now()
  return {
    ...(signal ? { signal } : {}),
    ...(deadlineAt !== Number.POSITIVE_INFINITY ? { maxTimeMS: Math.max(1, Math.floor(remainingMs)) } : {}),
  }
}

function requestHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('account deletion request hash is required')
  return value
}

function encodeCursor(document) {
  const payload = JSON.stringify({
    requestedAt: document.requestedAt.toISOString(),
    id: document._id.toHexString(),
  })
  return `${CURSOR_PREFIX}${Buffer.from(payload).toString('base64url')}`
}

function decodeCursor(value) {
  if (typeof value !== 'string' || !value.startsWith(CURSOR_PREFIX))
    throw new Error('account deletion cursor is invalid')
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'),
    )
    const requestedAt = new Date(parsed.requestedAt)
    if (!ObjectId.isValid(parsed.id) || Number.isNaN(requestedAt.getTime()))
      throw new Error('invalid cursor')
    return { requestedAt, id: new ObjectId(parsed.id) }
  } catch {
    const error = new Error('account deletion cursor is invalid')
    error.status = 422
    error.code = 'validation_error'
    throw error
  }
}

export class MongoAccountDeletionRepository {
  constructor(context) {
    if (!context?.db) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.governanceDb = context.governanceDb
    this.quotaKeyring = context.quotaKeyring
    this.governanceKeyring = context.governanceKeyring
    this.clock = context.now ?? (() => new Date())
  }
  collection(name) {
    return this.db.collection(name)
  }
  auditLogs() {
    return this.collection('adminAuditLogs')
  }
  withTransaction(work, transactionOptions = {}) {
    const session = this.client?.startSession?.()
    if (!session) throw new Error('Mongo transaction session is required')
    return session
      .withTransaction(() => work(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        ...transactionOptions,
      })
      .finally(() => session.endSession())
  }
  async assertActiveSessionForUser(
    { sessionId, userId, sessionVersion, role, now = this.clock() } = {},
    options = {},
  ) {
    const session = options.session
    const sessionResult = await this.collection('sessions').updateOne(
      {
        _id: objectId(sessionId),
        userId: objectId(userId),
        userSessionVersion: sessionVersion,
        status: 'active',
        expiresAt: { $gt: now },
        absoluteExpiresAt: { $gt: now },
      },
      { $set: { lastSeenAt: now } },
      { ...(session ? { session } : {}) },
    )
    if (sessionResult.matchedCount !== 1) return false
    const userResult = await this.collection('users').updateOne(
      { _id: objectId(userId), status: 'active', sessionVersion, ...(role ? { role } : {}) },
      { $set: { updatedAt: now } },
      { ...(session ? { session } : {}) },
    )
    return userResult.matchedCount === 1
  }
  async findByUserId(userId, options = {}) {
    return this.collection('accountDeletionRequests').findOne({ userId: objectId(userId) }, options)
  }
  async findById(requestId, options = {}) {
    return this.collection('accountDeletionRequests').findOne({ _id: objectId(requestId) }, options)
  }
  async markUserDeletionPending(userId, { session, now, expectedSessionVersion } = {}) {
    const filter = { _id: objectId(userId), status: 'active' }
    if (Number.isInteger(expectedSessionVersion)) filter.sessionVersion = expectedSessionVersion
    const result = await this.collection('users').updateOne(
      filter,
      {
        $set: { status: 'deletion-pending', deletionRequestedAt: now, updatedAt: now },
        $inc: { sessionVersion: 1 },
      },
      { session },
    )
    return result.matchedCount === 1
  }
  async insertAudit({
    action,
    targetId,
    actor,
    request,
    session,
    now = this.clock(),
    result = 'pending',
    options = {},
  } = {}) {
    const rules = {
      account_deletion_requested: {
        reasonCode: 'account_deletion_requested',
        changedFields: ['status'],
        actorType: 'user',
      },
      account_deletion_retry_requested: {
        reasonCode: 'account_deletion_retry_requested',
        changedFields: ['status', 'attempt'],
        actorType: 'admin',
      },
      workflow_completed: {
        reasonCode: 'workflow_completed',
        changedFields: ['status', 'completion'],
        actorType: 'system-worker',
      },
      workflow_failed: {
        reasonCode: 'workflow_failed',
        changedFields: ['status', 'completion', 'error'],
        actorType: 'system-worker',
      },
    }
    const rule = rules[action]
    if (!rule || !actor || !targetId || !request?.requestId)
      throw new Error('account deletion audit is not allowlisted')
    const actorId =
      rule.actorType === 'system-worker'
        ? String(actor._id ?? actor.id)
        : objectId(actor._id ?? actor.id)
    const target = objectId(targetId)
    const eventId = `account-deletion:${action}:${target.toHexString()}:${String(request.requestId)}`
    if (!['pending', 'succeeded', 'failed'].includes(result))
      throw new Error('Account deletion audit result is invalid')
    const document = {
      _id: new ObjectId(),
      eventId,
      actorType: rule.actorType,
      actorId,
      action,
      targetType: 'account-deletion',
      targetId: target,
      changedFields: rule.changedFields,
      reasonCode: rule.reasonCode,
      requestId: String(request.requestId),
      result,
      createdAt: now,
    }
    const existing = await this.auditLogs().findOne({ eventId }, { session, ...options })
    if (existing?.eventId === eventId) return existing
    await this.auditLogs().insertOne(document, { session, ...options })
    return document
  }
  async revokeSessions(userId, options = {}) {
    return this.collection('sessions').updateMany(
      { userId: objectId(userId), status: 'active' },
      { $set: { status: 'revoked', revokedAt: this.clock(), expiresAt: this.clock() } },
      options,
    )
  }
  async create(
    { userId, actorScope, idempotencyKey, requestHash: hash, now, completion } = {},
    options = {},
  ) {
    const document = {
      _id: new ObjectId(),
      userId: objectId(userId),
      actorScope,
      idempotencyKey,
      requestHash: requestHash(hash),
      status: 'queued',
      attempt: 1,
      priority: 50,
      availableAt: now,
      agingEligibleAt: new Date(now.getTime() + 300000),
      idempotencyExpiresAt: new Date(now.getTime() + 14 * 86400000),
      leaseGeneration: 0,
      safeReasonCategory: 'user-request',
      completion: deletionCompletion(completion),
      error: null,
      requestedAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    }
    await this.collection('accountDeletionRequests').insertOne(document, options)
    return document
  }
  async list(query = {}) {
    const limit = Number(query.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      const error = new Error('Account deletion limit is invalid')
      error.status = 422
      error.code = 'validation_error'
      throw error
    }
    if (query.status && !['queued', 'running', 'completed', 'failed'].includes(query.status)) {
      const error = new Error('Account deletion status is invalid')
      error.status = 422
      error.code = 'validation_error'
      throw error
    }
    const filter = query.status ? { status: query.status } : {}
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor)
      filter.$or = [
        { requestedAt: { $lt: cursor.requestedAt } },
        { requestedAt: cursor.requestedAt, _id: { $lt: cursor.id } },
      ]
    }
    const rows = await this.collection('accountDeletionRequests')
      .find(filter, {
        projection: {
          _id: 1,
          status: 1,
          priority: 1,
          attempt: 1,
          availableAt: 1,
          completion: 1,
          error: 1,
          requestedAt: 1,
          startedAt: 1,
          completedAt: 1,
        },
      })
      .sort({ requestedAt: -1, _id: -1 })
      .limit(limit + 1)
      .toArray()
    const page = rows.slice(0, limit)
    return {
      data: page,
      hasNext: rows.length > limit,
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
    }
  }
  async retry({ deletionRequestId, idempotencyKey, actor, request, now, session } = {}) {
    const options = session ? { session } : {}
    const current = await this.findById(deletionRequestId, options)
    if (!current) return null
    if (current.status !== 'failed') {
      const error = new Error('Deletion workflow is not retryable')
      error.status = 409
      error.code = 'conflict'
      throw error
    }
    if (
      current.idempotencyKey === idempotencyKey &&
      request?.requestHash &&
      current.requestHash !== requestHash(request.requestHash)
    ) {
      const error = new Error('Idempotency key was reused for a different request')
      error.status = 409
      error.code = 'conflict'
      throw error
    }
    const result = await this.collection('accountDeletionRequests').findOneAndUpdate(
      { _id: objectId(deletionRequestId), status: 'failed' },
      {
        $set: { status: 'queued', availableAt: now, error: null, updatedAt: now },
        $inc: { attempt: 1 },
      },
      { ...options, returnDocument: 'after' },
    )
    if (result)
      await this.insertAudit({
        action: 'account_deletion_retry_requested',
        targetId: deletionRequestId,
        actor,
        request: { requestId: request?.serverRequestId ?? idempotencyKey },
        session,
        now,
        result: 'succeeded',
      })
    return result
  }
  async selectDue({ now = this.clock(), signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const filter = { status: 'queued', availableAt: { $lte: now } }
    const aged = await this.collection('accountDeletionRequests')
      .find({ ...filter, agingEligibleAt: { $lte: now } }, options)
      .sort({ agingEligibleAt: 1, availableAt: 1, requestedAt: 1, _id: 1 })
      .hint('account_deletion_aged')
      .limit(1)
      .next()
    if (aged) return aged
    return this.collection('accountDeletionRequests')
      .find({ ...filter, agingEligibleAt: { $gt: now } }, options)
      .sort({ priority: -1, availableAt: 1, requestedAt: 1, _id: 1 })
      .hint('account_deletion_normal')
      .limit(1)
      .next()
  }
  async nextAvailableAt({ signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return (
      (
        await this.collection('accountDeletionRequests')
          .find({ status: 'queued' }, options)
          .sort({ availableAt: 1, _id: 1 })
          .project({ availableAt: 1 })
          .limit(1)
          .next()
      )?.availableAt ?? null
    )
  }
  async claim({ candidate, job = candidate, now = this.clock(), ownerToken, signal, deadline } = {}) {
    if (!/^[a-f0-9]{64}$/.test(ownerToken ?? ''))
      throw new Error('Account deletion lease owner is invalid')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const result = await this.collection('accountDeletionRequests').findOneAndUpdate(
      { _id: objectId(job._id ?? job.id), status: 'queued', availableAt: { $lte: now } },
      {
        $set: {
          status: 'running',
          startedAt: now,
          leaseOwner: ownerToken,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          updatedAt: now,
        },
        $inc: { leaseGeneration: 1 },
      },
      { returnDocument: 'after', ...options },
    )
    return result
  }
  async deferClaimed({ job, now = this.clock(), ownerToken, delayMs = 5 * 60 * 1000, signal, deadline } = {}) {
    if (!/^[a-f0-9]{64}$/.test(ownerToken ?? '')) throw new Error('Account deletion lease owner is invalid')
    if (!Number.isInteger(delayMs) || delayMs < 1_000 || delayMs > 15 * 60 * 1000) throw new Error('Account deletion defer duration is invalid')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return this.collection('accountDeletionRequests').findOneAndUpdate(
      {
        _id: objectId(job._id ?? job.id),
        status: 'running',
        leaseGeneration: job.leaseGeneration,
        leaseOwner: ownerToken,
        leaseExpiresAt: { $gt: now },
      },
      {
        $set: { status: 'queued', availableAt: new Date(now.getTime() + delayMs), updatedAt: now },
        $unset: { startedAt: '', leaseOwner: '', leaseExpiresAt: '' },
      },
      { returnDocument: 'after', ...options },
    )
  }
  async withCleanupTransaction(work, transactionOptions = {}) {
    const session = this.client?.startSession?.()
    if (!session) throw new Error('Mongo transaction session is required')
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        ...transactionOptions,
      })
    } finally {
      await session.endSession()
    }
  }
  async assertCleanupFence({ job, userId, now, session, allowDeleted = false, options = {} } = {}) {
    const requestFilter = {
      _id: objectId(job._id ?? job.id),
      status: 'running',
      leaseGeneration: job.leaseGeneration,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: { $gt: now },
    }
    const touched = await this.collection('accountDeletionRequests').updateOne(
      requestFilter,
      { $set: { updatedAt: now } },
      { session, ...options },
    )
    if (touched.matchedCount !== 1)
      throw new Error('Account deletion lease fence is stale or expired')
    const userFilter = allowDeleted
      ? { _id: userId, status: { $in: ['deletion-pending', 'deleted'] } }
      : { _id: userId, status: 'deletion-pending' }
    const user = await this.collection('users').findOne(userFilter, { session, ...options })
    if (!user) throw new Error('Account deletion user fence changed')
    return user
  }
  async cleanupCollection({ job, userId, flag, collectionName, now, session, options = {} } = {}) {
    await this.assertCleanupFence({ job, userId, now, session, options })
    const collection = this.collection(collectionName)
    await collection.deleteMany({ userId }, { session, ...options })
    const remaining = await collection.countDocuments({ userId }, { session, ...options })
    if (remaining !== 0)
      throw new Error(`Account deletion ${collectionName} cleanup did not reach zero`)
    const checkpoint = await this.collection('accountDeletionRequests').updateOne(
      {
        _id: objectId(job._id ?? job.id),
        status: 'running',
        leaseGeneration: job.leaseGeneration,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      { $set: { [`completion.${flag}`]: true, updatedAt: now } },
      { session, ...options },
    )
    if (checkpoint.matchedCount !== 1)
      throw new Error('Account deletion cleanup checkpoint fence changed')
  }
  async cleanupQuota({ job, userId, now, session, options = {} } = {}) {
    if (!this.quotaKeyring?.versions?.length || typeof this.quotaKeyring.digest !== 'function')
      throw new Error('Quota key lifecycle configuration is unavailable')
    await this.assertCleanupFence({ job, userId, now, session, options })
    const hashes = this.quotaKeyring.versions.map((version) =>
      this.quotaKeyring.digest(userId.toHexString?.() ?? String(userId), version),
    )
    const buckets = this.collection('rateLimitBuckets')
    await buckets.deleteMany({ subjectType: 'user', keyHash: { $in: hashes } }, { session, ...options })
    const remaining = await buckets.countDocuments(
      { subjectType: 'user', keyHash: { $in: hashes } },
      { session, ...options },
    )
    if (remaining !== 0) throw new Error('Account deletion quota cleanup did not reach zero')
    const checkpoint = await this.collection('accountDeletionRequests').updateOne(
      {
        _id: objectId(job._id ?? job.id),
        status: 'running',
        leaseGeneration: job.leaseGeneration,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      { $set: { 'completion.userQuotaDataDeleted': true, updatedAt: now } },
      { session, ...options },
    )
    if (checkpoint.matchedCount !== 1)
      throw new Error('Account deletion quota cleanup checkpoint fence changed')
  }
  async anonymizeUser({ job, userId, now, session, options = {} } = {}) {
    const user = await this.assertCleanupFence({ job, userId, now, session, allowDeleted: true, options })
    const deletionRequestId = objectId(job._id ?? job.id)
    if (user.status === 'deleted') {
      if (String(user.deletionRequestId) !== String(deletionRequestId))
        throw new Error('Account deletion tombstone belongs to another request')
    } else {
      const tombstone = {
        _id: user._id,
        status: 'deleted',
        deletionRequestedAt: user.deletionRequestedAt ?? now,
        deletionRequestId,
        deletedAt: now,
        sessionVersion: user.sessionVersion,
        createdAt: user.createdAt,
        updatedAt: now,
      }
      const replaced = await this.collection('users').replaceOne(
        { _id: userId, status: 'deletion-pending' },
        tombstone,
        { session, ...options },
      )
      if (replaced.matchedCount !== 1) throw new Error('Account deletion tombstone fence changed')
    }
    const checkpoint = await this.collection('accountDeletionRequests').updateOne(
      {
        _id: deletionRequestId,
        status: 'running',
        leaseGeneration: job.leaseGeneration,
        leaseOwner: job.leaseOwner,
        leaseExpiresAt: { $gt: now },
      },
      { $set: { 'completion.identityAnonymized': true, updatedAt: now } },
      { session, ...options },
    )
    if (checkpoint.matchedCount !== 1)
      throw new Error('Account deletion identity checkpoint fence changed')
  }
  async applyCleanup({ job, now = this.clock(), signal, deadline } = {}) {
    const userId = objectId(job.userId)
    const options = operationOptions({ signal, deadline })
    const transactionOptions = options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {}
    signal?.throwIfAborted?.()
    const completion = deletionCompletion(job.completion)
    const cleanupSteps = [
      ['sessionsDeleted', 'sessions'],
      ['savedArticlesDeleted', 'savedArticles'],
      ['chatSessionsDeleted', 'chatSessions'],
      ['answerAttemptsDeleted', 'answerAttempts'],
    ]
    for (const [flag, collectionName] of cleanupSteps) {
      if (completion[flag]) continue
      signal?.throwIfAborted?.()
      await this.withCleanupTransaction((session) =>
        this.cleanupCollection({ job, userId, flag, collectionName, now, session, options })
      , transactionOptions)
      completion[flag] = true
    }
    if (!completion.userQuotaDataDeleted) {
      signal?.throwIfAborted?.()
      await this.withCleanupTransaction((session) =>
        this.cleanupQuota({ job, userId, now, session, options })
      , transactionOptions)
      completion.userQuotaDataDeleted = true
    }
    if (!completion.identityAnonymized) {
      signal?.throwIfAborted?.()
      await this.withCleanupTransaction((session) =>
        this.anonymizeUser({ job, userId, now, session, options })
      , transactionOptions)
      completion.identityAnonymized = true
    }
    return deletionCompletion({ ...completion, sessionsRevoked: true })
  }
  async complete({ job, completion, now = this.clock(), signal, deadline } = {}) {
    if (!canCompleteDeletion({ completion, error: null })) return false
    if (!this.governanceDb)
      throw new Error('Governance database is required for account deletion completion')
    const session = this.client?.startSession?.()
    if (!session) throw new Error('Mongo transaction session is required')
    const options = operationOptions({ signal, deadline })
    const transactionOptions = options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {}
    signal?.throwIfAborted?.()
    try {
      let matched = 0
      await session.withTransaction(
        async () => {
          signal?.throwIfAborted?.()
          const result = await this.collection('accountDeletionRequests').updateOne(
            {
              _id: objectId(job._id ?? job.id),
              status: 'running',
              leaseGeneration: job.leaseGeneration,
              leaseOwner: job.leaseOwner,
              leaseExpiresAt: { $gt: now },
            },
            {
              $set: {
                status: 'completed',
                completion,
                error: null,
                completedAt: now,
                purgeAfter: new Date(now.getTime() + 90 * 86400000),
                updatedAt: now,
              },
              $unset: { leaseOwner: '', leaseExpiresAt: '', startedAt: '' },
            },
            { session, ...options },
          )
          if (result.matchedCount !== 1)
            throw new Error('Account deletion completion fence changed')
          if (
            !this.governanceKeyring?.versions?.length ||
            typeof this.governanceKeyring.digest !== 'function' ||
            !Number.isInteger(this.governanceKeyring.currentVersion)
          )
            throw new Error('Governance signing/key lifecycle configuration is unavailable')
          const requestId = objectId(job._id ?? job.id)
          await this.insertAudit({
            action: 'workflow_completed',
            targetId: requestId,
            actor: { _id: 'system:account-deletion', role: 'system-worker' },
            request: {
              requestId: `account-deletion:${requestId.toHexString()}:${job.attempt ?? 1}`,
            },
            session,
            now,
            result: 'succeeded',
            options,
          })
          signal?.throwIfAborted?.()
          await this.governanceDb
            .collection('governanceSuppressions')
            .insertOne(
              {
                _id: new ObjectId(),
                eventId: `account-deletion:${requestId.toHexString()}:${job.attempt ?? 1}`,
                kind: 'account-deletion',
                requestId,
                userId: objectId(job.userId),
                effectiveAt: now,
                payloadDigest: this.governanceKeyring.digest(String(job._id)),
                signatureKeyVersion: this.governanceKeyring.currentVersion,
                signature: this.governanceKeyring.digest(`suppression:${job._id}`),
                createdAt: now,
              },
              { session, ...options },
            )
          matched = 1
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, ...transactionOptions },
      )
      return matched === 1
    } finally {
      await session.endSession()
    }
  }
  async fail({ job, error, completion, now = this.clock(), signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return this.withCleanupTransaction(async (session) => {
      signal?.throwIfAborted?.()
      const requestId = objectId(job._id ?? job.id)
      const result = await this.collection('accountDeletionRequests').updateOne(
        {
          _id: requestId,
          status: 'running',
          leaseGeneration: job.leaseGeneration,
          leaseOwner: job.leaseOwner,
          leaseExpiresAt: { $gt: now },
        },
        {
          $set: { status: 'failed', error, ...(completion ? { completion } : {}), updatedAt: now },
          $unset: { startedAt: '', leaseOwner: '', leaseExpiresAt: '' },
        },
        { session, ...options },
      )
      if (result.matchedCount !== 1) return result
      await this.insertAudit({
        action: 'workflow_failed',
        targetId: requestId,
        actor: { _id: 'system:account-deletion', role: 'system-worker' },
        request: {
          requestId: `account-deletion-failed:${requestId.toHexString()}:${job.attempt ?? 1}`,
        },
        session,
        now,
        result: 'failed',
        options,
      })
      return result
    }, options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {})
  }
  async recoverExpired({ now = this.clock(), limit = 10, signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const filter = { status: 'running', leaseExpiresAt: { $type: 'date', $lte: now } }
    const requests = this.collection('accountDeletionRequests')
    const cursor = Object.keys(options).length > 0 ? requests.find(filter, options) : requests.find(filter)
    const rows = await cursor
      .sort({ leaseExpiresAt: 1, _id: 1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .toArray()
    let recovered = 0
    for (const row of rows) {
      signal?.throwIfAborted?.()
      const update = {
        $set: { status: 'queued', availableAt: now, error: null, updatedAt: now },
        $unset: { startedAt: '', leaseOwner: '', leaseExpiresAt: '' },
        $inc: { attempt: 1 },
      }
      const result = Object.keys(options).length > 0
        ? await requests.updateOne({
          _id: row._id,
          status: 'running',
          leaseGeneration: row.leaseGeneration,
          leaseOwner: row.leaseOwner,
          leaseExpiresAt: row.leaseExpiresAt,
        }, update, options)
        : await requests.updateOne({
          _id: row._id,
          status: 'running',
          leaseGeneration: row.leaseGeneration,
          leaseOwner: row.leaseOwner,
          leaseExpiresAt: row.leaseExpiresAt,
        }, update)
      recovered += result.matchedCount ?? 0
    }
    return { inspected: rows.length, recovered, retriesCreated: 0, failed: rows.length - recovered }
  }
  async purge({ cutoff = this.clock(), limit = 100 } = {}) {
    const filter = { status: 'completed', purgeAfter: { $lte: cutoff } }
    const rows = await this.collection('accountDeletionRequests')
      .find(filter)
      .sort({ purgeAfter: 1, _id: 1 })
      .limit(limit + 1)
      .project({ _id: 1 })
      .toArray()
    const selected = rows.slice(0, limit)
    const result = selected.length
      ? await this.collection('accountDeletionRequests').deleteMany({
          ...filter,
          _id: { $in: selected.map(({ _id }) => _id) },
        })
      : { deletedCount: 0 }
    return {
      inspected: selected.length,
      affected: result.deletedCount,
      hasMore: rows.length > limit,
    }
  }
}
