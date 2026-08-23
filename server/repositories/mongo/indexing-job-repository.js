import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { createJobAuditEvent, validateJobAuditInput } from '../../audit/job-writer.js'
import { JobError, canonicalRequestHash, resolveIdempotentJob } from '../../domain/jobs/idempotency.js'
import { DEFAULT_EMBEDDING_VERSION } from '../../ai/embedding.js'
import { evaluateContentPolicy } from '../../domain/policy/content-policy.js'

const STATUSES = new Set(['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'])
const TASKS = new Set(['summary', 'embedding', 'visibility-reconcile'])
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

export const INDEXING_JOB_LIST_PROJECTION = Object.freeze({
  _id: 1,
  idempotencyKey: 1,
  articleId: 1,
  sourceId: 1,
  expectedSourcePolicyVersion: 1,
  task: 1,
  trigger: 1,
  status: 1,
  attempt: 1,
  availableAt: 1,
  leaseGeneration: 1,
  parentJobId: 1,
  error: 1,
  createdAt: 1,
  startedAt: 1,
  finishedAt: 1,
})
const DAY_MS = 24 * 60 * 60 * 1000
const EMBEDDING_COMPATIBILITY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function embeddingTargetValue(value = {}) {
  const version = value.version ?? DEFAULT_EMBEDDING_VERSION
  if (!Number.isInteger(version) || version < 1) throw new Error('Embedding target version is invalid')
  const dimensions = value.dimensions ?? null
  if (dimensions !== null && (!Number.isInteger(dimensions) || dimensions < 1)) throw new Error('Embedding target dimensions are invalid')
  const model = value.model ?? null
  if (model !== null && (typeof model !== 'string' || !model)) throw new Error('Embedding target model is invalid')
  const artifactCompatibilityId = value.artifactCompatibilityId ?? null
  if (artifactCompatibilityId !== null && (typeof artifactCompatibilityId !== 'string' || !EMBEDDING_COMPATIBILITY_ID.test(artifactCompatibilityId))) throw new Error('Embedding target compatibility is invalid')
  return Object.freeze({ model, dimensions, version, artifactCompatibilityId })
}

function embeddingTargetIdentity(target) {
  const value = embeddingTargetValue(target)
  return `${value.version}:${value.artifactCompatibilityId ?? 'none'}`
}

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

function dateValue(value, label = 'Indexing job date') {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid`)
  return value
}

function dueTaskFilter({ task, tasks } = {}) {
  const requested = task === undefined ? tasks : [task]
  if (requested === undefined) return undefined
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > TASKS.size || requested.some((value) => !TASKS.has(value))) throw new Error('Indexing due task filter is invalid')
  const unique = [...new Set(requested)]
  return unique.length === 1 ? unique[0] : { $in: unique }
}

function excludedArticleIds(values) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 200) throw new Error('Indexing article exclusion is invalid')
  return [...new Map(values.map((value) => {
    const id = idValue(value)
    return [id.toHexString(), id]
  })).values()]
}

function safeErrorDocument(error) {
  if (!error) return undefined
  const safe = { code: String(error.code).slice(0, 128), message: String(error.message).slice(0, 500), retryable: Boolean(error.retryable), occurredAt: dateValue(error.occurredAt) }
  if (Number.isInteger(error.upstreamStatus)) safe.upstreamStatus = error.upstreamStatus
  return safe
}

function expiredArtifactRecovery(parent, now, returnToPending) {
  if (!['summary', 'embedding'].includes(parent?.task)) return null
  const statusField = parent.task === 'summary' ? 'summaryStatus' : 'embeddingStatus'
  const error = returnToPending ? null : { code: 'lease_expired', message: 'AI artifact did not complete safely', retryable: true, occurredAt: now }
  const fields = parent.task === 'summary'
    ? {
        titleVi: null, summaryVi: null, summaryStatus: returnToPending ? 'pending' : 'failed', summaryBasis: null,
        summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null,
        summaryError: error, updatedAt: now,
      }
    : {
        embeddingStatus: returnToPending ? 'pending' : 'failed', embedding: null, embeddingModel: null,
        embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null,
        embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: error, updatedAt: now,
      }
  return {
    filter: { _id: parent.articleId, sourceId: parent.sourceId, status: 'published', [statusField]: 'processing' },
    update: { $set: fields, ...(parent.task === 'embedding' ? { $unset: { embeddingArtifactCompatibilityId: '' } } : {}) },
  }
}

export function indexingJobDocument(job) {
  return {
    _id: idValue(job.id), idempotencyKey: job.idempotencyKey, actorScope: job.actorScope, requestHash: job.requestHash,
    articleId: idValue(job.articleId), sourceId: idValue(job.sourceId), expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    task: job.task, trigger: job.trigger, ...(job.requestedBy ? { requestedBy: idValue(job.requestedBy) } : {}), ...(job.parentJobId ? { parentJobId: idValue(job.parentJobId) } : {}),
    status: job.status, attempt: job.attempt, priority: job.priority, availableAt: dateValue(job.availableAt), agingEligibleAt: dateValue(job.agingEligibleAt),
    idempotencyExpiresAt: dateValue(job.idempotencyExpiresAt), leaseGeneration: job.leaseGeneration,
    ...(job.targetEmbeddingVersion ? { targetEmbeddingVersion: job.targetEmbeddingVersion } : {}), ...(job.targetEmbeddingArtifactCompatibilityId ? { targetEmbeddingArtifactCompatibilityId: job.targetEmbeddingArtifactCompatibilityId } : {}), ...(job.inputHash ? { inputHash: job.inputHash } : {}),
    ...(job.cancellationRequestedAt ? { cancellationRequestedAt: dateValue(job.cancellationRequestedAt) } : {}), ...(job.error ? { error: safeErrorDocument(job.error) } : {}),
    createdAt: dateValue(job.createdAt), ...(job.startedAt ? { startedAt: dateValue(job.startedAt) } : {}), ...(job.heartbeatAt ? { heartbeatAt: dateValue(job.heartbeatAt) } : {}),
    ...(job.finishedAt ? { finishedAt: dateValue(job.finishedAt) } : {}), ...(job.purgeAfter ? { purgeAfter: dateValue(job.purgeAfter) } : {}), updatedAt: dateValue(job.updatedAt),
  }
}

export function serializeIndexingJob(document) {
  if (!document) return null
  return {
    id: document._id.toHexString(), idempotencyKey: document.idempotencyKey, actorScope: document.actorScope, requestHash: document.requestHash,
    articleId: document.articleId.toHexString(), sourceId: document.sourceId.toHexString(), expectedSourcePolicyVersion: document.expectedSourcePolicyVersion,
    task: document.task, trigger: document.trigger, requestedBy: document.requestedBy?.toHexString(), parentJobId: document.parentJobId?.toHexString(),
    status: document.status, attempt: document.attempt, priority: document.priority, availableAt: document.availableAt, agingEligibleAt: document.agingEligibleAt,
    idempotencyExpiresAt: document.idempotencyExpiresAt, leaseGeneration: Number(document.leaseGeneration), targetEmbeddingVersion: document.targetEmbeddingVersion, targetEmbeddingArtifactCompatibilityId: document.targetEmbeddingArtifactCompatibilityId,
    inputHash: document.inputHash, cancellationRequestedAt: document.cancellationRequestedAt, error: document.error ? { ...document.error } : undefined,
    createdAt: document.createdAt, startedAt: document.startedAt, heartbeatAt: document.heartbeatAt, finishedAt: document.finishedAt,
    purgeAfter: document.purgeAfter, updatedAt: document.updatedAt,
  }
}

function auditDocument(audit) {
  validateJobAuditInput(audit)
  return {
    _id: new ObjectId(), eventId: audit.eventId, actorType: audit.actorType, actorId: auditId(audit.actorId), action: audit.action,
    targetType: 'indexing-job', targetId: auditId(audit.targetId), changedFields: [...audit.changedFields], reasonCode: audit.reasonCode,
    requestId: audit.requestId, result: audit.result, createdAt: dateValue(audit.createdAt),
  }
}

function stableAudit(value) {
  return JSON.stringify({ eventId: value.eventId, actorType: value.actorType, actorId: String(value.actorId), action: value.action, targetId: String(value.targetId), changedFields: value.changedFields, reasonCode: value.reasonCode, requestId: value.requestId, result: value.result })
}

function recoveryChildId(parentId, nextAttempt) {
  return new ObjectId(createHash('sha256').update(`indexing-recovery:${parentId}:${nextAttempt}`).digest('hex').slice(0, 24))
}

function deterministicReconciliationId(identity) {
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

export function buildIngestionArtifactJobs({ source, article, now, embeddingTarget } = {}) {
  const sourceId = String(source?.id ?? source?._id ?? source?.sourceId)
  const articleId = String(article?.id ?? article?._id)
  const createdAt = dateValue(now, 'Ingestion indexing time')
  if (!ObjectId.isValid(sourceId) || !ObjectId.isValid(articleId) || !Number.isInteger(source?.policyVersion) || article?.status !== 'published') return []
  const contentHash = createHash('sha256').update(JSON.stringify({
    titleOriginal: article.titleOriginal,
    titleVi: article.titleVi ?? null,
    summaryVi: article.summaryStatus === 'ready' ? article.summaryVi ?? null : null,
    excerptOriginal: article.excerptOriginal ?? null,
    author: article.author ?? null,
    sourceLanguage: article.sourceLanguage,
    topics: article.topics ?? [],
  })).digest('hex')
  const tasks = []
  if (evaluateContentPolicy(source, 'summary').allowed) tasks.push('summary')
  if (evaluateContentPolicy(source, 'embedding').allowed) tasks.push('embedding')
  const target = embeddingTargetValue(embeddingTarget)
  return tasks.map((task) => {
    const identity = `ingest:${sourceId}:${articleId}:${task}:${source.policyVersion}:${contentHash.slice(0, 16)}${task === 'embedding' ? `:${embeddingTargetIdentity(target)}` : ''}`
    return {
      id: deterministicReconciliationId(identity), idempotencyKey: identity, actorScope: 'system-ingestion',
      requestHash: canonicalRequestHash({ operation: 'ingestion-artifact', sourceId, articleId, task, policyVersion: source.policyVersion, contentHash, targetEmbeddingVersion: task === 'embedding' ? target.version : null, artifactCompatibilityId: task === 'embedding' ? target.artifactCompatibilityId : null }),
      articleId, sourceId, expectedSourcePolicyVersion: source.policyVersion, task, trigger: 'ingestion', status: 'queued',
      attempt: 1, priority: 25, availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
      idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * DAY_MS), leaseGeneration: 0,
      ...(task === 'embedding' ? { targetEmbeddingVersion: target.version, ...(target.artifactCompatibilityId ? { targetEmbeddingArtifactCompatibilityId: target.artifactCompatibilityId } : {}) } : {}), createdAt, updatedAt: createdAt,
    }
  })
}

export function buildReconciliationJobs({ source, articleId, now, embeddingTarget } = {}) {
  const sourceId = String(source?.id ?? source?._id ?? source?.sourceId)
  const normalizedArticleId = String(articleId)
  const createdAt = dateValue(now, 'Reconciliation materialization time')
  if (!ObjectId.isValid(sourceId) || !ObjectId.isValid(normalizedArticleId) || !Number.isInteger(source?.policyVersion)) throw new Error('Reconciliation identity is invalid')
  const tasks = ['visibility-reconcile']
  if (evaluateContentPolicy(source, 'summary').allowed) tasks.push('summary')
  if (evaluateContentPolicy(source, 'embedding').allowed) tasks.push('embedding')
  const target = embeddingTargetValue(embeddingTarget)
  return tasks.map((task) => {
    const identity = `policy:${sourceId}:${normalizedArticleId}:${task}:${source.policyVersion}${task === 'embedding' ? `:${embeddingTargetIdentity(target)}` : ''}`
    return {
      id: deterministicReconciliationId(identity), idempotencyKey: identity, actorScope: 'system-policy-reconciliation',
      requestHash: canonicalRequestHash({ operation: 'policy-reconciliation', sourceId, articleId: normalizedArticleId, task, policyVersion: source.policyVersion, targetEmbeddingVersion: task === 'embedding' ? target.version : null, artifactCompatibilityId: task === 'embedding' ? target.artifactCompatibilityId : null }),
      articleId: normalizedArticleId, sourceId, expectedSourcePolicyVersion: source.policyVersion, task, trigger: 'policy-change', status: 'queued',
      attempt: 1, priority: 75, availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + 30 * 60 * 1000),
      idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * DAY_MS), leaseGeneration: 0,
      ...(task === 'embedding' ? { targetEmbeddingVersion: target.version, ...(target.artifactCompatibilityId ? { targetEmbeddingArtifactCompatibilityId: target.artifactCompatibilityId } : {}) } : {}), createdAt, updatedAt: createdAt,
    }
  })
}

export function purgeAfterForIndexing(status, finishedAt, idempotencyExpiresAt) {
  const retentionDays = ['failed', 'partial'].includes(status) ? 30 : 14
  return new Date(Math.max(finishedAt.getTime() + retentionDays * DAY_MS, idempotencyExpiresAt.getTime()))
}

export class MongoIndexingJobRepository {
  constructor(context, { embeddingTarget } = {}) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
    this.embeddingTarget = embeddingTargetValue(embeddingTarget)
  }

  jobs() { return this.db.collection('indexingJobs') }
  leases() { return this.db.collection('jobLeases') }
  sources() { return this.db.collection('sources') }
  articles() { return this.db.collection('articles') }
  audits() { return this.db.collection('adminAuditLogs') }

  async withTransaction(work) {
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      return result
    } finally { await session.endSession() }
  }

  async assertActorFence(fence, session) {
    if (!fence || !Number.isInteger(fence.sessionVersion)) return false
    const now = dateValue(this.clock(), 'Actor fence clock')
    const userId = idValue(fence.userId)
    const user = await this.db.collection('users').findOne({ _id: userId, role: 'admin', status: 'active', sessionVersion: fence.sessionVersion }, { session, projection: { _id: 1 } })
    const activeSession = await this.db.collection('sessions').findOne({ _id: idValue(fence.sessionId), userId, userSessionVersion: fence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { session, projection: { _id: 1 } })
    return Boolean(user && activeSession)
  }

  async insertAudit(audit, session) {
    const safe = auditDocument(audit)
    const existing = await this.audits().findOne({ eventId: safe.eventId }, { session })
    if (existing) {
      if (stableAudit(existing) !== stableAudit(safe)) throw new JobError(409, 'idempotency_mismatch', 'Indexing audit identity is already bound')
      return existing
    }
    await this.audits().insertOne(safe, { session })
    return safe
  }

  async existingIdempotentJob({ job, parentJobId, nextAttempt, session }) {
    const byActorKey = await this.jobs().findOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }, { session })
    if (byActorKey) return resolveIdempotentJob(serializeIndexingJob(byActorKey), job.requestHash)
    if (parentJobId) {
      const byParentAttempt = await this.jobs().findOne({ parentJobId: idValue(parentJobId), attempt: nextAttempt }, { session })
      if (byParentAttempt) return resolveIdempotentJob(serializeIndexingJob(byParentAttempt), job.requestHash)
    }
    return null
  }

  async reserveAdmission({ rateLimitAdmission, admission, session }) {
    let result
    try { result = await rateLimitAdmission.reserve({ ...admission, session }) } catch (error) {
      if (error instanceof JobError || error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) throw error
      throw new JobError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable')
    }
    if (!result || typeof result.allowed !== 'boolean') throw new JobError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable')
    if (!result.allowed) throw new JobError(429, 'rate_limit_exceeded', 'Too many manual indexing requests', { retryAfter: result.retryAfterSeconds })
  }

  async createOrReuseIndexingJobWithAdmission({ job, audit, actorFence, rateLimitAdmission, admission, parentJobId, nextAttempt } = {}) {
    try {
      return await this.withTransaction(async (session) => {
        if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
        const existing = await this.existingIdempotentJob({ job, parentJobId, nextAttempt, session })
        if (existing) return existing
        await this.reserveAdmission({ rateLimitAdmission, admission, session })
        await this.jobs().insertOne(indexingJobDocument(job), { session })
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

  async createSystemIndexingJob({ job } = {}) {
    const identity = job.parentJobId ? { parentJobId: idValue(job.parentJobId), attempt: job.attempt } : { actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }
    try {
      const existing = await this.jobs().findOne(identity)
      if (existing) return resolveIdempotentJob(serializeIndexingJob(existing), job.requestHash)
      await this.jobs().insertOne(indexingJobDocument(job))
      return job
    } catch (error) {
      if (error?.code !== 11000) throw error
      return resolveIdempotentJob(serializeIndexingJob(await this.jobs().findOne(identity)), job.requestHash)
    }
  }

  async selectPendingReconciliationSource({ now = this.clock(), retryBackoffMs = 60_000 } = {}) {
    const selectedAt = dateValue(now, 'Reconciliation selection time')
    if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 1 || retryBackoffMs > 24 * 60 * 60 * 1000) throw new JobError(422, 'validation_error', 'Reconciliation retry backoff is invalid')
    const retryEligibleAt = new Date(selectedAt.getTime() - retryBackoffMs)
    const document = await this.sources().find({ $or: [
      { 'reconciliation.status': { $in: ['pending', 'processing'] } },
      { 'reconciliation.status': 'failed', 'reconciliation.error.occurredAt': { $lte: retryEligibleAt } },
    ] })
      .sort({ 'reconciliation.requiredPolicyVersion': 1 }).hint('sources_reconciliation').limit(1).next()
    if (!document) return null
    return { id: document._id.toHexString(), policyVersion: document.policyVersion }
  }

  async materializeReconciliationPage({ sourceId, fence, limit = 100, now = this.clock() } = {}) {
    const sourceObjectId = idValue(sourceId)
    const materializedAt = dateValue(now, 'Reconciliation materialization time')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || fence?.key !== `reconciliation:source:${sourceObjectId.toHexString()}`) throw new Error('Reconciliation page input is invalid')
    return this.withTransaction(async (session) => {
      const leaseFilter = {
        key: fence.key, 'activeOwner.jobId': sourceObjectId, 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: materializedAt },
      }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: materializedAt, updatedAt: materializedAt } }, { session })
      if (touched.matchedCount !== 1) throw new JobError(409, 'conflict', 'Reconciliation lease fence is stale')
      const retryEligibleAt = new Date(materializedAt.getTime() - 60_000)
      const source = await this.sources().findOne({
        _id: sourceObjectId, $or: [
          { 'reconciliation.status': { $in: ['pending', 'processing'] } },
          { 'reconciliation.status': 'failed', 'reconciliation.error.occurredAt': { $lte: retryEligibleAt } },
        ],
        $expr: { $eq: ['$policyVersion', '$reconciliation.requiredPolicyVersion'] },
      }, { session })
      if (!source) throw new JobError(409, 'conflict', 'Source reconciliation marker changed')
      const cursor = source.reconciliation?.cursorArticleId
      const articleFilter = { sourceId: sourceObjectId, ...(cursor ? { _id: { $gt: cursor } } : {}) }
      const documents = await this.articles().find(articleFilter, { session }).sort({ _id: 1 }).hint('articles_source_reconciliation').limit(limit + 1).toArray()
      const selected = documents.slice(0, limit)
      let created = 0
      for (const article of selected) {
        for (const job of buildReconciliationJobs({ source: { ...source, id: sourceObjectId.toHexString() }, articleId: article._id.toHexString(), now: materializedAt, embeddingTarget: this.embeddingTarget })) {
          const inserted = await this.jobs().updateOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }, { $setOnInsert: indexingJobDocument(job) }, { upsert: true, session })
          created += inserted.upsertedCount === 1 ? 1 : 0
        }
      }
      const hasMore = documents.length > limit
      const markerFilter = {
        _id: sourceObjectId, policyVersion: source.policyVersion, 'reconciliation.requiredPolicyVersion': source.policyVersion,
        'reconciliation.status': source.reconciliation.status,
        ...(cursor ? { 'reconciliation.cursorArticleId': cursor } : { 'reconciliation.cursorArticleId': { $exists: false } }),
      }
      const markerUpdate = hasMore
        ? { $set: { 'reconciliation.status': 'processing', 'reconciliation.cursorArticleId': selected.at(-1)._id, 'reconciliation.error': null, updatedAt: materializedAt } }
        : { $set: { 'reconciliation.status': 'completed', 'reconciliation.completedPolicyVersion': source.policyVersion, 'reconciliation.error': null, updatedAt: materializedAt }, $unset: { 'reconciliation.cursorArticleId': '' } }
      const advanced = await this.sources().updateOne(markerFilter, markerUpdate, { session })
      if (advanced.matchedCount !== 1) throw new JobError(409, 'conflict', 'Source reconciliation cursor changed')
      return { inspected: selected.length, created, hasMore }
    })
  }

  async markReconciliationFailure({ sourceId, fence, now = this.clock(), error } = {}) {
    const id = idValue(sourceId)
    const occurredAt = dateValue(now, 'Reconciliation failure time')
    if (fence?.key !== `reconciliation:source:${id.toHexString()}`) return false
    return this.withTransaction(async (session) => {
      const lease = await this.leases().updateOne({
        key: fence.key, 'activeOwner.jobId': id, 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: occurredAt },
      }, { $set: { lastFenceValidatedAt: occurredAt, updatedAt: occurredAt } }, { session })
      if (lease.matchedCount !== 1) return false
      const source = await this.sources().findOne({ _id: id }, { session })
      const marker = source?.reconciliation
      if (!source || source.policyVersion !== marker?.requiredPolicyVersion || !['pending', 'processing', 'failed'].includes(marker.status)) return false
      const safe = { code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'reconciliation_failed', message: 'Reconciliation did not complete safely', retryable: Boolean(error?.retryable), occurredAt }
      const updated = await this.sources().updateOne({
        _id: id, policyVersion: source.policyVersion, 'reconciliation.requiredPolicyVersion': source.policyVersion,
        'reconciliation.status': marker.status,
        ...(marker.cursorArticleId ? { 'reconciliation.cursorArticleId': marker.cursorArticleId } : { 'reconciliation.cursorArticleId': { $exists: false } }),
      }, { $set: { 'reconciliation.status': 'failed', 'reconciliation.error': safe, updatedAt: occurredAt } }, { session })
      return updated.matchedCount === 1
    })
  }

  async findIndexingJobById(jobId, options = {}) { return serializeIndexingJob(await this.jobs().findOne({ _id: idValue(jobId) }, options)) }

  async listIndexingJobs(query = {}) {
    const limit = query.limit === undefined ? 20 : Number(query.limit)
    const invalid = (message) => { throw new JobError(422, 'validation_error', message) }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Job limit is invalid')
    const filter = {}
    if (query.status !== undefined) {
      if (!STATUSES.has(query.status)) invalid('Job status is invalid')
      filter.status = query.status
    }
    if (query.task !== undefined) {
      if (!TASKS.has(query.task)) invalid('Indexing task is invalid')
      filter.task = query.task
    }
    try {
      if (query.articleId !== undefined) filter.articleId = idValue(query.articleId)
      if (query.sourceId !== undefined) filter.sourceId = idValue(query.sourceId)
    } catch { invalid('Indexing job identifier is invalid') }
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        const date = new Date(decoded.createdAt)
        if (Number.isNaN(date.getTime())) throw new Error()
        filter.$or = [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: idValue(decoded.id) } }]
    } catch { invalid('Job cursor is invalid') }
    }
    const documents = await this.jobs().find(filter).sort({ createdAt: -1, _id: -1 }).project(INDEXING_JOB_LIST_PROJECTION).limit(limit + 1).toArray()
    const hasNext = documents.length > limit
    const page = documents.slice(0, limit)
    return { jobs: page.map(serializeIndexingJob), hasNext, nextCursor: hasNext ? Buffer.from(JSON.stringify({ createdAt: page.at(-1).createdAt.toISOString(), id: page.at(-1)._id.toHexString() })).toString('base64url') : null }
  }

  async selectDueIndexing({ now = new Date(), task, tasks, excludeArticleIds } = {}) {
    dateValue(now, 'Indexing due clock')
    const taskFilter = dueTaskFilter({ task, tasks })
    const excluded = excludedArticleIds(excludeArticleIds)
    const common = {
      status: 'queued',
      availableAt: { $lte: now },
      ...(taskFilter ? { task: taskFilter } : {}),
      ...(excluded.length > 0 ? { articleId: { $nin: excluded } } : {}),
    }
    const agedIndex = taskFilter ? 'indexing_drain_task_aged' : 'indexing_due_aged'
    const normalIndex = taskFilter ? 'indexing_drain_task_normal' : 'indexing_due_normal'
    const aged = await this.jobs().find({ ...common, agingEligibleAt: { $lte: now } }).sort({ agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 }).hint(agedIndex).limit(1).next()
    if (aged) return serializeIndexingJob(aged)
    return serializeIndexingJob(await this.jobs().find({ ...common, agingEligibleAt: { $gt: now } }).sort({ priority: -1, availableAt: 1, createdAt: 1, _id: 1 }).hint(normalIndex).limit(1).next())
  }

  async nextAvailableAt() {
    const document = await this.jobs().find({ status: 'queued' }).sort({ availableAt: 1, _id: 1 }).hint('indexing_next_available').project({ availableAt: 1 }).limit(1).next()
    return document?.availableAt ?? null
  }

  async purgeDueIndexingJobs({ cutoff = new Date(), limit = 100 } = {}) {
    dateValue(cutoff, 'Retention cutoff')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Retention batch limit is invalid')
    const filter = { status: { $in: [...TERMINAL] }, purgeAfter: { $lte: cutoff }, idempotencyExpiresAt: { $lte: cutoff } }
    const candidates = await this.jobs().find(filter).sort({ purgeAfter: 1, _id: 1 }).hint('indexing_purge_deadline').project({ _id: 1 }).limit(limit + 1).toArray()
    const selected = candidates.slice(0, limit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.jobs().deleteMany({ _id: { $in: selected.map(({ _id }) => _id) }, ...filter })
    return { inspected: selected.length, affected: result.deletedCount, hasMore: candidates.length > limit }
  }

  async claimQueuedWithFence({ jobId, fence } = {}) {
    const now = dateValue(this.clock(), 'Authoritative indexing clock')
    return this.withTransaction(async (session) => {
      const lease = await this.leases().updateOne({
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (lease.matchedCount !== 1) return false
      const job = await this.jobs().updateOne({ _id: idValue(jobId), status: 'queued', availableAt: { $lte: now } }, { $set: { status: 'running', leaseGeneration: fence.leaseGeneration, startedAt: now, heartbeatAt: now, updatedAt: now } }, { session })
      if (job.matchedCount !== 1) throw new JobError(409, 'conflict', 'Indexing job is no longer claimable')
      return true
    })
  }

  async cancellationRequestedWithFence({ jobId, fence } = {}) {
    const now = dateValue(this.clock(), 'Authoritative indexing clock')
    return this.withTransaction(async (session) => {
      const lease = await this.leases().updateOne({
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (lease.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease fence is stale or expired')
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session, projection: { cancellationRequestedAt: 1 } })
      if (!current) throw new JobError(409, 'conflict', 'Indexing job changed before provider call')
      return Boolean(current.cancellationRequestedAt)
    })
  }

  async completeWithFence({ jobId, fence, status, error, inputHash } = {}) {
    if (!TERMINAL.has(status)) throw new Error('Terminal indexing status is invalid')
    const now = dateValue(this.clock(), 'Authoritative indexing clock')
    return this.withTransaction(async (session) => {
      const leaseFilter = {
        key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (touched.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease fence is stale or expired')
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session })
      if (!current) throw new JobError(409, 'conflict', 'Lease fence no longer owns this indexing job')
      const source = await this.sources().findOne({ _id: current.sourceId, policyVersion: current.expectedSourcePolicyVersion }, { session, projection: { _id: 1, operationalStatus: 1, licenseStatus: 1, technicalCheck: 1 } })
      const policyMismatch = !source || current.task !== 'visibility-reconcile' && (source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus) || source.technicalCheck?.status !== 'passed')
      const finalStatus = policyMismatch ? 'failed' : status
      const set = { status: finalStatus, finishedAt: now, purgeAfter: purgeAfterForIndexing(finalStatus, now, current.idempotencyExpiresAt), updatedAt: now }
      if (policyMismatch) set.error = safeErrorDocument({ code: 'policy_version_mismatch', message: 'Source policy changed before indexing completion', retryable: false, occurredAt: now })
      else {
        if (error) set.error = safeErrorDocument(error)
        if (typeof inputHash === 'string' && /^[a-f0-9]{64}$/.test(inputHash)) set.inputHash = inputHash
      }
      await this.jobs().updateOne({ _id: current._id, status: 'running', leaseGeneration: fence.leaseGeneration }, { $set: set }, { session })
      const released = await this.leases().updateOne(leaseFilter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session })
      if (released.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease release fence failed')
      return this.findIndexingJobById(jobId, { session })
    })
  }

  async deferWithFence({ jobId, fence, delayMs = 5 * 60 * 1000 } = {}) {
    if (!Number.isInteger(delayMs) || delayMs < 1_000 || delayMs > 15 * 60 * 1_000) throw new Error('Indexing defer delay is invalid')
    const now = dateValue(this.clock(), 'Authoritative indexing clock')
    return this.withTransaction(async (session) => {
      const leaseFilter = { key: fence.key, 'activeOwner.jobId': idValue(jobId), 'activeOwner.ownerTokenHash': fence.ownerTokenHash, 'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now } }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (touched.matchedCount !== 1) throw new JobError(409, 'conflict', 'Lease fence is stale or expired')
      const current = await this.jobs().findOne({ _id: idValue(jobId), status: 'running', leaseGeneration: fence.leaseGeneration }, { session })
      if (!current) throw new JobError(409, 'conflict', 'Indexing job changed before defer')
      const cancelled = Boolean(current.cancellationRequestedAt)
      const update = cancelled
        ? { $set: { status: 'cancelled', finishedAt: now, purgeAfter: purgeAfterForIndexing('cancelled', now, current.idempotencyExpiresAt), updatedAt: now }, $unset: { startedAt: '', heartbeatAt: '' } }
        : { $set: { status: 'queued', availableAt: new Date(now.getTime() + delayMs), leaseGeneration: 0, updatedAt: now }, $unset: { startedAt: '', heartbeatAt: '' } }
      await this.jobs().updateOne({ _id: current._id, status: 'running', leaseGeneration: fence.leaseGeneration }, update, { session })
      await this.leases().updateOne(leaseFilter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session })
      return this.findIndexingJobById(jobId, { session })
    })
  }

  async cancelIndexingJob({ jobId, actor, reasonCode, request, actorFence, now = new Date() } = {}) {
    return this.withTransaction(async (session) => {
      if (!await this.assertActorFence(actorFence, session)) throw new JobError(401, 'unauthorized', 'Actor session is no longer active')
      const current = await this.jobs().findOne({ _id: idValue(jobId) }, { session })
      if (!current) throw new JobError(404, 'not_found', 'Indexing job not found')
      let action
      let changedFields
      let update
      if (current.status === 'queued') {
        action = 'indexing_job_cancelled'; changedFields = ['status']
        update = { status: 'cancelled', finishedAt: now, purgeAfter: purgeAfterForIndexing('cancelled', now, current.idempotencyExpiresAt), updatedAt: now }
      } else if (current.status === 'running') {
        action = 'indexing_job_cancellation_requested'; changedFields = ['cancellationRequestedAt']
        update = { cancellationRequestedAt: current.cancellationRequestedAt ?? now, updatedAt: now }
      } else throw new JobError(409, 'conflict', 'Terminal indexing job cannot be cancelled')
      const audit = createJobAuditEvent({ actor, action, targetId: current._id.toHexString(), changedFields, reasonCode, request, createdAt: now })
      await this.jobs().updateOne({ _id: current._id, status: current.status }, { $set: update }, { session })
      await this.insertAudit(audit, session)
      return this.findIndexingJobById(jobId, { session })
    })
  }

  async recoverExpiredIndexing({ leaseRepository, now = new Date(), limit = 10 } = {}) {
    const expired = await leaseRepository.listExpired({ now, limit, namespace: 'indexing:article:' })
    const summary = { inspected: expired.length, recovered: 0, retriesCreated: 0, failed: 0 }
    for (const snapshot of expired) {
      try {
        const outcome = await this.withTransaction(async (session) => {
          const filter = { _id: snapshot._id, key: snapshot.key, 'activeOwner.jobId': snapshot.activeOwner.jobId, 'activeOwner.ownerTokenHash': snapshot.activeOwner.ownerTokenHash, 'activeOwner.leaseGeneration': snapshot.activeOwner.leaseGeneration, 'activeOwner.expiresAt': { $lte: now } }
          const parent = await this.jobs().findOne({ _id: snapshot.activeOwner.jobId, status: 'running', leaseGeneration: snapshot.activeOwner.leaseGeneration }, { session })
          let retriesCreated = 0
          if (parent) {
            const safe = { code: 'lease_expired', message: 'Indexing lease expired before completion', retryable: true, occurredAt: now }
            const cancelled = Boolean(parent.cancellationRequestedAt)
            const terminalStatus = cancelled ? 'cancelled' : 'failed'
            const terminalUpdate = {
              $set: {
                status: terminalStatus,
                ...(!cancelled ? { error: safe } : {}),
                finishedAt: now,
                purgeAfter: purgeAfterForIndexing(terminalStatus, now, parent.idempotencyExpiresAt),
                updatedAt: now,
              },
              ...(cancelled ? { $unset: { error: '' } } : {}),
            }
            await this.jobs().updateOne({ _id: parent._id, status: 'running', leaseGeneration: parent.leaseGeneration }, terminalUpdate, { session })
            const willRetry = !cancelled && parent.attempt < 3
            if (willRetry) {
              const nextAttempt = parent.attempt + 1
              const child = {
                ...parent, _id: recoveryChildId(parent._id.toHexString(), nextAttempt), idempotencyKey: `system-recovery:${parent._id.toHexString()}:${nextAttempt}`, actorScope: 'system-recovery',
                requestHash: canonicalRequestHash({ operation: 'indexing-lease-recovery', parentJobId: parent._id.toHexString(), nextAttempt }), trigger: 'retry', parentJobId: parent._id,
                status: 'queued', attempt: nextAttempt, availableAt: now, agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), idempotencyExpiresAt: new Date(now.getTime() + 14 * DAY_MS),
                leaseGeneration: 0, createdAt: now, updatedAt: now,
              }
              for (const field of ['startedAt', 'heartbeatAt', 'finishedAt', 'purgeAfter', 'error', 'cancellationRequestedAt', 'inputHash']) delete child[field]
              const inserted = await this.jobs().updateOne({ parentJobId: child.parentJobId, attempt: child.attempt }, { $setOnInsert: child }, { upsert: true, session })
              retriesCreated = inserted.upsertedCount === 1 ? 1 : 0
            }
            const artifactRecovery = expiredArtifactRecovery(parent, now, willRetry || cancelled)
            if (artifactRecovery) await this.articles().updateOne(artifactRecovery.filter, artifactRecovery.update, { session })
            const audit = createJobAuditEvent({ actor: { id: 'system:due-work', role: 'system-worker' }, action: 'indexing_job_lease_recovered', targetId: parent._id.toHexString(), changedFields: ['status', 'error'], reasonCode: 'lease_expired_recovered', request: { serverRequestId: `recovery:${parent._id.toHexString()}:${parent.leaseGeneration}` }, createdAt: now })
            await this.insertAudit(audit, session)
          }
          const cleared = await this.leases().updateOne(filter, { $unset: { activeOwner: '' }, $set: { lastReleasedAt: now, updatedAt: now } }, { session })
          if (cleared.matchedCount !== 1) throw new JobError(409, 'conflict', 'Expired indexing lease changed during recovery')
          return { recovered: 1, retriesCreated }
        })
        summary.recovered += outcome.recovered
        summary.retriesCreated += outcome.retriesCreated
      } catch { summary.failed += 1 }
    }
    return summary
  }
}
