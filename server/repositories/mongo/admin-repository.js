import { ObjectId } from 'mongodb'
import { createHash } from 'node:crypto'
import { indexingJobDocument } from './indexing-job-repository.js'
import { canonicalRequestHash } from '../../domain/jobs/idempotency.js'
import { canonicalTopicIds, TOPIC_TAXONOMY_VERSION } from '../../../shared/topic-catalog.js'

const ARTICLE_PROJECTION = Object.freeze({
  _id: 1, sourceId: 1, titleOriginal: 1, originalUrl: 1, status: 1, topics: 1, provenance: 1, rightsSnapshot: 1,
  leadMedia: 1, leadMediaStatus: 1, summaryStatus: 1, summaryModel: 1, summarySourcePolicyVersion: 1,
  summaryGeneratedAt: 1, summaryError: 1, embeddingStatus: 1, embeddingModel: 1, embeddingVersion: 1,
  embeddingSourcePolicyVersion: 1, embeddedAt: 1, embeddingError: 1, updatedAt: 1,
})
const CURSOR_LIMIT = 100
const DAY_MS = 24 * 60 * 60 * 1000
const AGING_MS = 30 * 60 * 1000

export const SOURCE_OVERVIEW_PIPELINE = Object.freeze([
  { $match: { operationalStatus: 'active' } },
  { $count: 'value' },
  { $set: { key: 'activeSources' } },
  { $unionWith: { coll: 'sources', pipeline: [{ $match: { operationalStatus: 'paused' } }, { $count: 'value' }, { $set: { key: 'pausedSources' } }] } },
  { $unionWith: { coll: 'sources', pipeline: [{ $match: { licenseStatus: 'review-needed' } }, { $count: 'value' }, { $set: { key: 'sourcesNeedingReview' } }] } },
  { $project: { _id: 0, key: 1, value: 1 } },
])

export const ARTICLE_OVERVIEW_PIPELINE = Object.freeze([
  { $facet: {
    articlesNeedingReview: [
      { $match: { status: 'review-needed' } },
      { $count: 'value' },
    ],
    failedIndexes: [
      { $match: { status: { $ne: 'removed' }, $or: [{ summaryStatus: 'failed' }, { embeddingStatus: 'failed' }] } },
      { $count: 'value' },
    ],
  } },
  { $project: {
    articlesNeedingReview: { $ifNull: [{ $first: '$articlesNeedingReview.value' }, 0] },
    failedIndexes: { $ifNull: [{ $first: '$failedIndexes.value' }, 0] },
  } },
])

export const INGESTION_OVERVIEW_PIPELINE = Object.freeze([
  { $match: { status: { $in: ['queued', 'running', 'partial'] } } },
  { $count: 'value' },
  { $set: { key: 'queuedJobs' } },
  { $unionWith: { coll: 'ingestionJobs', pipeline: [
    { $match: { status: 'failed', 'error.retryable': true } },
    { $lookup: { from: 'ingestionJobs', localField: '_id', foreignField: 'parentJobId', as: 'children' } },
    { $match: { 'children.status': { $ne: 'succeeded' } } },
    { $count: 'value' },
    { $set: { key: 'failedJobs' } },
  ] } },
  { $unionWith: { coll: 'ingestionJobs', pipeline: [
    { $match: { status: 'succeeded', finishedAt: { $type: 'date' } } },
    { $sort: { finishedAt: -1, _id: -1 } },
    { $limit: 1 },
    { $project: { _id: 0, key: { $literal: 'lastSuccessfulIngestionAt' }, value: '$finishedAt' } },
  ] } },
  { $project: { _id: 0, key: 1, value: 1 } },
])

async function aggregateCount(collection, filter) {
  const result = await collection.aggregate([{ $match: filter }, { $count: 'count' }]).next()
  return result?.count ?? 0
}

function keyedOverview(rows) {
  return Object.fromEntries((rows ?? []).filter(({ key }) => typeof key === 'string').map(({ key, value }) => [key, value]))
}

function objectId(value, label = 'Identifier') {
  if (value instanceof ObjectId) return value
  if (value && typeof value.toHexString === 'function') return objectId(value.toHexString(), label)
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  const error = new Error(`${label} is invalid`); error.status = 400; error.code = 'bad_request'; throw error
}

function date(value, label = 'Date') {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) { const error = new Error(`${label} is invalid`); error.status = 422; error.code = 'validation_error'; throw error }
  return result
}

function decodeCursor(value) {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!decoded || typeof decoded.id !== 'string' || !decoded.at) throw new Error('invalid')
    return { id: objectId(decoded.id), at: date(decoded.at) }
  } catch { const error = new Error('Cursor is invalid'); error.status = 422; error.code = 'validation_error'; throw error }
}

function encodeCursor(value) { return Buffer.from(JSON.stringify({ id: value._id.toHexString(), at: value.updatedAt.toISOString() }), 'utf8').toString('base64url') }
function encodeAuditCursor(value) { return Buffer.from(JSON.stringify({ id: value._id.toHexString(), at: value.createdAt.toISOString() }), 'utf8').toString('base64url') }

function requestIdentity(request) {
  const headerIdentity = typeof request?.get === 'function' ? request.get('Idempotency-Key') : undefined
  const identity = request?.idempotencyKey ?? headerIdentity ?? request?.requestId ?? request?.serverRequestId
  return identity === undefined || identity === null || identity === '' ? null : String(identity)
}

function idempotencyMismatch(message = 'Admin audit identity collision') {
  const error = new Error(message)
  error.status = 409
  error.code = 'idempotency_mismatch'
  return error
}

function adminAuditEventId({ reasonCode, targetId, requestId, actorId, actorScope, eventIdentity = requestId }) {
  return `admin:${createHash('sha256').update(`${reasonCode}\u0000${String(targetId)}\u0000${String(eventIdentity)}\u0000${String(actorId)}\u0000${String(actorScope ?? '')}`).digest('hex')}`
}
function auditIdentityMatches(existing, expected) {
  return String(existing?.eventId) === String(expected.eventId)
    && String(existing?.actorId) === String(expected.actorId)
    && existing?.action === expected.action
    && existing?.targetType === expected.targetType
    && String(existing?.targetId) === String(expected.targetId)
    && existing?.reasonCode === expected.reasonCode
    && String(existing?.requestId) === String(expected.requestId)
    && JSON.stringify(existing?.changedFields ?? []) === JSON.stringify(expected.changedFields ?? [])
}
function auditActorScope(actorFence) {
  if (!actorFence?.userId || !actorFence?.sessionId || !Number.isInteger(actorFence.sessionVersion)) return null
  return `admin:${String(actorFence.userId)}:session:${String(actorFence.sessionId)}:v${actorFence.sessionVersion}`
}

function deterministicAuditClaimId({ operation, actorFence, requestId }) {
  const actorScope = auditActorScope(actorFence)
  if (!actorScope || !requestId) return null
  return deterministicObjectId(`${String(operation)}\u0000${actorScope}\u0000${String(requestId)}`)
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.codeName === 'DuplicateKey' || /duplicate key/i.test(String(error?.message ?? ''))
}


function deterministicObjectId(identity) {
  return new ObjectId(createHash('sha256').update(identity).digest('hex').slice(0, 24))
}

function reconciliationJob({ article, source, category, nextValue, actorFence, request, now }) {
  const articleId = objectId(article._id, 'Article identifier')
  const sourceId = objectId(source._id ?? article.sourceId, 'Source identifier')
  const policyVersion = source.policyVersion
  if (!Number.isInteger(policyVersion) || policyVersion < 1) {
    const error = new Error('Current source policy is invalid')
    error.status = 409
    error.code = 'conflict'
    throw error
  }
  const valueHash = canonicalRequestHash(nextValue)
  const requestId = requestIdentity(request) ?? `${category}:${valueHash.slice(0, 16)}`
  const actorScope = `admin:${String(actorFence.userId)}:session:${String(actorFence.sessionId)}:v${actorFence.sessionVersion}`
  const identity = `admin:${actorScope}:${articleId.toHexString()}:${policyVersion}:${category}:${requestId}:${valueHash.slice(0, 16)}`
  const requestHash = canonicalRequestHash({ operation: 'admin-article-reconciliation', articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), policyVersion, category, value: nextValue })
  return indexingJobDocument({
    id: deterministicObjectId(identity).toHexString(), idempotencyKey: identity, actorScope, requestHash,
    articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), expectedSourcePolicyVersion: policyVersion,
    task: 'visibility-reconcile', trigger: 'admin', requestedBy: String(actorFence.userId), status: 'queued', attempt: 1, priority: 50,
    availableAt: now, agingEligibleAt: new Date(now.getTime() + AGING_MS), idempotencyExpiresAt: new Date(now.getTime() + 14 * DAY_MS),
    leaseGeneration: 0, createdAt: now, updatedAt: now,
  })
}
export class MongoAdminRepository {
  constructor(context) {
    if (!context?.db) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  collection(name) { return this.db.collection(name) }
  articles() { return this.collection('articles') }
  sources() { return this.collection('sources') }
  ingestionJobs() { return this.collection('ingestionJobs') }
  indexingJobs() { return this.collection('indexingJobs') }
  users() { return this.collection('users') }
  sessions() { return this.collection('sessions') }

  async assertActiveSessionForUser({ sessionId, userId, sessionVersion, role, now = this.clock() } = {}, options = {}) {
    const mongoOptions = options.session ? { session: options.session } : {}
    const touchedSession = await this.sessions().updateOne({ _id: objectId(sessionId), userId: objectId(userId), userSessionVersion: sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { $set: { lastSeenAt: now } }, mongoOptions)
    if (touchedSession.matchedCount !== 1) return false
    const touchedUser = await this.users().updateOne({ _id: objectId(userId), status: 'active', sessionVersion, ...(role ? { role } : {}) }, { $set: { updatedAt: now } }, mongoOptions)
    return touchedUser.matchedCount === 1
  }
  auditLogs() { return this.collection('adminAuditLogs') }

  async insertAdminAudit({ actor, targetId, reasonCode, changedFields, request, now } = {}, session, options = {}) {
    const allowed = new Map([
      ['article_status_changed', ['status']], ['article_topics_changed', ['topics']], ['article_media_visibility_changed', ['leadMediaStatus']],
      ['duplicate_merge_confirmed', ['provenance', 'status']],
    ])
    const expected = allowed.get(reasonCode)
    if (!expected || expected.length !== changedFields?.length || expected.some((field, index) => field !== changedFields[index])) throw new Error('Admin audit reason or fields are not allowlisted')
    const actorId = actor?._id ?? actor?.id
    const requestId = requestIdentity(request)
    if (!actorId || !requestId) throw new Error('Admin audit identity is invalid')
    const actorScope = auditActorScope(request?.actorFence)
    const claimId = deterministicAuditClaimId({ operation: request?.auditOperation ?? 'admin-audit', actorFence: request?.actorFence, requestId })
    const eventId = adminAuditEventId({ reasonCode, targetId, requestId, actorId, actorScope, eventIdentity: request?.eventIdentity })
    const document = {
      _id: new ObjectId(), eventId, actorType: 'admin', actorId: objectId(actorId), action: reasonCode, targetType: 'article', targetId: objectId(targetId),
      changedFields: [...changedFields], reasonCode, requestId, result: 'succeeded', createdAt: date(now ?? this.clock()),
    }
    const result = (value, replayed) => options.returnMetadata ? { document: value, replayed } : value
    const auditLogs = this.auditLogs()
    const existing = await auditLogs.findOne(claimId ? { _id: claimId } : { requestId }, { session })
    if (existing) {
      if (!auditIdentityMatches(existing, document)) throw idempotencyMismatch()
      return result(existing, true)
    }
    if (claimId && typeof auditLogs.updateOne === 'function') {
      const claimDocument = { ...document, _id: claimId }
      const claim = await auditLogs.updateOne({ _id: claimId }, { $setOnInsert: claimDocument }, { upsert: true, session })
      if (claim?.upsertedCount === 1 || claim?.upsertedId) return result(claimDocument, false)
      const existingClaim = await auditLogs.findOne({ _id: claimId }, { session })
      if (!existingClaim) throw new Error('Admin audit claim was not persisted')
      if (!auditIdentityMatches(existingClaim, claimDocument)) throw idempotencyMismatch()
      return result(existingClaim, true)
    }

    await auditLogs.insertOne(document, { session })
    return result(document, false)
  }

  async withTransaction(work) {
    if (!this.client?.startSession) throw new Error('Mongo transaction capability is unavailable')
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      return result
    } finally { await session.endSession() }
  }

  async getOverview() {
    const [sources, jobs, articleMetrics, openTakedowns, failedAccountDeletions] = await Promise.all([
      this.sources().aggregate(SOURCE_OVERVIEW_PIPELINE).toArray(),
      this.ingestionJobs().aggregate(INGESTION_OVERVIEW_PIPELINE).toArray(),
      this.articles().aggregate(ARTICLE_OVERVIEW_PIPELINE).next(),
      aggregateCount(this.collection('takedownRequests'), { status: { $in: ['received', 'reviewing', 'approved'] } }),
      aggregateCount(this.collection('accountDeletionRequests'), { status: 'failed' }),
    ])
    const sourceMetrics = keyedOverview(sources)
    const jobMetrics = keyedOverview(jobs)
    return {
      activeSources: sourceMetrics.activeSources ?? 0,
      pausedSources: sourceMetrics.pausedSources ?? 0,
      sourcesNeedingReview: sourceMetrics.sourcesNeedingReview ?? 0,
      queuedJobs: jobMetrics.queuedJobs ?? 0,
      failedJobs: jobMetrics.failedJobs ?? 0,
      articlesNeedingReview: articleMetrics?.articlesNeedingReview ?? 0,
      failedIndexes: articleMetrics?.failedIndexes ?? 0,
      openTakedowns,
      failedAccountDeletions,
      lastSuccessfulIngestionAt: jobMetrics.lastSuccessfulIngestionAt ?? null,
    }
  }

  async listAdminArticles(query = {}) {
    const limit = Number(query.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > CURSOR_LIMIT) { const error = new Error('Limit is invalid'); error.status = 422; error.code = 'validation_error'; throw error }
    const filter = {}
    for (const key of ['status', 'summaryStatus', 'embeddingStatus']) if (query[key] !== undefined) filter[key] = query[key]
    if (query.sourceId !== undefined) filter.sourceId = objectId(query.sourceId, 'Source identifier')
    const cursor = decodeCursor(query.cursor)
    if (cursor) filter.$or = [{ updatedAt: { $lt: cursor.at } }, { updatedAt: cursor.at, _id: { $lt: cursor.id } }]
    const rows = await this.articles().find(filter).sort({ updatedAt: -1, _id: -1 }).project(ARTICLE_PROJECTION).limit(limit + 1).toArray()
    const hasNext = rows.length > limit
    const articles = hasNext ? rows.slice(0, limit) : rows
    const last = articles.at(-1)
    return { articles, hasNext, nextCursor: hasNext && last ? encodeCursor(last) : null }
  }

  async findAdminArticle(value, options = {}) {
    return this.articles().findOne({ _id: objectId(value, 'Article identifier') }, { projection: ARTICLE_PROJECTION, ...(options.session ? { session: options.session } : {}) })
  }

  async updateAdminArticle(value, { category, value: nextValue, actorFence, request, actor, rateLimitAdmission, reasonCode } = {}) {
    const _id = objectId(value, 'Article identifier')
    const current = await this.articles().findOne({ _id }, { projection: ARTICLE_PROJECTION })
    if (!current) return null
    const now = date(this.clock(), 'Article update date')
    const requestId = requestIdentity(request)
    const requestHash = canonicalRequestHash({ operation: 'admin-article-update', articleId: _id.toHexString(), category, value: nextValue, reasonCode })
    const eventIdentity = requestId ? `${requestId}:${requestHash}` : requestHash
    const set = { updatedAt: now }
    if (category === 'topics') {
      set.topics = [...nextValue]
      set.topicIds = canonicalTopicIds(nextValue, { includeAncestors: true })
      set.topicTaxonomyVersion = TOPIC_TAXONOMY_VERSION
    }
    else if (category === 'leadMediaStatus') {
      if (!['available', 'hidden'].includes(nextValue) || nextValue === 'available' && !current.leadMedia) { const error = new Error('Media state is invalid'); error.status = 409; error.code = 'conflict'; throw error }
      set.leadMediaStatus = nextValue
    } else if (category === 'status') {
      if (!['processing', 'review-needed', 'published', 'hidden', 'removed'].includes(nextValue) || current.status === 'removed' && nextValue !== 'removed') { const error = new Error('Article status transition is invalid'); error.status = 409; error.code = 'conflict'; throw error }
      set.status = nextValue
      if (nextValue === 'hidden') {
        set.hiddenReason = reasonCode
        set.leadMediaStatus = current.leadMedia ? 'hidden' : 'none'
      }
    }
    const articleUpdate = category === 'status' && nextValue !== 'hidden'
      ? { $set: set, $unset: { hiddenReason: '' } }
      : { $set: set }
    if (!actorFence || !Number.isInteger(actorFence.sessionVersion) || !actorFence.sessionId || !actorFence.userId) { const error = new Error('Authenticated admin session is required'); error.status = 401; error.code = 'unauthorized'; throw error }
    const actorId = actor?._id ?? actor?.id
    const auditRequest = { ...(request ?? {}), requestId, serverRequestId: request?.serverRequestId, idempotencyKey: request?.idempotencyKey, eventIdentity, actorFence, auditOperation: 'admin-article-update' }
    const auditReasonValid = (category === 'status' && reasonCode === 'article_status_changed') || (category === 'topics' && reasonCode === 'article_topics_changed') || (category === 'leadMediaStatus' && reasonCode === 'article_media_visibility_changed')
    const claimAudit = (session) => this.insertAdminAudit({ actor, targetId: _id, reasonCode, changedFields: [category], request: auditRequest, now }, session, { returnMetadata: true })
    try {
      return await this.withTransaction(async (session) => {
        if (!rateLimitAdmission?.reserve) { const error = new Error('Admin admission is unavailable'); error.status = 503; error.code = 'service_unavailable'; throw error }
        let auditResult
        if (auditReasonValid) {
          auditResult = await claimAudit(session)
          if (auditResult.replayed) return this.findAdminArticle(_id, { session })
        }
        const userFence = await this.users().updateOne({ _id: objectId(actorFence.userId), role: 'admin', status: 'active', sessionVersion: actorFence.sessionVersion }, { $set: { updatedAt: now } }, { session })
        if (userFence.matchedCount !== 1) { const error = new Error('Admin session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
        const sessionFence = await this.collection('sessions').updateOne({ _id: objectId(actorFence.sessionId), userId: objectId(actorFence.userId), userSessionVersion: actorFence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { $set: { lastSeenAt: now } }, { session })
        if (sessionFence.matchedCount !== 1) { const error = new Error('Admin session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
        let admission
        try { admission = await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(actorFence.userId), session }) } catch { const error = new Error('Admin admission is unavailable'); error.status = 503; error.code = 'service_unavailable'; throw error }
        if (admission && admission.allowed === false) { const error = new Error('Too many manual admin requests'); error.status = 429; error.code = 'rate_limit_exceeded'; error.retryAfter = admission.retryAfterSeconds; throw error }
        const transactionalArticle = await this.articles().findOne({ _id }, { projection: ARTICLE_PROJECTION, session })
        if (!transactionalArticle || transactionalArticle.updatedAt?.getTime?.() !== current.updatedAt?.getTime?.()) { const error = new Error('Article changed before update'); error.status = 409; error.code = 'conflict'; throw error }
        if (!auditReasonValid) await claimAudit(session)
        const sourceCollection = this.sources()
        let source = { _id: transactionalArticle.sourceId, policyVersion: transactionalArticle.rightsSnapshot?.sourcePolicyVersion }
        const hasSourceCollection = sourceCollection && typeof sourceCollection.findOne === 'function'
        if (hasSourceCollection) {
          source = await sourceCollection.findOne({ _id: objectId(transactionalArticle.sourceId, 'Source identifier'), policyVersion: transactionalArticle.rightsSnapshot?.sourcePolicyVersion }, { session, projection: { _id: 1, policyVersion: 1, updatedAt: 1, operationalStatus: 1, licenseStatus: 1, llmInputScope: 1 } })
          if (!source) { const error = new Error('Current source policy changed'); error.status = 409; error.code = 'conflict'; throw error }
        }
        if (hasSourceCollection) {
          const sourceFence = await sourceCollection.updateOne({ _id: source._id, policyVersion: source.policyVersion, ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}) }, { $set: { updatedAt: now } }, { session })
          if (sourceFence.matchedCount !== 1) { const error = new Error('Current source policy changed'); error.status = 409; error.code = 'conflict'; throw error }
        }
        const result = await this.articles().updateOne({ _id, updatedAt: transactionalArticle.updatedAt }, articleUpdate, { session })
        if (result.matchedCount !== 1) { const error = new Error('Article changed before update'); error.status = 409; error.code = 'conflict'; throw error }
        const jobs = this.indexingJobs()
        if (jobs && typeof jobs.updateOne === 'function') {
          const job = reconciliationJob({ article: transactionalArticle, source, category, nextValue, actorFence, request, now })
          await jobs.updateOne({ actorScope: job.actorScope, idempotencyKey: job.idempotencyKey }, { $setOnInsert: job }, { upsert: true, session })
        }
        return this.findAdminArticle(_id, { session })
      })
    } catch (error) {
      if (!isDuplicateKeyError(error) || !actorId || !requestId) throw error
      const claimId = deterministicAuditClaimId({ operation: 'admin-article-update', actorFence, requestId })
      if (!claimId) throw error
      const existing = await this.auditLogs().findOne({ _id: claimId })
      if (!existing) throw error
      const expectedAudit = {
        eventId: adminAuditEventId({ reasonCode, targetId: _id, requestId, actorId, actorScope: auditActorScope(actorFence), eventIdentity }), actorId, action: reasonCode,
        targetType: 'article', targetId: _id, reasonCode, requestId, changedFields: [category],
      }
      if (!auditIdentityMatches(existing, expectedAudit)) throw idempotencyMismatch()
      return this.findAdminArticle(_id)
    }
  }

  async mergeDuplicateArticles({ canonicalArticleId, duplicateArticleIds, actorFence, actor, request, idempotencyKey, rateLimitAdmission, reasonCode } = {}) {
    const canonicalId = objectId(canonicalArticleId, 'Canonical article identifier')
    const duplicateIds = duplicateArticleIds.map((value) => objectId(value, 'Duplicate article identifier'))
    if (!actorFence || !Number.isInteger(actorFence.sessionVersion) || !actorFence.sessionId || !actorFence.userId) { const error = new Error('Authenticated admin session is required'); error.status = 401; error.code = 'unauthorized'; throw error }
    return this.withTransaction(async (session) => {
      const now = date(this.clock())
      const userFence = await this.users().updateOne({ _id: objectId(actorFence.userId), role: 'admin', status: 'active', sessionVersion: actorFence.sessionVersion }, { $set: { updatedAt: now } }, { session })
      if (userFence.matchedCount !== 1) { const error = new Error('Admin session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
      const sessionFence = await this.collection('sessions').updateOne({ _id: objectId(actorFence.sessionId), userId: objectId(actorFence.userId), userSessionVersion: actorFence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { $set: { lastSeenAt: now } }, { session })
      if (sessionFence.matchedCount !== 1) { const error = new Error('Admin session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
      if (!rateLimitAdmission?.reserve) { const error = new Error('Admin admission is unavailable'); error.status = 503; error.code = 'service_unavailable'; throw error }
      let admission
      try { admission = await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(actorFence.userId), session }) } catch { const error = new Error('Admin admission is unavailable'); error.status = 503; error.code = 'service_unavailable'; throw error }
      if (admission && admission.allowed === false) { const error = new Error('Too many manual admin requests'); error.status = 429; error.code = 'rate_limit_exceeded'; error.retryAfter = admission.retryAfterSeconds; throw error }
      if (idempotencyKey) {
        const requestHash = canonicalRequestHash({ operation: 'duplicate-merge', canonicalArticleId: canonicalId.toHexString(), duplicateArticleIds: duplicateIds.map((id) => id.toHexString()).sort(), reasonCode })
        const actorId = actor?._id ?? actor?.id
        const eventIdentity = `${String(idempotencyKey)}:${requestHash}`
        const expectedEventId = adminAuditEventId({ reasonCode, targetId: canonicalId, requestId: idempotencyKey, actorId, eventIdentity })
        const prior = await this.auditLogs().findOne({ requestId: String(idempotencyKey), action: 'duplicate_merge_confirmed' }, { session })
        if (prior && (String(prior.targetId) !== canonicalId.toHexString() || prior.eventId !== expectedEventId)) { const error = new Error('Idempotency key is already bound to a different request'); error.status = 409; error.code = 'idempotency_mismatch'; throw error }
        if (prior && String(prior.targetId) === canonicalId.toHexString()) return { canonical: await this.findAdminArticle(canonicalId, { session }), duplicateCount: duplicateIds.length }
      }
      const canonical = await this.articles().findOne({ _id: canonicalId }, { projection: ARTICLE_PROJECTION, session })
      if (!canonical) return null
      const duplicates = await this.articles().find({ $and: [{ _id: { $in: duplicateIds } }, { _id: { $ne: canonicalId } }, { status: { $ne: 'removed' } }] }, { projection: ARTICLE_PROJECTION, session }).toArray()
      if (duplicates.length !== duplicateIds.length) { const error = new Error('Duplicate article state changed'); error.status = 409; error.code = 'conflict'; throw error }
      const sourceSnapshots = new Map()
      for (const article of [canonical, ...duplicates]) {
        const sourceId = objectId(article.sourceId, 'Source identifier')
        const expectedPolicyVersion = article.rightsSnapshot?.sourcePolicyVersion
        const source = await this.sources().findOne({ _id: sourceId, policyVersion: expectedPolicyVersion }, { session, projection: { _id: 1, policyVersion: 1, updatedAt: 1 } })
        if (!source) { const error = new Error('Current source policy changed'); error.status = 409; error.code = 'conflict'; throw error }
        if (!sourceSnapshots.has(source._id.toHexString())) sourceSnapshots.set(source._id.toHexString(), source)
      }
      for (const source of sourceSnapshots.values()) {
        const sourceFence = await this.sources().updateOne({ _id: source._id, policyVersion: source.policyVersion, ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}) }, { $set: { updatedAt: now } }, { session })
        if (sourceFence.matchedCount !== 1) { const error = new Error('Current source policy changed'); error.status = 409; error.code = 'conflict'; throw error }
      }
      const { mergeProvenance } = await import('../../domain/article/dedupe.js')
      const provenance = mergeProvenance(canonical.provenance, ...duplicates.map((item) => item.provenance))
      const canonicalUpdate = await this.articles().updateOne({ _id: canonicalId, updatedAt: canonical.updatedAt }, { $set: { provenance, updatedAt: now } }, { session })
      if (canonicalUpdate.matchedCount !== 1) { const error = new Error('Canonical article changed before merge'); error.status = 409; error.code = 'conflict'; throw error }
      const duplicateUpdate = await this.articles().updateMany({ $and: [{ _id: { $in: duplicateIds } }, { status: { $ne: 'removed' } }] }, { $set: { status: 'hidden', hiddenReason: 'duplicate_merge_confirmed', duplicateOfId: canonicalId, leadMedia: null, leadMediaStatus: 'none', updatedAt: now } }, { session })
      if (duplicateUpdate.matchedCount !== duplicateIds.length) { const error = new Error('Duplicate article changed before merge'); error.status = 409; error.code = 'conflict'; throw error }
      const requestHash = canonicalRequestHash({ operation: 'duplicate-merge', canonicalArticleId: canonicalId.toHexString(), duplicateArticleIds: duplicateIds.map((id) => id.toHexString()).sort(), reasonCode })
      await this.insertAdminAudit({ actor, targetId: canonicalId, reasonCode, changedFields: ['provenance', 'status'], request: { ...request, requestId: String(idempotencyKey), eventIdentity: `${String(idempotencyKey)}:${requestHash}` }, now }, session)
      return { canonical: await this.findAdminArticle(canonicalId, { session }), duplicateCount: duplicateIds.length }
    })
  }

  async listAuditLogs(query = {}) {
    const limit = Number(query.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > CURSOR_LIMIT) { const error = new Error('Limit is invalid'); error.status = 422; error.code = 'validation_error'; throw error }
    const filter = {}
    for (const key of ['actorType', 'targetType']) if (query[key] !== undefined) filter[key] = query[key]
    for (const key of ['actorId', 'targetId']) if (query[key] !== undefined) filter[key] = ObjectId.isValid(query[key]) ? objectId(query[key]) : String(query[key])
    const cursor = decodeCursor(query.cursor)
    if (cursor) filter.$or = [{ createdAt: { $lt: cursor.at } }, { createdAt: cursor.at, _id: { $lt: cursor.id } }]
    const rows = await this.auditLogs().find(filter).sort({ createdAt: -1, _id: -1 }).project({ _id: 1, actorType: 1, actorId: 1, action: 1, targetType: 1, targetId: 1, changedFields: 1, stateTransition: 1, reasonCode: 1, requestId: 1, result: 1, createdAt: 1 }).limit(limit + 1).toArray()
    const hasNext = rows.length > limit
    const logs = hasNext ? rows.slice(0, limit) : rows
    const last = logs.at(-1)
    return { logs, hasNext, nextCursor: hasNext && last ? encodeAuditCursor(last) : null }
  }

  async purgeAuditIpHmac({ cutoff = this.clock(), limit = 100 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit)))
    const filter = { ipHmacPurgeAfter: { $lte: cutoff } }
    const rows = await this.auditLogs().find(filter).sort({ ipHmacPurgeAfter: 1, _id: 1 }).limit(safeLimit + 1).project({ _id: 1, ipHmacPurgeAfter: 1 }).toArray()
    const selected = rows.slice(0, safeLimit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.auditLogs().updateMany({ ...filter, _id: { $in: selected.map(({ _id }) => _id) } }, { $unset: { ipAddressHmac: '', ipHmacKeyVersion: '', ipHmacPurgeAfter: '' } })
    return { inspected: selected.length, affected: result.modifiedCount ?? 0, hasMore: rows.length > safeLimit }
  }
}

export { ARTICLE_PROJECTION }
