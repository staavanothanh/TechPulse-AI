import { ObjectId } from 'mongodb'
import { createTakedownRepository, redactCitationsForTarget } from '../../application/takedowns/repository.js'
import { buildRemovedArticleTombstone } from '../../domain/article/removed-tombstone.js'

const MAX_CITATION_PAGE = 100
const MAX_RETENTION_BATCH = 100
const TERMINAL_TAKEDOWN_STATUSES = Object.freeze(['rejected', 'completed'])
const REMOVED_METADATA_FIELDS = Object.freeze([
  'titleOriginal', 'titleVi', 'originalUrl', 'canonicalUrl', 'author', 'provenance',
  'excerptOriginal', 'searchTextNormalized', 'leadMedia', 'leadMediaStatus', 'summaryVi', 'summaryStatus',
  'summaryBasis', 'summaryModel', 'summaryInputHash', 'summarySourcePolicyVersion', 'summaryGeneratedAt',
  'summaryError', 'embedding', 'embeddingStatus', 'embeddingModel', 'embeddingDimensions',
  'embeddingInputHash', 'embeddingVersion', 'embeddingSourcePolicyVersion', 'embeddedAt', 'embeddingError',
  'rightsSnapshot', 'authorityTier', 'sourceType', 'publishedAt', 'retrievedAt', 'sourceLanguage', 'topics',
  'contentScope', 'hiddenReason', 'duplicateOfId', 'duplicateReason',
])

function objectId(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  throw new Error('Takedown identifier is invalid')
}

function unwrap(value) { return value?.value ?? value }

function removedMetadataFilter(base) {
  return {
    ...base,
    status: 'removed',
    evidenceEligible: false,
    canonicalUrlHash: { $type: 'string' },
    removalPolicyVersion: { $gte: 1 },
    ...Object.fromEntries(REMOVED_METADATA_FIELDS.map((field) => [field, { $exists: false }])),
  }
}

function pendingMetadataFilter(base) {
  return {
    ...base,
    $or: [
      { status: { $ne: 'removed' } },
      { removalPolicyVersion: { $exists: false } },
      ...REMOVED_METADATA_FIELDS.map((field) => ({ [field]: { $exists: true } })),
    ],
  }
}

export class MongoTakedownRepository {
  constructor(context) {
    if (!context?.db) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.governanceDb = context.governanceDb
    this.governanceKeyring = context.governanceKeyring
    this.clock = context.now ?? (() => new Date())
  }

  collection(name) { return this.db.collection(name) }

  withTransaction(work) {
    const session = this.client?.startSession?.()
    if (!session) throw new Error('Mongo transaction session is required')
    return session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }).finally(() => session.endSession())
  }

  async list(query = {}) { return createTakedownRepository({ collection: this.collection('takedownRequests'), now: this.clock }).list(query) }

  async getDetail(requestId, options = {}) { return createTakedownRepository({ collection: this.collection('takedownRequests'), now: this.clock }).getDetail(requestId, options) }

  async findById(requestId, options = {}) { return this.collection('takedownRequests').findOne({ _id: objectId(requestId) }, options) }

  async create(document, options = {}) { await this.collection('takedownRequests').insertOne(document, options); return document }

  async insert(document, options = {}) { return this.create(document, options) }

  async assertActorFence(fence, session) {
    if (!fence || !Number.isInteger(fence.sessionVersion)) return false
    const userId = objectId(fence.userId)
    const sessionId = objectId(fence.sessionId)
    const now = this.clock()
    const user = await this.collection('users').updateOne(
      { _id: userId, role: 'admin', status: 'active', sessionVersion: fence.sessionVersion },
      { $set: { updatedAt: now } },
      { session },
    )
    const activeSession = await this.collection('sessions').updateOne(
      { _id: sessionId, userId, userSessionVersion: fence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } },
      { $set: { lastSeenAt: now } },
      { session },
    )
    return user.matchedCount === 1 && activeSession.matchedCount === 1
  }

  async assertTargetsCurrent({ targetType, targetIds, desiredStatus, session } = {}) {
    const ids = targetIds.map(objectId)
    const collection = targetType === 'article' ? this.collection('articles') : this.collection('sources')
    const filter = targetType === 'article'
      ? desiredStatus === 'completed' ? { _id: { $in: ids }, status: { $in: ['hidden', 'removed'] }, evidenceEligible: false } : { _id: { $in: ids }, status: { $ne: 'removed' } }
      : desiredStatus === 'completed' ? { _id: { $in: ids }, operationalStatus: 'paused' } : { _id: { $in: ids }, operationalStatus: { $ne: 'archived' } }
    return (await collection.countDocuments(filter, { session })) === ids.length
  }

  async insertAudit({ action, targetId, actor, request, now, result = 'pending' } = {}, session) {
    const target = objectId(targetId)
    const requestId = String(request?.serverRequestId ?? request?.requestId ?? 'takedown-request')
    const allowed = new Map([
      ['takedown_received', ['status']],
      ['takedown_review_started', ['status']],
      ['takedown_approved', ['status']],
      ['takedown_rejected', ['status']],
      ['takedown_completed', ['status', 'completion']],
    ])
    const changedFields = allowed.get(action)
    if (!changedFields) throw new Error('Takedown audit action is not allowlisted')
    const eventId = `takedown:${action}:${target.toHexString()}:${requestId}`
    const actorId = actor?._id ?? actor?.id
    if (!actorId) throw new Error('Takedown audit actor is invalid')
    const document = {
      _id: new ObjectId(), eventId, actorType: 'admin', actorId: actorId instanceof ObjectId ? actorId : objectId(actorId), action,
      targetType: 'takedown-request', targetId: target, changedFields, reasonCode: action, requestId, result, createdAt: now,
    }
    const existing = await this.collection('adminAuditLogs').findOne({ eventId }, { session })
    if (existing) return existing
    await this.collection('adminAuditLogs').insertOne(document, { session })
    return document
  }

  async hideTargets({ targetType, targetIds, reasonCode, session, now } = {}) {
    const ids = targetIds.map(objectId)
    if (targetType === 'article') {
      const result = await this.collection('articles').updateMany(
        { _id: { $in: ids }, status: { $in: ['published', 'review-needed', 'processing', 'hidden'] }, $or: [{ status: { $ne: 'hidden' } }, { status: 'hidden', evidenceEligible: false }] },
        { $set: { status: 'hidden', evidenceEligible: false, hiddenReason: reasonCode, updatedAt: now, leadMedia: null, leadMediaStatus: 'none' } },
        { session },
      )
      if (result.matchedCount !== ids.length) throw Object.assign(new Error('Article hide fence changed'), { status: 409, code: 'conflict' })
      return
    }
    const sources = this.collection('sources')
    for (const id of ids) {
      const source = await sources.findOne({ _id: id, operationalStatus: { $ne: 'archived' } }, { session, projection: { policyVersion: 1 } })
      if (!source || !Number.isInteger(source.policyVersion)) throw Object.assign(new Error('Source hide fence changed'), { status: 409, code: 'conflict' })
      const nextPolicyVersion = source.policyVersion + 1
      const result = await sources.updateOne(
        { _id: id, operationalStatus: { $ne: 'archived' }, policyVersion: source.policyVersion },
        { $set: { operationalStatus: 'paused', policyVersion: nextPolicyVersion, updatedAt: now, 'reconciliation.status': 'pending', 'reconciliation.requiredPolicyVersion': nextPolicyVersion, 'reconciliation.requestedAt': now, 'reconciliation.completedPolicyVersion': null, 'reconciliation.error': null } },
        { session },
      )
      if (result.matchedCount !== 1) throw Object.assign(new Error('Source hide fence changed'), { status: 409, code: 'conflict' })
    }
    const sourceArticleFilter = { sourceId: { $in: ids }, status: { $in: ['published', 'processing', 'review-needed', 'hidden'] }, $or: [{ status: { $ne: 'hidden' } }, { status: 'hidden', evidenceEligible: false }] }
    const articles = this.collection('articles')
    const expectedArticleCount = typeof articles.countDocuments === 'function' ? await articles.countDocuments(sourceArticleFilter, { session, hint: 'articles_status_source_time' }) : null
    const articleResult = await articles.updateMany(
      sourceArticleFilter,
      { $set: { status: 'hidden', evidenceEligible: false, hiddenReason: reasonCode, updatedAt: now, leadMedia: null, leadMediaStatus: 'none' } },
      { session },
    )
    if (expectedArticleCount !== null && articleResult.matchedCount !== expectedArticleCount) throw Object.assign(new Error('Source article hide fence changed'), { status: 409, code: 'conflict' })
    if (typeof articles.countDocuments === 'function') {
      const visibleCount = await articles.countDocuments({ sourceId: { $in: ids }, status: { $in: ['published', 'processing', 'review-needed'] } }, { session, hint: 'articles_status_source_time' })
      if (visibleCount !== 0) throw Object.assign(new Error('Source article visibility fence changed'), { status: 409, code: 'conflict' })
    }
  }

  async assertTerminalTargetsCurrent({ targetType, targetIds, requestedScope = [], session } = {}) {
    const ids = targetIds.map(objectId)
    const collection = targetType === 'article' ? this.collection('articles') : this.collection('sources')
    const metadataRequested = requestedScope.includes('metadata')
    const filter = targetType === 'article'
      ? metadataRequested
        ? removedMetadataFilter({ _id: { $in: ids } })
        : {
            _id: { $in: ids }, status: 'hidden', evidenceEligible: false,
            ...(requestedScope.includes('media-metadata') ? { leadMedia: null, leadMediaStatus: 'none' } : {}),
            ...(requestedScope.includes('summary') ? { summaryStatus: 'removed', summaryVi: null, summaryDetailStatus: 'removed', summaryParagraphsVi: null } : {}),
            ...(requestedScope.includes('embedding') ? { embeddingStatus: 'removed', embedding: null } : {}),
          }
      : { _id: { $in: ids }, operationalStatus: 'paused' }
    const result = await collection.updateMany(filter, { $set: { updatedAt: this.clock() } }, { session })
    if (result.matchedCount !== ids.length) throw Object.assign(new Error('Takedown target lifecycle changed'), { status: 409, code: 'conflict' })
    if (targetType === 'source') {
      const articles = this.collection('articles')
      const visible = await articles.countDocuments({ sourceId: { $in: ids }, status: { $in: ['published', 'processing', 'review-needed'] } }, { session, hint: 'articles_status_source_time' })
      if (visible !== 0) throw Object.assign(new Error('Source article lifecycle changed'), { status: 409, code: 'conflict' })
      const artifactFilter = metadataRequested
        ? removedMetadataFilter({ sourceId: { $in: ids } })
        : { sourceId: { $in: ids }, status: 'hidden', evidenceEligible: false }
      if (!metadataRequested && requestedScope.includes('media-metadata')) Object.assign(artifactFilter, { leadMedia: null, leadMediaStatus: 'none' })
      if (!metadataRequested && requestedScope.includes('summary')) Object.assign(artifactFilter, { summaryStatus: 'removed', summaryVi: null, summaryDetailStatus: 'removed', summaryParagraphsVi: null })
      if (!metadataRequested && requestedScope.includes('embedding')) Object.assign(artifactFilter, { embeddingStatus: 'removed', embedding: null })
      const targetCount = await articles.countDocuments({ sourceId: { $in: ids } }, { session, hint: 'articles_status_source_time' })
      const fencedCount = await articles.countDocuments(artifactFilter, { session, hint: 'articles_status_source_time' })
      if (targetCount !== fencedCount) throw Object.assign(new Error('Source article artifact lifecycle changed'), { status: 409, code: 'conflict' })
    }
    return true
  }

  async cleanupArtifacts({ targetType, targetIds, requestedScope, session, now, limit = MAX_CITATION_PAGE } = {}) {
    const ids = targetIds.map(objectId)
    const metadataRequested = requestedScope.includes('metadata')
    const completion = {
      metadataRemoved: false,
      mediaMetadataRemoved: false,
      summaryRemoved: false,
      embeddingRemoved: false,
      historicalChatCitationsRedacted: false,
    }
    const sourcePolicyVersions = new Map()
    if (targetType === 'article') {
      const lifecycleStatuses = metadataRequested ? ['hidden', 'removed'] : ['hidden']
      const fence = await this.collection('articles').updateMany({ _id: { $in: ids }, status: { $in: lifecycleStatuses }, evidenceEligible: false }, { $set: { updatedAt: now } }, { session })
      if (fence.matchedCount !== ids.length) throw Object.assign(new Error('Article cleanup lifecycle changed'), { status: 409, code: 'conflict' })
    } else {
      const sources = this.collection('sources')
      for (const sourceId of ids) {
        const source = await sources.findOne({ _id: sourceId, operationalStatus: 'paused' }, { session, projection: { policyVersion: 1 } })
        if (!source || !Number.isInteger(source.policyVersion)) throw Object.assign(new Error('Source cleanup lifecycle changed'), { status: 409, code: 'conflict' })
        sourcePolicyVersions.set(sourceId.toHexString(), source.policyVersion)
        const fence = await sources.updateOne({ _id: sourceId, operationalStatus: 'paused', policyVersion: source.policyVersion }, { $set: { updatedAt: now } }, { session })
        if (fence.matchedCount !== 1) throw Object.assign(new Error('Source cleanup lifecycle changed'), { status: 409, code: 'conflict' })
      }
      const visibleArticles = this.collection('articles')
      if (typeof visibleArticles.countDocuments === 'function') {
        const visibleCount = await visibleArticles.countDocuments({ sourceId: { $in: ids }, status: { $in: ['published', 'processing', 'review-needed'] } }, { session, hint: 'articles_status_source_time' })
        if (visibleCount !== 0) throw Object.assign(new Error('Source cleanup lifecycle changed'), { status: 409, code: 'conflict' })
      }
    }
    const lifecycleStatuses = metadataRequested ? ['hidden', 'removed'] : ['hidden']
    const articleFilter = targetType === 'article'
      ? { _id: { $in: ids }, status: { $in: lifecycleStatuses }, evidenceEligible: false }
      : { sourceId: { $in: ids }, status: { $in: lifecycleStatuses }, evidenceEligible: false }
    const articleCollection = this.collection('articles')
    const pageLimit = Math.max(1, Math.min(MAX_CITATION_PAGE, Number(limit) || MAX_CITATION_PAGE))
    let artifactHasMore = false
    if (metadataRequested) {
      let articleQuery = articleCollection.find(pendingMetadataFilter(articleFilter), { session })
      if (typeof articleQuery.hint === 'function') articleQuery = articleQuery.hint(targetType === 'source' ? 'articles_status_source_time' : '_id_')
      const articleRows = await articleQuery.limit(pageLimit + 1).toArray()
      for (const article of articleRows.slice(0, pageLimit)) {
        const policyVersion = article.removalPolicyVersion ?? article.rightsSnapshot?.sourcePolicyVersion ?? sourcePolicyVersions.get(article.sourceId?.toHexString?.())
        const tombstone = buildRemovedArticleTombstone({ ...article, removalPolicyVersion: policyVersion }, { now })
        const replaced = await articleCollection.replaceOne(
          { _id: article._id, status: article.status, evidenceEligible: false, updatedAt: article.updatedAt },
          tombstone,
          { session },
        )
        if (replaced.matchedCount !== 1) throw Object.assign(new Error('Article metadata cleanup lifecycle changed'), { status: 409, code: 'conflict' })
      }
      const remainingMetadata = await articleCollection.countDocuments(pendingMetadataFilter(articleFilter), { session })
      completion.metadataRemoved = remainingMetadata === 0
      artifactHasMore = articleRows.length > pageLimit || remainingMetadata > 0
      if (requestedScope.includes('media-metadata')) completion.mediaMetadataRemoved = completion.metadataRemoved
      if (requestedScope.includes('summary')) completion.summaryRemoved = completion.metadataRemoved
      if (requestedScope.includes('embedding')) completion.embeddingRemoved = completion.metadataRemoved
    } else {
      const set = { updatedAt: now, evidenceEligible: false }
      if (requestedScope.includes('media-metadata')) { set.leadMedia = null; set.leadMediaStatus = 'none' }
      if (requestedScope.includes('summary')) Object.assign(set, { summaryVi: null, summaryParagraphsVi: null, summaryStatus: 'removed', summaryDetailStatus: 'removed', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null })
      if (requestedScope.includes('embedding')) Object.assign(set, { embedding: null, embeddingStatus: 'removed', embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null })
      const articleCount = typeof articleCollection.countDocuments === 'function' ? await articleCollection.countDocuments(articleFilter, { session, hint: 'articles_status_source_time' }) : null
      const articleUpdate = await articleCollection.updateMany(articleFilter, { $set: set }, { session })
      if (articleCount !== null && articleUpdate.matchedCount !== articleCount) throw Object.assign(new Error('Article cleanup lifecycle changed'), { status: 409, code: 'conflict' })
      completion.mediaMetadataRemoved = requestedScope.includes('media-metadata')
      completion.summaryRemoved = requestedScope.includes('summary')
      completion.embeddingRemoved = requestedScope.includes('embedding')
    }

    const chat = this.collection('chatSessions')
    const citationField = targetType === 'article' ? 'messages.citations.articleId' : 'messages.citations.sourceId'
    const directIndex = targetType === 'article' ? 'chat_sessions_citation_article' : 'chat_sessions_citation_source'
    const targetField = targetType === 'article' ? 'articleId' : 'sourceId'
    const filter = {
      [citationField]: { $in: ids },
      messages: { $elemMatch: { role: 'assistant', status: 'answered', citations: { $elemMatch: { [targetField]: { $in: ids }, status: 'available' } } } },
    }
    let query = chat.find(filter, { session, projection: { _id: 1, updatedAt: 1, messageCount: 1, messages: 1 } })
    if (typeof query.hint === 'function') query = query.hint(directIndex)
    const rows = await query.sort({ _id: 1 }).limit(pageLimit + 1).toArray()
    const selected = rows.slice(0, pageLimit)
    for (const row of selected) {
      const messages = (row.messages ?? []).map((message) => message.status === 'answered' ? { ...message, citations: redactCitationsForTarget(message.citations, { targetType, targetIds: ids }) } : message)
      const updated = await chat.updateOne({ _id: row._id, updatedAt: row.updatedAt, messageCount: row.messageCount }, { $set: { messages, updatedAt: now } }, { session })
      if (updated.matchedCount !== 1) throw Object.assign(new Error('Historical citation lifecycle changed'), { status: 409, code: 'conflict' })
    }
    const hasMore = artifactHasMore || rows.length > pageLimit
    const remaining = await chat.countDocuments(filter, { session, hint: directIndex })
    completion.historicalChatCitationsRedacted = remaining === 0 && !artifactHasMore
    return { ...completion, hasMore }
  }

  async materializeCleanupBatch({ now = this.clock(), limit = MAX_CITATION_PAGE } = {}) {
    const pageLimit = Math.max(1, Math.min(MAX_CITATION_PAGE, Number(limit) || MAX_CITATION_PAGE))
    return this.withTransaction(async (session) => {
      let query = this.collection('takedownRequests').find({ status: 'approved', 'completion.historicalChatCitationsRedacted': false }, { session })
      if (typeof query.hint === 'function') query = query.hint('takedown_cleanup_due')
      const workflows = await query.sort({ updatedAt: 1, _id: 1 }).limit(1).toArray()
      const workflow = workflows[0]
      if (!workflow) return { processed: false, hasMore: false }
      const completion = await this.cleanupArtifacts({ targetType: workflow.targetType, targetIds: workflow.targetIds, requestedScope: workflow.requestedScope, session, now, limit: pageLimit })
      const update = { updatedAt: now }
      for (const [field, value] of Object.entries(completion)) {
        if (field !== 'hasMore') update[`completion.${field}`] = value
      }
      const result = await this.collection('takedownRequests').findOneAndUpdate({ _id: workflow._id, status: 'approved', updatedAt: workflow.updatedAt }, { $set: update }, { session, returnDocument: 'after' })
      const next = unwrap(result)
      if (!next) throw Object.assign(new Error('Takedown cleanup lifecycle changed'), { status: 409, code: 'conflict' })
      return { processed: true, requestId: next._id, hasMore: completion.hasMore === true, completion: next.completion }
    })
  }

  async insertSuppression({ requestId, targetType, targetIds, requestedScope, now, session } = {}) {
    if (!this.governanceDb || !this.governanceKeyring?.digest || !this.governanceKeyring.currentVersion) throw Object.assign(new Error('Governance signing capability unavailable'), { status: 503, code: 'service_unavailable' })
    const id = objectId(requestId)
    const sortedTargetIds = targetIds.map(objectId).map((value) => value.toHexString()).sort()
    const sortedScope = [...requestedScope].map(String).sort()
    const keyVersion = this.governanceKeyring.currentVersion
    const canonicalPayload = [id.toHexString(), targetType, sortedTargetIds.join(','), sortedScope.join(','), new Date(now).toISOString(), String(keyVersion)].join('|')
    const document = {
      _id: new ObjectId(), eventId: `takedown:${id.toHexString()}`, kind: 'takedown', requestId: id, targetType,
      targetIds: sortedTargetIds.map((value) => new ObjectId(value)), requestedScope: sortedScope, effectiveAt: now,
      payloadDigest: this.governanceKeyring.digest(`payload:${canonicalPayload}`), signatureKeyVersion: keyVersion,
      signature: this.governanceKeyring.digest(`signature:${canonicalPayload}`), createdAt: now,
    }
    await this.governanceDb.collection('governanceSuppressions').insertOne(document, { session })
    return document
  }

  async transition({ current, status, reasonCode, actor, request, session, now } = {}) {
    const id = objectId(current._id)
    const targetIds = current.targetIds.map(objectId)
    const update = { status, decisionReasonCode: reasonCode, updatedAt: now }
    if (status === 'approved' || status === 'rejected') Object.assign(update, { reviewedBy: objectId(actor._id ?? actor.id), reviewedAt: now })
    if (status === 'rejected') Object.assign(update, { completedAt: now, piiPurgeAfter: new Date(now.getTime() + 90 * 86400000), workflowPurgeAfter: new Date(now.getTime() + 180 * 86400000) })
    if (status === 'approved') { await this.hideTargets({ targetType: current.targetType, targetIds, reasonCode, session, now }); update['completion.hidden'] = true }
    if (status === 'completed') {
      const completion = current.completion ?? {}
      const completeForScope = current.requestedScope.every((scope) => completion[{ metadata: 'metadataRemoved', 'media-metadata': 'mediaMetadataRemoved', summary: 'summaryRemoved', embedding: 'embeddingRemoved' }[scope]] === true)
      if (completion.hidden !== true || !completeForScope || completion.historicalChatCitationsRedacted !== true) throw Object.assign(new Error('Historical citation cleanup is incomplete'), { status: 409, code: 'conflict' })
      await this.assertTerminalTargetsCurrent({ targetType: current.targetType, targetIds, requestedScope: current.requestedScope, session })
      update.completedAt = now; update.piiPurgeAfter = new Date(now.getTime() + 90 * 86400000); update.workflowPurgeAfter = new Date(now.getTime() + 180 * 86400000)
    }
    const result = await this.collection('takedownRequests').findOneAndUpdate({ _id: id, status: current.status }, { $set: update }, { session, returnDocument: 'after' })
    const next = unwrap(result)
    if (!next) throw Object.assign(new Error('Takedown request changed concurrently'), { status: 409, code: 'conflict' })
    await this.insertAudit({ action: reasonCode, targetId: id, actor, request, now, result: 'succeeded' }, session)
    if (status === 'completed') await this.insertSuppression({ requestId: id, targetType: current.targetType, targetIds, requestedScope: current.requestedScope, now, session })
    return next
  }

  async update(requestId, expectedStatus, update, options = {}) {
    const result = await this.collection('takedownRequests').findOneAndUpdate({ _id: objectId(requestId), status: expectedStatus }, update, { ...options, returnDocument: 'after' })
    return unwrap(result)
  }

  async purgeWorkflows({ cutoff = this.clock(), limit = 100 } = {}) {
    const filter = { status: { $in: TERMINAL_TAKEDOWN_STATUSES }, workflowPurgeAfter: { $lte: cutoff } }
    const rows = await this.collection('takedownRequests').find(filter).sort({ workflowPurgeAfter: 1, _id: 1 }).limit(limit + 1).project({ _id: 1 }).toArray()
    const selected = rows.slice(0, limit)
    const result = selected.length ? await this.collection('takedownRequests').deleteMany({ ...filter, _id: { $in: selected.map(({ _id }) => _id) } }) : { deletedCount: 0 }
    return { inspected: selected.length, affected: result.deletedCount, hasMore: rows.length > limit }
  }

  async purgePii({ cutoff = this.clock(), limit = MAX_RETENTION_BATCH } = {}) {
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw Object.assign(new Error('Takedown PII cutoff is invalid'), { status: 422, code: 'validation_error' })
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RETENTION_BATCH) throw Object.assign(new Error('Takedown PII batch is invalid'), { status: 422, code: 'validation_error' })
    const predicate = {
      status: { $in: TERMINAL_TAKEDOWN_STATUSES },
      piiPurgeAfter: { $exists: true, $lte: cutoff },
    }
    let query = this.collection('takedownRequests').find(predicate, { projection: { _id: 1, piiPurgeAfter: 1 } })
    if (typeof query.hint === 'function') query = query.hint('takedown_pii_deadline')
    const rows = await query.sort({ piiPurgeAfter: 1, _id: 1 }).limit(limit + 1).toArray()
    const selected = rows.slice(0, limit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.collection('takedownRequests').updateMany(
      { ...predicate, _id: { $in: selected.map(({ _id }) => _id) } },
      { $unset: { requesterName: '', requesterContact: '', reason: '', evidenceNote: '', piiPurgeAfter: '' } },
    )
    return { inspected: selected.length, affected: result.modifiedCount ?? 0, hasMore: rows.length > limit }
  }
}
