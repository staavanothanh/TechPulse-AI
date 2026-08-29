import { ObjectId } from 'mongodb'
import { validateSourceAuditInput } from '../../audit/source-writer.js'
import { JobError } from '../../domain/jobs/idempotency.js'

const SOURCE_STATUSES = new Set(['draft', 'testing', 'active', 'paused', 'archived'])
const LICENSE_STATUSES = new Set(['permitted', 'metadata-only', 'review-needed', 'blocked'])
const CONNECTOR_TYPES = new Set(['rss', 'arxiv', 'hacker-news'])

function idValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new Error('invalid Mongo identifier')
}

function dateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error('invalid source date')
}

function sourceDocument(source) {
  const { id, ...document } = source
  return {
    ...document,
    _id: idValue(id),
    connectorConfig: { ...source.connectorConfig }, storageScope: { ...source.storageScope },
    mediaPolicy: { ...source.mediaPolicy, allowedHosts: [...source.mediaPolicy.allowedHosts] },
    reconciliation: { ...source.reconciliation }, technicalCheck: { ...source.technicalCheck }, health: { ...source.health },
    reviewedBy: source.reviewedBy === null || source.reviewedBy === undefined ? null : idValue(source.reviewedBy),
    createdAt: dateValue(source.createdAt), updatedAt: dateValue(source.updatedAt),
  }
}

export function serializeSource(document) {
  if (!document) return null
  const source = Object.fromEntries(Object.entries(document).filter(([field]) => !['_id', 'qnaFenceToken'].includes(field)))
  return {
    id: document._id.toHexString(), ...source,
    connectorConfig: { ...document.connectorConfig }, storageScope: { ...document.storageScope },
    mediaPolicy: { ...document.mediaPolicy, allowedHosts: [...document.mediaPolicy.allowedHosts] },
    reconciliation: { ...document.reconciliation }, technicalCheck: { ...document.technicalCheck }, health: { ...document.health },
    reviewedBy: document.reviewedBy ? document.reviewedBy.toHexString() : null,
  }
}

function auditId(value) {
  if (value instanceof ObjectId || typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return idValue(value)
  if (typeof value === 'string' && /^[a-z][a-z0-9:-]{2,127}$/.test(value)) return value
  throw new Error('invalid audit identifier')
}
function sourceAuditDocument(document) {
  validateSourceAuditInput(document)
  if (!['admin', 'system-worker'].includes(document.actorType) || document.actorType === 'system-worker' && document.action !== 'source_created' || document.targetType !== 'source' || !['succeeded', 'failed'].includes(document.result) && !(document.action === 'source_policy_reconciliation_requested' && document.result === 'pending') || !document.eventId || !document.requestId) throw new Error('source audit identity is invalid')
  const safe = {
    _id: document._id ? idValue(document._id) : new ObjectId(), eventId: String(document.eventId), actorType: document.actorType, actorId: auditId(document.actorId),
    action: document.action, targetType: 'source', targetId: auditId(document.targetId), changedFields: [...document.changedFields], reasonCode: document.reasonCode,
    requestId: String(document.requestId), result: document.result, createdAt: dateValue(document.createdAt),
  }
  if (document.stateTransition) safe.stateTransition = { from: document.stateTransition.from, to: document.stateTransition.to }
  return safe
}

function stableAudit(value) {
  return JSON.stringify({ action: value.action, actorType: value.actorType, actorId: String(value.actorId), targetType: value.targetType, targetId: String(value.targetId), changedFields: value.changedFields, reasonCode: value.reasonCode, stateTransition: value.stateTransition ?? null, requestId: value.requestId, result: value.result })
}

function decodeCursor(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 1000) { const error = new Error('Source cursor is invalid'); error.code = 'source_validation'; throw error }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (Object.keys(parsed).sort().join(',') !== 'createdAt,id' || typeof parsed.createdAt !== 'string') throw new Error('invalid')
    return { createdAt: dateValue(new Date(parsed.createdAt)), id: idValue(parsed.id) }
  } catch { const error = new Error('Source cursor is invalid'); error.code = 'source_validation'; throw error }
}

function encodeCursor(document) {
  return Buffer.from(JSON.stringify({ createdAt: document.createdAt.toISOString(), id: document._id.toHexString() })).toString('base64url')
}

function sourceFilter(query) {
  const filter = {}
  if (query.operationalStatus !== undefined) {
    if (!SOURCE_STATUSES.has(query.operationalStatus)) throw new Error('invalid source operationalStatus')
    filter.operationalStatus = query.operationalStatus
  }
  if (query.licenseStatus !== undefined) {
    if (!LICENSE_STATUSES.has(query.licenseStatus)) throw new Error('invalid source licenseStatus')
    filter.licenseStatus = query.licenseStatus
  }
  if (query.connectorType !== undefined) {
    if (!CONNECTOR_TYPES.has(query.connectorType)) throw new Error('invalid source connectorType')
    filter.connectorType = query.connectorType
  }
  const cursor = decodeCursor(query.cursor)
  if (cursor) filter.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }]
  return filter
}

export class MongoSourceRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
  }

  collection(name) { return this.db.collection(name) }

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
    const now = new Date()
    const userId = idValue(fence.userId)
    const user = await this.collection('users').findOne({ _id: userId, role: 'admin', status: 'active', sessionVersion: fence.sessionVersion }, { session, projection: { _id: 1 } })
    const activeSession = await this.collection('sessions').findOne({ _id: idValue(fence.sessionId), userId, userSessionVersion: fence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { session, projection: { _id: 1 } })
    return Boolean(user && activeSession)
  }

  async insertAudit(audit, session) {
    const safe = sourceAuditDocument(audit)
    const existing = await this.collection('adminAuditLogs').findOne({ eventId: safe.eventId }, { session })
    if (existing) {
      if (stableAudit(existing) !== stableAudit(safe)) { const error = new Error('source audit event identity collision'); error.code = safe.action === 'source_policy_re_review_requested' ? 'idempotency_mismatch' : 'source_conflict'; throw error }
      return { document: existing, replay: true }
    }
    try {
      await this.collection('adminAuditLogs').insertOne(safe, { session })
    } catch (error) {
      if (error?.code === 11000 && safe.action === 'source_policy_re_review_requested') {
        const mismatch = new Error('source idempotency identity already exists')
        mismatch.code = 'idempotency_mismatch'
        throw mismatch
      }
      throw error
    }
    return { document: safe, replay: false }
  }

  async listSources(query = {}) {
    const limit = query.limit === undefined ? 20 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { const error = new Error('Source limit is invalid'); error.code = 'source_validation'; throw error }
    const documents = await this.collection('sources').find(sourceFilter(query)).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray()
    const hasNext = documents.length > limit
    const page = documents.slice(0, limit)
    return { sources: page.map(serializeSource), hasNext, nextCursor: hasNext ? encodeCursor(page.at(-1)) : null }
  }

  async findSourceById(id, options = {}) { return serializeSource(await this.collection('sources').findOne({ _id: idValue(id) }, options)) }
  async findSourceByKey(sourceKey, options = {}) { return serializeSource(await this.collection('sources').findOne({ sourceKey }, options)) }
  async findAuditReplay({ eventId }) {
    return this.collection('adminAuditLogs').findOne({ eventId }, { projection: { _id: 1, action: 1, targetId: 1, actorId: 1, requestId: 1, result: 1, createdAt: 1 } })
  }
  async findReconciliationRequest({ sourceId, actorId, requestId } = {}) {
    const filter = {
      action: 'source_policy_reconciliation_requested', targetType: 'source', actorId: idValue(actorId), requestId: String(requestId),
      ...(sourceId === undefined ? {} : { targetId: idValue(sourceId) }),
    }
    return this.collection('adminAuditLogs').findOne(filter, { projection: { _id: 1, eventId: 1, action: 1, targetId: 1, actorId: 1, requestId: 1, result: 1, createdAt: 1 } })
  }

  async commitReconciliationAudit({ audit, actorFence, rateLimitAdmission, admission } = {}) {
    const work = async (session) => {
      if (!await this.assertActorFence(actorFence, session)) { const error = new JobError(401, 'unauthorized', 'Actor session is no longer active'); throw error }
      const committed = await this.insertAudit(audit, session)
      if (committed.replay) return committed
      if (typeof rateLimitAdmission?.reserve !== 'function') throw new JobError(503, 'service_unavailable', 'Rate-limit admission is temporarily unavailable')
      let result
      try { result = await rateLimitAdmission.reserve({ ...(admission ?? {}), session }) } catch (error) {
        if (error instanceof JobError || error?.code === 11000 || error?.hasErrorLabel?.('TransientTransactionError')) throw error
        throw new JobError(503, 'service_unavailable', 'Rate-limit admission is temporarily unavailable')
      }
      if (!result || typeof result.allowed !== 'boolean') throw new JobError(503, 'service_unavailable', 'Rate-limit admission is temporarily unavailable')
      if (!result.allowed) throw new JobError(429, 'rate_limit_exceeded', 'Too many reconciliation requests', { retryAfter: result.retryAfterSeconds })
      return committed
    }
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.withTransaction(work)
      } catch (error) {
        // Two distinct requests can race the unique rate-bucket upsert in a
        // fresh window. One transaction aborts with 11000; retrying the whole
        // audit+admission transaction preserves the atomic invariant.
        if (error?.code !== 11000 || attempt === 2) throw error
        lastError = error
      }
    }
    throw lastError
  }

  async commitCreate({ source, audit, actorFence }) {
    return this.withTransaction(async (session) => {
      if (!await this.assertActorFence(actorFence, session)) { const error = new Error('actor session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
      await this.collection('sources').insertOne(sourceDocument(source), { session })
      await this.insertAudit(audit, session)
      return source
    })
  }

  async seedDraft({ source, audit }) {
    try {
      return await this.withTransaction(async (session) => {
        const existing = await this.collection('sources').findOne({ sourceKey: source.sourceKey }, { session })
        if (existing) return { source: serializeSource(existing), seeded: false, existing: true }
        await this.collection('sources').insertOne(sourceDocument(source), { session })
        await this.insertAudit(audit, session)
        return { source, seeded: true, existing: false }
      })
    } catch (error) {
      if (error?.code !== 11000) throw error
      const existing = await this.findSourceByKey(source.sourceKey)
      if (!existing) throw error
      return { source: existing, seeded: false, existing: true }
    }
  }

  async commitFailedAudit({ audit, actorFence }) {
    return this.withTransaction(async (session) => {
      if (!await this.assertActorFence(actorFence, session)) { const error = new Error('actor session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
      return (await this.insertAudit(audit, session)).document
    })
  }

  async commitReplacement({ source, expectedUpdatedAt, expectedPolicyVersion, audit, actorFence }) {
    const expectedTimestamp = dateValue(expectedUpdatedAt)
    const nextTimestamp = dateValue(source.updatedAt)
    if (nextTimestamp.getTime() <= expectedTimestamp.getTime() || !Number.isInteger(expectedPolicyVersion) || ![expectedPolicyVersion, expectedPolicyVersion + 1].includes(source.policyVersion)) { const error = new Error('source replacement CAS values are invalid'); error.code = 'source_validation'; throw error }
    return this.withTransaction(async (session) => {
      if (!await this.assertActorFence(actorFence, session)) { const error = new Error('actor session is no longer active'); error.status = 401; error.code = 'unauthorized'; throw error }
      const replay = await this.collection('adminAuditLogs').findOne({ eventId: audit.eventId }, { session })
      if (replay) {
        if (stableAudit(replay) !== stableAudit(sourceAuditDocument(audit))) { const error = new Error('source audit event identity collision'); error.code = audit.action === 'source_policy_re_review_requested' ? 'idempotency_mismatch' : 'source_conflict'; throw error }
        return this.findSourceById(source.id, { session })
      }
      const result = await this.collection('sources').replaceOne({ _id: idValue(source.id), updatedAt: expectedTimestamp, policyVersion: expectedPolicyVersion }, sourceDocument(source), { session })
      if (result.matchedCount !== 1) { const error = new Error('source changed concurrently'); error.code = 'source_conflict'; throw error }
      await this.insertAudit(audit, session)
      return source
    })
  }
}
