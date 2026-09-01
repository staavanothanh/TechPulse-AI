import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { createJobAuditEvent, validateJobAuditInput } from '../../audit/job-writer.js'
import { JobError, canonicalRequestHash, resolveIdempotentJob } from '../../domain/jobs/idempotency.js'
import { safeErrorCode } from '../../jobs/runtime-trace.js'

const STATUSES = new Set(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'])
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

export const INGESTION_JOB_LIST_PROJECTION = Object.freeze({
  _id: 1,
  idempotencyKey: 1,
  sourceId: 1,
  connectorType: 1,
  expectedSourcePolicyVersion: 1,
  trigger: 1,
  status: 1,
  attempt: 1,
  availableAt: 1,
  leaseGeneration: 1,
  batchSize: 1,
  parentJobId: 1,
  counters: 1,
  error: 1,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 1,
})
const DAY_MS = 24 * 60 * 60 * 1000

function idValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new JobError(400, 'bad_request', 'Mongo identifier is invalid')
}

function auditId(value) {
  if (value instanceof ObjectId || typeof value === 'string' && ObjectId.isValid(value)) return idValue(value)
  if (typeof value === 'string' && /^[a-z][a-z0-9:-]{2,127}$/.test(value)) return value
  throw new Error('Audit identifier is invalid')
}

function dateValue(value, label = 'Job date') {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid`)
  return value
}
function operationOptions({ signal, deadline } = {}) {
  const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : new Date(deadline).getTime()
  if (!Number.isFinite(deadlineAt) && deadlineAt !== Number.POSITIVE_INFINITY) throw new Error('Job operation deadline is invalid')
  const remainingMs = deadlineAt === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadlineAt - Date.now()
  return {
    ...(signal ? { signal } : {}),
    ...(deadlineAt !== Number.POSITIVE_INFINITY ? { maxTimeMS: Math.max(1, Math.floor(remainingMs)) } : {}),
  }
}
function transactionOptions(options = {}) {
  return options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {}
}

function safeErrorDocument(error) {
  if (!error) return undefined
  const result = { code: safeErrorCode(error.code), message: 'Ingestion job did not complete safely', retryable: Boolean(error.retryable), occurredAt: dateValue(error.occurredAt) }
  if (Number.isInteger(error.upstreamStatus)) result.upstreamStatus = error.upstreamStatus
  return result
}

function jobDocument(job) {
  return {
    _id: idValue(job.id), idempotencyKey: job.idempotencyKey, actorScope: job.actorScope, requestHash: job.requestHash,
    sourceId: idValue(job.sourceId), connectorType: job.connectorType, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    trigger: job.trigger, ...(job.requestedBy ? { requestedBy: idValue(job.requestedBy) } : {}), ...(job.parentJobId ? { parentJobId: idValue(job.parentJobId) } : {}),
    status: job.status, attempt: job.attempt, priority: job.priority, availableAt: dateValue(job.availableAt), agingEligibleAt: dateValue(job.agingEligibleAt),
    idempotencyExpiresAt: dateValue(job.idempotencyExpiresAt), leaseGeneration: job.leaseGeneration, batchSize: job.batchSize,
    ...(job.checkpoint ? { checkpoint: { ...job.checkpoint } } : {}), counters: { ...job.counters },
    ...(job.cancellationRequestedAt ? { cancellationRequestedAt: dateValue(job.cancellationRequestedAt) } : {}),
    ...(job.error ? { error: safeErrorDocument(job.error) } : {}),
    createdAt: dateValue(job.createdAt), ...(job.startedAt ? { startedAt: dateValue(job.startedAt) } : {}),
    ...(job.heartbeatAt ? { heartbeatAt: dateValue(job.heartbeatAt) } : {}), ...(job.finishedAt ? { finishedAt: dateValue(job.finishedAt) } : {}),
    ...(job.purgeAfter ? { purgeAfter: dateValue(job.purgeAfter) } : {}), updatedAt: dateValue(job.updatedAt),
  }
}

export function serializeIngestionJob(document) {
  if (!document) return null
  return {
    id: document._id.toHexString(), idempotencyKey: document.idempotencyKey, actorScope: document.actorScope, requestHash: document.requestHash,
    sourceId: document.sourceId.toHexString(), connectorType: document.connectorType, expectedSourcePolicyVersion: document.expectedSourcePolicyVersion,
    trigger: document.trigger, requestedBy: document.requestedBy?.toHexString(), parentJobId: document.parentJobId?.toHexString(), status: document.status,
    attempt: document.attempt, priority: document.priority, availableAt: document.availableAt, agingEligibleAt: document.agingEligibleAt,
    idempotencyExpiresAt: document.idempotencyExpiresAt, leaseGeneration: Number(document.leaseGeneration), batchSize: document.batchSize,
    checkpoint: document.checkpoint ? { ...document.checkpoint } : undefined, counters: { ...document.counters }, cancellationRequestedAt: document.cancellationRequestedAt,
    error: document.error ? { ...document.error } : undefined, createdAt: document.createdAt, startedAt: document.startedAt, heartbeatAt: document.heartbeatAt,
    finishedAt: document.finishedAt, purgeAfter: document.purgeAfter, updatedAt: document.updatedAt,
    retryAvailable: document.retryAvailable !== undefined ? Boolean(document.retryAvailable) : (['partial', 'failed'].includes(document.status) && (document.status === 'partial' || document.error?.retryable === true) && Number(document.attempt) < 3),
  }
}

function jobAuditDocument(audit) {
  validateJobAuditInput(audit)
  return {
    _id: new ObjectId(), eventId: audit.eventId, actorType: audit.actorType, actorId: auditId(audit.actorId), action: audit.action,
    targetType: 'ingestion-job', targetId: auditId(audit.targetId), changedFields: [...audit.changedFields], reasonCode: audit.reasonCode,
    requestId: audit.requestId, result: audit.result, createdAt: dateValue(audit.createdAt),
  }
}

function stableAudit(value) {
  return JSON.stringify({ eventId: value.eventId, actorType: value.actorType, actorId: String(value.actorId), action: value.action, targetId: String(value.targetId), changedFields: value.changedFields, reasonCode: value.reasonCode, requestId: value.requestId, result: value.result })
}

function recoveryChildId(parentId, nextAttempt) {
  return new ObjectId(createHash('sha256').update(`ingestion-recovery:${parentId}:${nextAttempt}`).digest('hex').slice(0, 24))
}
function recoveryChildFor(parent, now) {
  const parentId = parent._id.toHexString()
  const nextAttempt = parent.attempt + 1
  const child = {
    ...parent,
    _id: recoveryChildId(parentId, nextAttempt),
    idempotencyKey: `system-recovery:${parentId}:${nextAttempt}`,
    actorScope: 'system-recovery',
    requestHash: canonicalRequestHash({ operation: 'lease-recovery', parentJobId: parentId, nextAttempt }),
    trigger: 'retry',
    parentJobId: parent._id,
    status: 'queued',
    attempt: nextAttempt,
    availableAt: now,
    agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000),
    idempotencyExpiresAt: new Date(now.getTime() + 14 * DAY_MS),
    leaseGeneration: 0,
    counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 },
    createdAt: now,
    updatedAt: now,
  }
  for (const field of ['startedAt', 'heartbeatAt', 'finishedAt', 'purgeAfter', 'error', 'cancellationRequestedAt', 'checkpoint']) delete child[field]
  return child
}

function purgeAfterFor(status, finishedAt, idempotencyExpiresAt) {
  const retentionDays = ['failed', 'partial'].includes(status) ? 30 : 14
  return new Date(Math.max(finishedAt.getTime() + retentionDays * DAY_MS, idempotencyExpiresAt.getTime()))
}

export class MongoJobRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  jobs() { return this.db.collection('ingestionJobs') }
  leases() { return this.db.collection('jobLeases') }
  sources() { return this.db.collection('sources') }
  audits() { return this.db.collection('adminAuditLogs') }
  scheduleProgress() { return this.db.collection('ingestionScheduleProgress') }

  async withTransaction(work, transactionOptions = {}) {
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, ...transactionOptions })
      return result
    } finally { await session.endSession() }
  }

  async assertActorFence(fence, session) {
    if (!fence || !Number.isInteger(fence.sessionVersion)) return false
    const now = new Date()
    const userId = idValue(fence.userId)
    const user = await this.db.collection('users').findOne({ _id: userId, role: 'admin', status: 'active', sessionVersion: fence.sessionVersion }, { session, projection: { _id: 1 } })
    const activeSession = await this.db.collection('sessions').findOne({ _id: idValue(fence.sessionId), userId, userSessionVersion: fence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { session, projection: { _id: 1 } })
    return Boolean(user && activeSession)
  }

  async insertAudit(audit, session, options = {}) {
    const safe = jobAuditDocument(audit)
    const existing = await this.audits().findOne({ eventId: safe.eventId }, { session, ...options })
    if (existing) {
      if (stableAudit(existing) !== stableAudit(safe)) throw new JobError(409, 'idempotency_mismatch', 'Job audit identity is already bound to another event')
      return existing
    }
    await this.audits().insertOne(safe, { session, ...options })
    return safe
  }

  async existingIdempotentJob({ job, parentJobId, nextAttempt, session }) {
    const byActorKey = await this.jobs().findOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }, { session })
    if (byActorKey) return resolveIdempotentJob(serializeIngestionJob(byActorKey), job.requestHash)
    if (parentJobId) {
      const byParentAttempt = await this.jobs().findOne({ parentJobId: idValue(parentJobId), attempt: nextAttempt }, { session })
      if (byParentAttempt) return resolveIdempotentJob(serializeIngestionJob(byParentAttempt), job.requestHash)
    }
    return null
  }

  async reserveAdmission({ rateLimitAdmission, admission, session }) {
    if (!rateLimitAdmission || typeof rateLimitAdmission.reserve !== 'function') throw new JobError(503, 'service_unavailable', 'Rate-limit service is unavailable')
    let result
    try {
      result = await rateLimitAdmission.reserve({ ...admission, session })
    } catch (error) {
      if (error instanceof JobError) throw error
      if (error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) throw error
      throw new JobError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable')
    }
    if (!result || typeof result.allowed !== 'boolean') throw new JobError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable')
    if (!result.allowed) throw new JobError(429, 'rate_limit_exceeded', 'Too many manual ingestion requests', { retryAfter: result.retryAfterSeconds })
  }

  async createOrReuseIngestionJobWithAdmission({ job, audit, actorFence, rateLimitAdmission, admission, parentJobId, nextAttempt } = {}) {
    const linkedRetry = parentJobId !== undefined || nextAttempt !== undefined
    if (linkedRetry && (!parentJobId || !Number.isInteger(nextAttempt))) throw new Error('Linked retry identity is invalid')
    try {
      return await this.withTransaction(async (session) => {
        if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
        const existing = await this.existingIdempotentJob({ job, parentJobId, nextAttempt, session })
        if (existing) return existing
        await this.reserveAdmission({ rateLimitAdmission, admission, session })
        await this.jobs().insertOne(jobDocument(job), { session })
        await this.insertAudit(audit, session)
        return job
      })
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await this.existingIdempotentJob({ job, parentJobId, nextAttempt })
      if (!existing) throw error
      return existing
    }
  }

  async createIngestionJob({ job, audit, actorFence }) {
    try {
      return await this.withTransaction(async (session) => {
        if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
        const existing = await this.jobs().findOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }, { session })
        if (existing) return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
        await this.jobs().insertOne(jobDocument(job), { session })
        await this.insertAudit(audit, session)
        return job
      })
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await this.jobs().findOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey })
      return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
    }
  }

  async createLinkedRetry({ job, audit, actorFence, parentJobId, nextAttempt }) {
    const parentId = idValue(parentJobId)
    try {
      return await this.withTransaction(async (session) => {
        if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
        const existing = await this.jobs().findOne({ parentJobId: parentId, attempt: nextAttempt }, { session })
        if (existing) return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
        await this.jobs().insertOne(jobDocument(job), { session })
        await this.insertAudit(audit, session)
        return job
      })
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await this.jobs().findOne({ parentJobId: parentId, attempt: nextAttempt })
      if (!existing) throw error
      return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
    }
  }

  async createSystemIngestionJob({ job }) {
    const identity = job.parentJobId ? { parentJobId: idValue(job.parentJobId), attempt: job.attempt } : { actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }
    try {
      const existing = await this.jobs().findOne(identity)
      if (existing) return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
      await this.jobs().insertOne(jobDocument(job))
      return job
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await this.jobs().findOne(identity)
      return resolveIdempotentJob(serializeIngestionJob(existing), job.requestHash)
    }
  }

  async materializeDailyIngestion({ now = this.clock(), limit = 100, signal, deadline } = {}) {
    const materializedAt = dateValue(now, 'Scheduled materialization time')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Scheduled materialization limit is invalid')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const period = materializedAt.toISOString().slice(0, 10)
    const eligibleSources = {
      operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] },
      'technicalCheck.status': 'passed', connectorType: { $in: ['rss', 'arxiv', 'hacker-news'] },
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.withTransaction(async (session) => {
          signal?.throwIfAborted?.()
          let progress = await this.scheduleProgress().findOne({ period }, { session, ...options })
          if (!progress) {
            progress = { _id: new ObjectId(), period, createdAt: materializedAt, updatedAt: materializedAt }
            await this.scheduleProgress().insertOne(progress, { session, ...options })
          }
          if (progress.completedAt) return { inspected: 0, created: 0, hasMore: false, period }
          const filter = progress.cursorSourceId ? { ...eligibleSources, _id: { $gt: progress.cursorSourceId } } : eligibleSources
          const candidates = await this.sources().find(filter, { session, ...options }).sort({ _id: 1 }).limit(limit + 1).toArray()
          const selected = candidates.slice(0, limit)
          let created = 0
          for (const source of selected) {
            signal?.throwIfAborted?.()
            const sourceId = source._id.toHexString()
            const job = {
              id: new ObjectId().toHexString(), idempotencyKey: `daily:${period}:${sourceId}`, actorScope: 'system-cron',
              requestHash: canonicalRequestHash({ operation: 'daily-ingestion', period, sourceId, expectedSourcePolicyVersion: source.policyVersion }),
              sourceId, connectorType: source.connectorType, expectedSourcePolicyVersion: source.policyVersion, trigger: 'cron',
              status: 'queued', attempt: 1, priority: 25, availableAt: materializedAt, agingEligibleAt: new Date(materializedAt.getTime() + 30 * 60 * 1000),
              idempotencyExpiresAt: new Date(materializedAt.getTime() + 14 * DAY_MS), leaseGeneration: 0,
              batchSize: source.connectorConfig?.batchSize ?? 20, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 },
              createdAt: materializedAt, updatedAt: materializedAt,
            }
            const existing = await this.jobs().updateOne(
              { actorScope: job.actorScope, idempotencyKey: job.idempotencyKey },
              { $setOnInsert: jobDocument(job) },
              { upsert: true, session, ...options },
            )
            if (existing.upsertedCount === 1) created += 1
          }
          const hasMore = candidates.length > limit
          const update = selected.length === 0 || !hasMore
            ? { $set: { updatedAt: materializedAt, ...(selected.length > 0 ? { cursorSourceId: selected.at(-1)._id } : {}), completedAt: materializedAt } }
            : { $set: { cursorSourceId: selected.at(-1)._id, updatedAt: materializedAt } }
          const expectedProgress = {
            _id: progress._id,
            ...(progress.cursorSourceId ? { cursorSourceId: progress.cursorSourceId } : { cursorSourceId: { $exists: false } }),
            completedAt: { $exists: false },
          }
          const advanced = await this.scheduleProgress().updateOne(expectedProgress, update, { session, ...options })
          if (advanced.matchedCount !== 1) {
            const conflict = new Error('Scheduled materialization cursor changed concurrently')
            conflict.code = 'materialization_conflict'
            throw conflict
          }
          return { inspected: selected.length, created, hasMore, period }
        }, options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {})
      } catch (error) {
        if (error?.code !== 11000 && error?.code !== 'materialization_conflict') throw error
      }
    }
    throw new Error('Scheduled materialization could not advance safely')
  }

  async findIngestionJobById(jobId, options = {}) {
    const document = await this.jobs().findOne({ _id: idValue(jobId) }, options)
    if (!document) return null
    const canRetryStatus = ['failed', 'partial'].includes(document.status) && (document.status === 'partial' || document.error?.retryable === true) && Number(document.attempt) < 3
    if (canRetryStatus) {
      const child = await this.jobs().findOne({ parentJobId: document._id }, { projection: { _id: 1 }, ...options })
      document.retryAvailable = !child
    } else {
      document.retryAvailable = false
    }
    return serializeIngestionJob(document)
  }

  async listIngestionJobs(query = {}) {
    const limit = query.limit === undefined ? 20 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobError(400, 'bad_request', 'Job limit is invalid')
    const filter = {}
    if (query.status !== undefined) {
      if (!STATUSES.has(query.status)) throw new JobError(400, 'bad_request', 'Job status is invalid')
      filter.status = query.status
    }
    if (query.sourceId !== undefined) filter.sourceId = idValue(query.sourceId)
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        const date = new Date(decoded.createdAt)
        filter.$or = [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: idValue(decoded.id) } }]
      } catch { throw new JobError(400, 'bad_request', 'Job cursor is invalid') }
    }
    const documents = await this.jobs().find(filter).sort({ createdAt: -1, _id: -1 }).project(INGESTION_JOB_LIST_PROJECTION).limit(limit + 1).toArray()
    const hasNext = documents.length > limit
    const page = documents.slice(0, limit)
    const candidateParentIds = page
      .filter((doc) => ['failed', 'partial'].includes(doc.status) && (doc.status === 'partial' || doc.error?.retryable === true) && Number(doc.attempt) < 3)
      .map((doc) => doc._id)
    if (candidateParentIds.length > 0) {
      const children = await this.jobs().find({
        parentJobId: { $in: candidateParentIds },
      }).project({ parentJobId: 1 }).toArray()
      const retriedParentIds = new Set(
        children.map((child) => (child.parentJobId?.toHexString ? child.parentJobId.toHexString() : String(child.parentJobId))),
      )
      page.forEach((doc) => {
        const canRetryStatus = ['failed', 'partial'].includes(doc.status) && (doc.status === 'partial' || doc.error?.retryable === true) && Number(doc.attempt) < 3
        doc.retryAvailable = canRetryStatus && !retriedParentIds.has(doc._id.toHexString())
      })
    } else {
      page.forEach((doc) => {
        doc.retryAvailable = ['failed', 'partial'].includes(doc.status) && (doc.status === 'partial' || doc.error?.retryable === true) && Number(doc.attempt) < 3
      })
    }
    return { jobs: page.map(serializeIngestionJob), hasNext, nextCursor: hasNext ? Buffer.from(JSON.stringify({ createdAt: page.at(-1).createdAt.toISOString(), id: page.at(-1)._id.toHexString() })).toString('base64url') : null }
  }

  async selectDueIngestion({ now = new Date(), excludeSourceIds = [], signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const filter = { status: 'queued', availableAt: { $lte: now }, ...(Array.isArray(excludeSourceIds) && excludeSourceIds.length > 0 ? { sourceId: { $nin: excludeSourceIds.map((id) => idValue(id)) } } : {}) }
    const aged = await this.jobs().find({ ...filter, agingEligibleAt: { $lte: now } }, options).sort({ agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 }).hint('ingestion_due_aged').limit(1).next()
    if (aged) return serializeIngestionJob(aged)
    return serializeIngestionJob(await this.jobs().find({ ...filter, agingEligibleAt: { $gt: now } }, options).sort({ priority: -1, availableAt: 1, createdAt: 1, _id: 1 }).hint('ingestion_due_normal').limit(1).next())
  }

  async nextAvailableAt({ signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const document = await this.jobs().find({ status: 'queued' }, options).sort({ availableAt: 1, _id: 1 }).hint('ingestion_next_available').project({ availableAt: 1 }).limit(1).next()
    return document?.availableAt ?? null
  }


  async purgeDueIngestionJobs({ cutoff = new Date(), limit = 100 } = {}) {
    dateValue(cutoff, 'Retention cutoff')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Retention batch limit is invalid')
    const filter = {
      status: { $in: [...TERMINAL] },
      purgeAfter: { $lte: cutoff },
      idempotencyExpiresAt: { $lte: cutoff },
    }
    const candidates = await this.jobs().find(filter).sort({ purgeAfter: 1, _id: 1 }).hint('ingestion_purge_deadline').project({ _id: 1 }).limit(limit + 1).toArray()
    const selected = candidates.slice(0, limit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.jobs().deleteMany({ _id: { $in: selected.map((document) => document._id) }, ...filter })
    return { inspected: selected.length, affected: result.deletedCount, hasMore: candidates.length > limit }
  }

  async claimQueuedWithFence({ jobId, fence, signal, deadline } = {}) {
    const now = dateValue(this.clock(), 'Authoritative job clock')
    const options = operationOptions({ signal, deadline })
    const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : new Date(deadline).getTime()
    if (deadlineAt !== Number.POSITIVE_INFINITY && now.getTime() >= deadlineAt) throw new JobError(409, 'conflict', 'Job admission deadline exceeded')
    signal?.throwIfAborted?.()
    const transactionOptions = options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {}
    return this.withTransaction(async (session) => {
      signal?.throwIfAborted?.()
      const lease = await this.leases().updateOne({
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session, ...options })
      if (lease.matchedCount !== 1) return false
      signal?.throwIfAborted?.()
      const job = await this.jobs().updateOne({ _id: idValue(jobId), status: 'queued', availableAt: { $lte: now } }, { $set: { status: 'running', leaseGeneration: fence.leaseGeneration, startedAt: now, heartbeatAt: now, updatedAt: now } }, { session, ...options })
      if (job.matchedCount !== 1) throw new JobError(409, 'conflict', 'Job is no longer claimable')
      return true
    }, transactionOptions)
  }

  async completeWithFence({ jobId, fence, status, error, checkpoint, counters, signal, deadline } = {}) {
    if (!TERMINAL.has(status)) throw new Error('Terminal job status is invalid')
    const now = dateValue(this.clock(), 'Authoritative job clock')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return this.withTransaction(async (session) => {
      signal?.throwIfAborted?.()
      const leaseFilter = {
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session, ...options })
      if (touched.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease fence is stale or expired')
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session, ...options })
      if (!current) throw new JobError(409, 'conflict', 'Lease fence no longer owns this job')
      const source = await this.sources().findOne({
        _id: current.sourceId, policyVersion: current.expectedSourcePolicyVersion,
        operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] }, connectorType: current.connectorType,
        [`connectorConfig.kind`]: current.connectorType,
      }, { session, projection: { _id: 1 }, ...options })
      const policyMismatch = !source
      const finalStatus = policyMismatch ? 'failed' : status
      const set = { status: finalStatus, finishedAt: now, purgeAfter: purgeAfterFor(finalStatus, now, current.idempotencyExpiresAt), updatedAt: now }
      if (policyMismatch) set.error = safeErrorDocument({ code: 'source_policy_changed_mid_run', message: 'Source policy changed before completion', retryable: false, occurredAt: now })
      else {
        if (error) set.error = safeErrorDocument(error)
        if (checkpoint) set.checkpoint = { ...checkpoint }
        if (counters) set.counters = { ...counters }
      }
      await this.jobs().updateOne({ _id: current._id, status: 'running', leaseGeneration: fence.leaseGeneration }, { $set: set }, { session, ...options })
      const released = await this.leases().updateOne(leaseFilter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session, ...options })
      if (released.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease release fence failed')
      return this.findIngestionJobById(jobId, { session, ...options })
    }, options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {})
  }
  async finalizeOrphanedAttempt({ jobId, fence, error, now = this.clock(), signal, deadline } = {}) {
    const authoritativeNow = dateValue(now, 'Orphan finalization time')
    if (!fence?.key || !Number.isInteger(fence.leaseGeneration)) throw new Error('Orphan finalization fence is invalid')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return this.withTransaction(async (session) => {
      signal?.throwIfAborted?.()
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session, ...options })
      if (!current) return false
      const lease = await this.leases().findOne({ key: fence.key }, { session, ...options })
      if (!lease || Number(lease.generationHighWater) !== Number(fence.leaseGeneration)) return false
      const owner = lease.activeOwner
      if (owner && Number(owner.leaseGeneration) !== Number(fence.leaseGeneration)) return false
      const leaseFilter = owner
        ? {
          key: fence.key, generationHighWater: fence.leaseGeneration, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash, 'activeOwner.leaseGeneration': fence.leaseGeneration,
          ...(error?.code === 'lease_heartbeat_lost' ? {} : { 'activeOwner.expiresAt': { $lte: authoritativeNow } }),
        }
        : { key: fence.key, generationHighWater: fence.leaseGeneration, activeOwner: { $exists: false } }
      const guardedLease = await this.leases().updateOne(
        leaseFilter,
        owner
          ? { $unset: { activeOwner: '' }, $set: { lastReleasedAt: authoritativeNow, updatedAt: authoritativeNow } }
          : { $set: { lastFenceValidatedAt: authoritativeNow, updatedAt: authoritativeNow } },
        { session, ...options },
      )
      if (guardedLease.matchedCount !== 1) return false
      const safe = safeErrorDocument({
        code: error?.code ?? 'ingestion_completion_failed',
        message: 'Ingestion job did not complete safely',
        retryable: Boolean(error?.retryable),
        occurredAt: authoritativeNow,
        upstreamStatus: error?.upstreamStatus,
      })
      const updated = await this.jobs().updateOne(
        { _id: current._id, status: 'running', leaseGeneration: fence.leaseGeneration },
        { $set: { status: 'failed', error: safe, finishedAt: authoritativeNow, purgeAfter: purgeAfterFor('failed', authoritativeNow, current.idempotencyExpiresAt), updatedAt: authoritativeNow }, $unset: { heartbeatAt: '' } },
        { session, ...options },
      )
      if (updated.matchedCount !== 1) throw new JobError(409, 'conflict', 'Orphaned job changed before finalization')
      if (owner && safe.retryable === true && Number(current.attempt) < 3) {
        const child = recoveryChildFor(current, authoritativeNow)
        await this.jobs().updateOne({ parentJobId: child.parentJobId, attempt: child.attempt }, { $setOnInsert: child }, { upsert: true, session, ...options })
      }
      const audit = createJobAuditEvent({
        actor: { id: 'system:due-work', role: 'system-worker' },
        action: 'ingestion_job_lease_recovered',
        targetId: current._id.toHexString(),
        changedFields: ['status', 'error'],
        reasonCode: 'lease_expired_recovered',
        request: { serverRequestId: `orphan-finalization:${current._id.toHexString()}:${current.leaseGeneration}` },
        createdAt: authoritativeNow,
      })
      await this.insertAudit(audit, session, options)
      return true
    }, options.maxTimeMS ? { maxCommitTimeMS: options.maxTimeMS } : {})
  }

  async deferWithFence({ jobId, fence, delayMs = 5 * 60 * 1000, signal, deadline } = {}) {
    const now = dateValue(this.clock(), 'Authoritative job clock')
    if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 15 * 60 * 1000) throw new Error('Job defer duration is invalid')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    return this.withTransaction(async (session) => {
      const leaseFilter = {
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session, ...options })
      if (touched.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease fence is stale or expired')
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session, ...options })
      if (!current) throw new JobError(409, 'conflict', 'Lease fence no longer owns this job')
      const cancelled = Boolean(current.cancellationRequestedAt)
      const update = cancelled
        ? { $set: { status: 'cancelled', finishedAt: now, purgeAfter: purgeAfterFor('cancelled', now, current.idempotencyExpiresAt), updatedAt: now }, $unset: { startedAt: '', heartbeatAt: '' } }
        : { $set: { status: 'queued', availableAt: new Date(now.getTime() + delayMs), leaseGeneration: 0, updatedAt: now }, $unset: { startedAt: '', heartbeatAt: '' } }
      const job = await this.jobs().updateOne({ _id: current._id, status: 'running', leaseGeneration: fence.leaseGeneration }, update, { session, ...options })
      if (job.matchedCount !== 1) throw new JobError(409, 'conflict', 'Job changed before defer')
      const released = await this.leases().updateOne(leaseFilter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session, ...options })
      if (released.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease release fence failed')
      return this.findIngestionJobById(jobId, { session, ...options })
    }, transactionOptions(options))
  }

  async cancelIngestionJob({ jobId, actor, reasonCode, request, actorFence, now = new Date() } = {}) {
    return this.withTransaction(async (session) => {
      if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
      const current = await this.jobs().findOne({ _id: idValue(jobId) }, { session })
      if (!current) throw new JobError(404, 'not_found', 'Ingestion job not found')
      let action
      let changedFields
      let update
      if (current.status === 'queued') {
        action = 'ingestion_job_cancelled'; changedFields = ['status']
        update = { status: 'cancelled', finishedAt: now, purgeAfter: purgeAfterFor('cancelled', now, current.idempotencyExpiresAt), updatedAt: now }
      } else if (current.status === 'running') {
        action = 'ingestion_job_cancellation_requested'; changedFields = ['cancellationRequestedAt']
        update = { cancellationRequestedAt: current.cancellationRequestedAt ?? now, updatedAt: now }
      } else throw new JobError(409, 'conflict', 'Terminal ingestion job cannot be cancelled')
      const audit = createJobAuditEvent({ actor, action, targetId: current._id.toHexString(), changedFields, reasonCode, request, createdAt: now })
      await this.jobs().updateOne({ _id: current._id, status: current.status }, { $set: update }, { session })
      await this.insertAudit(audit, session)
      return this.findIngestionJobById(jobId, { session })
    })
  }

  async recoverExpiredIngestion({ leaseRepository, now = new Date(), limit = 10, signal, deadline } = {}) {
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const expired = await leaseRepository.listExpired({ now, limit, namespace: 'ingestion:source:', signal, deadline })
    const summary = { inspected: expired.length, recovered: 0, retriesCreated: 0, failed: 0 }
    for (const snapshot of expired) {
      signal?.throwIfAborted?.()
      try {
        const outcome = await this.withTransaction(async (session) => {
          const filter = {
            _id: snapshot._id, key: snapshot.key,
            'activeOwner.jobId': snapshot.activeOwner.jobId,
            'activeOwner.ownerTokenHash': snapshot.activeOwner.ownerTokenHash,
            'activeOwner.leaseGeneration': snapshot.activeOwner.leaseGeneration,
            'activeOwner.expiresAt': { $lte: now },
          }
          const parent = await this.jobs().findOne({ _id: snapshot.activeOwner.jobId, status: 'running', leaseGeneration: snapshot.activeOwner.leaseGeneration }, { session, ...options })
          let retriesCreated = 0
          if (parent) {
            const safe = { code: 'lease_expired', message: 'Job lease expired before completion', retryable: true, occurredAt: now }
            await this.jobs().updateOne({ _id: parent._id, status: 'running', leaseGeneration: parent.leaseGeneration }, { $set: { status: 'failed', error: safe, finishedAt: now, purgeAfter: purgeAfterFor('failed', now, parent.idempotencyExpiresAt), updatedAt: now } }, { session, ...options })
            if (parent.attempt < 3) {
              const nextAttempt = parent.attempt + 1
              const key = `system-recovery:${parent._id.toHexString()}:${nextAttempt}`
              const child = {
                ...parent, _id: recoveryChildId(parent._id.toHexString(), nextAttempt), idempotencyKey: key, actorScope: 'system-recovery',
                requestHash: canonicalRequestHash({ operation: 'lease-recovery', parentJobId: parent._id.toHexString(), nextAttempt }), trigger: 'retry', parentJobId: parent._id,
                status: 'queued', attempt: nextAttempt, availableAt: now, agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), idempotencyExpiresAt: new Date(now.getTime() + 14 * DAY_MS),
                leaseGeneration: 0, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }, createdAt: now, updatedAt: now,
              }
              for (const field of ['startedAt', 'heartbeatAt', 'finishedAt', 'purgeAfter', 'error', 'cancellationRequestedAt', 'checkpoint']) delete child[field]
              const inserted = await this.jobs().updateOne({ parentJobId: child.parentJobId, attempt: child.attempt }, { $setOnInsert: child }, { upsert: true, session, ...options })
              retriesCreated = inserted.upsertedCount === 1 ? 1 : 0
            }
            const audit = createJobAuditEvent({ actor: { id: 'system:due-work', role: 'system-worker' }, action: 'ingestion_job_lease_recovered', targetId: parent._id.toHexString(), changedFields: ['status', 'error'], reasonCode: 'lease_expired_recovered', request: { serverRequestId: `recovery:${parent._id.toHexString()}:${parent.leaseGeneration}` }, createdAt: now })
            await this.insertAudit(audit, session, options)
          }
          const cleared = await this.leases().updateOne(filter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session, ...options })
          if (cleared.matchedCount !== 1) throw new JobError(409, 'conflict', 'Expired lease changed during recovery')
          return { recovered: 1, retriesCreated }
        }, transactionOptions(options))
        summary.recovered += outcome.recovered
        summary.retriesCreated += outcome.retriesCreated
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error
        summary.failed += 1
      }
    }

    // Recover orphaned running jobs whose lease was superseded or released
    const remainingSlots = Math.max(0, limit - summary.inspected)
    if (remainingSlots > 0) {
      signal?.throwIfAborted?.()
      const runningCandidates = await this.jobs()
        .find({ status: 'running' }, options)
        .sort({ updatedAt: 1, _id: 1 })
        .limit(remainingSlots)
        .toArray()

      for (const runningJob of runningCandidates) {
        signal?.throwIfAborted?.()
        try {
          const outcome = await this.withTransaction(async (session) => {
            const currentJob = await this.jobs().findOne(
              { _id: runningJob._id, status: 'running', leaseGeneration: runningJob.leaseGeneration },
              { session, ...options },
            )
            if (!currentJob) return { recovered: 0 }

            const leaseKey = `ingestion:source:${currentJob.sourceId.toHexString?.() ?? currentJob.sourceId}`
            const lease = await this.leases().findOne({ key: leaseKey }, { session, ...options })

            const isOwned = lease?.activeOwner
              && String(lease.activeOwner.jobId) === String(currentJob._id)
              && Number(lease.activeOwner.leaseGeneration) === Number(currentJob.leaseGeneration)
              && lease.activeOwner.expiresAt > now

            if (isOwned) return { recovered: 0 }

            const safe = {
              code: 'lease_expired',
              message: 'Job lease expired or was superseded before completion',
              retryable: false,
              occurredAt: now,
            }
            await this.jobs().updateOne(
              { _id: currentJob._id, status: 'running', leaseGeneration: currentJob.leaseGeneration },
              {
                $set: {
                  status: 'failed',
                  error: safe,
                  finishedAt: now,
                  purgeAfter: purgeAfterFor('failed', now, currentJob.idempotencyExpiresAt),
                  updatedAt: now,
                },
              },
              { session, ...options },
            )

            const audit = createJobAuditEvent({
              actor: { id: 'system:due-work', role: 'system-worker' },
              action: 'ingestion_job_lease_recovered',
              targetId: currentJob._id.toHexString(),
              changedFields: ['status', 'error'],
              reasonCode: 'lease_expired_recovered',
              request: { serverRequestId: `orphan-recovery:${currentJob._id.toHexString()}:${currentJob.leaseGeneration}` },
              createdAt: now,
            })
            await this.insertAudit(audit, session, options)
            return { recovered: 1 }
          }, transactionOptions(options))

          if (outcome?.recovered) {
            summary.recovered += 1
            summary.inspected += 1
          }
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error
          summary.failed += 1
        }
      }
    }

    return summary
  }
}
