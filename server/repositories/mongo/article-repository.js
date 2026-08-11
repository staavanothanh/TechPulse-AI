import { ObjectId } from 'mongodb'
import { assertCanonicalLeaseKey } from '../../domain/jobs/lease-keys.js'
import { assessDedupe, mergeArticleRecords } from '../../domain/article/dedupe.js'
import { ArticleError, articleConflict, leaseFenceStale, policyVersionMismatch, sourcePolicyBlocked } from '../../domain/article/errors.js'
import { hideArticle as hideArticleRecord, removeArticle as removeArticleRecord, restoreArticle as restoreArticleRecord } from '../../domain/article/lifecycle.js'
import { normalizeCandidateToArticle } from '../../domain/article/normalization.js'
import { evaluateMediaPolicy } from '../../domain/policy/media-policy.js'
import { canUseQnaEvidence, currentArticleVisibilityFilter, isSourceProductionEligible, qnaEvidenceFilter } from '../../domain/article/visibility.js'
import { validateArticleDocument } from '../../../scripts/migrations/articles.js'

const COUNTER_KEYS = Object.freeze(['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed'])
const FORBIDDEN_FIELDS = Object.freeze(['raw', 'rawHtml', 'html', 'body', 'content', 'fullText', 'translatedFullText', 'mediaBinary', 'binary', 'imageBinary', 'videoBinary', 'audioBinary', 'base64', 'gridFsId', 'providerPayload'])

function idValue(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw leaseFenceStale()
}

function dateValue(value, label = 'Article date') {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new ArticleError('article_invalid', `${label} is invalid`, { status: 422 })
  return date
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function safeCounters(value = {}) {
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, Number.isInteger(value[key]) && value[key] >= 0 ? value[key] : 0]))
}

function addCounters(current, delta) {
  const left = safeCounters(current)
  const right = safeCounters(delta)
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, left[key] + right[key]]))
}

function counterDelta(result, counters) {
  const explicit = safeCounters(counters)
  return Object.fromEntries(COUNTER_KEYS.map((key) => [key, result[key] + (key === 'fetched' ? 0 : explicit[key])]))
}

function safeCheckpoint(value, fallback) {
  const checkpoint = value ?? fallback ?? {}
  if (!Number.isInteger(checkpoint.processedCount) || checkpoint.processedCount < 0) throw new ArticleError('article_checkpoint_invalid', 'Article checkpoint is invalid', { status: 422 })
  const result = { processedCount: checkpoint.processedCount }
  if (checkpoint.cursor !== undefined) result.cursor = String(checkpoint.cursor).slice(0, 2000)
  if (checkpoint.lastExternalId !== undefined) result.lastExternalId = String(checkpoint.lastExternalId).slice(0, 500)
  return result
}

function articleDocument(article, id = new ObjectId()) {
  const value = { ...article, _id: idValue(article._id ?? id), sourceId: idValue(article.sourceId), provenance: (article.provenance ?? []).map((entry) => ({ ...entry, sourceId: idValue(entry.sourceId), originalUrl: String(entry.originalUrl), observedAt: dateValue(entry.observedAt) })), createdAt: dateValue(article.createdAt), updatedAt: dateValue(article.updatedAt), publishedAt: dateValue(article.publishedAt), retrievedAt: dateValue(article.retrievedAt) }
  delete value.id
  if (value.duplicateOfId) value.duplicateOfId = idValue(value.duplicateOfId)
  for (const field of FORBIDDEN_FIELDS) delete value[field]
  const validation = validateArticleDocument(value)
  if (!validation.valid) throw new ArticleError('article_invalid', 'Article document is invalid', { status: 422, details: validation.errors })
  return value
}

export function serializeArticle(document) {
  if (!document) return null
  const value = { ...document, id: document._id?.toHexString?.() ?? String(document.id), sourceId: document.sourceId?.toHexString?.() ?? String(document.sourceId), provenance: (document.provenance ?? []).map((entry) => ({ ...entry, sourceId: entry.sourceId?.toHexString?.() ?? String(entry.sourceId) })) }
  delete value._id
  if (value.duplicateOfId) value.duplicateOfId = value.duplicateOfId.toHexString?.() ?? String(value.duplicateOfId)
  for (const field of FORBIDDEN_FIELDS) delete value[field]
  return value
}

function commitFence(fence, job) {
  try { assertCanonicalLeaseKey(fence?.key) } catch { throw leaseFenceStale() }
  if (!fence || typeof fence.ownerTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(fence.ownerTokenHash) || !Number.isInteger(fence.leaseGeneration) || fence.leaseGeneration < 1) throw leaseFenceStale()
  if (job && Number.isInteger(job.leaseGeneration) && job.leaseGeneration !== fence.leaseGeneration) throw leaseFenceStale()
  if (job?.sourceId !== undefined && fence.key !== `ingestion:source:${String(job.sourceId).toLowerCase()}`) throw leaseFenceStale()
}

function jobIdentifier(job) {
  return job?.id ?? job?._id
}

function sameIdentifier(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null && String(left).toLowerCase() === String(right).toLowerCase()
}

function assertArticleMatchesCurrent(article, source) {
  if (!article || !source || !sameIdentifier(article.sourceId, source._id ?? source.id ?? source.sourceId) || article.connectorType !== source.connectorType || article.authorityTier !== source.authorityTier || article.sourceType !== (source.sourceKey ?? source.connectorType) || article.evidenceEligible !== (source.authorityTier !== 'community-signal')) throw policyVersionMismatch()
  if (!article.rightsSnapshot || article.rightsSnapshot.sourcePolicyVersion !== source.policyVersion || article.rightsSnapshot.licenseStatus !== source.licenseStatus || article.rightsSnapshot.llmInputScope !== source.llmInputScope) throw policyVersionMismatch()
  if (article.leadMedia && (article.leadMedia.sourcePolicyVersion !== source.policyVersion || !evaluateMediaPolicy(source, article.leadMedia).allowed)) throw sourcePolicyBlocked()
}

function safeMetadata(value, keys, maximum = 2000) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  for (const key of keys) if (typeof value[key] === 'string' && value[key].length <= maximum) result[key] = value[key]
  return Object.keys(result).length > 0 ? result : undefined
}

function safeMediaCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  for (const key of ['type', 'url', 'sourcePageUrl', 'alt', 'altText', 'credit']) if (typeof value[key] === 'string' && value[key].length <= 2048) result[key] = value[key]
  return Object.keys(result).length > 0 ? result : undefined
}

function safeCandidate(candidate) {
  const allowed = ['connectorType', 'sourceId', 'authorityTier', 'externalId', 'externalIdVersion', 'titleOriginal', 'originalUrl', 'publishedAt', 'retrievedAt', 'sourceLanguage', 'topics', 'excerptOriginal', 'licenseMetadata', 'sourceMetadata', 'provenance', 'communitySignal', 'communityScore', 'commentCount', 'mediaCandidate']
  const value = Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(candidate ?? {}, key)).map((key) => [key, candidate[key]]))
  for (const field of FORBIDDEN_FIELDS) delete value[field]
  if (Object.prototype.hasOwnProperty.call(value, 'mediaCandidate')) value.mediaCandidate = safeMediaCandidate(value.mediaCandidate)
  if (Object.prototype.hasOwnProperty.call(value, 'licenseMetadata')) value.licenseMetadata = safeMetadata(value.licenseMetadata, ['status', 'url', 'text'])
  if (Object.prototype.hasOwnProperty.call(value, 'sourceMetadata')) value.sourceMetadata = safeMetadata(value.sourceMetadata, ['doi', 'journalRef', 'comment'])
  return value
}

function serializeVisibleArticle(document, source) {
  const article = serializeArticle(document)
  if (!article) return null
  if (article.leadMediaStatus !== 'available' || !article.leadMedia) {
    article.leadMedia = null
    return article
  }
  if (!source || article.leadMedia.sourcePolicyVersion !== source.policyVersion) {
    article.leadMedia = null
    article.leadMediaStatus = 'hidden'
    return article
  }
  const media = evaluateMediaPolicy(source, article.leadMedia)
  if (!media.allowed) {
    article.leadMedia = null
    article.leadMediaStatus = 'hidden'
  }
  return article
}

function sourceOnlyFilter(filter) {
  return Object.fromEntries(Object.entries(filter).filter(([key]) => key.includes('.')))
}

async function sourceForArticle(sourceCollection, document) {
  if (typeof sourceCollection?.findOne !== 'function') return null
  return sourceCollection.findOne({ _id: document.sourceId })
}

export class MongoArticleRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  collection(name = 'articles') { return this.db.collection(name) }
  articles() { return this.collection('articles') }
  jobs() { return this.collection('ingestionJobs') }
  leases() { return this.collection('jobLeases') }
  sources() { return this.collection('sources') }

  withTransaction(work) {
    const session = this.client.startSession()
    return (async () => {
      try {
        let result
        await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
        return result
      } finally { await session.endSession() }
    })()
  }

  sanitizeCommitInput({ source, candidates = [], retrievedAt } = {}) {
    return { sourceId: source?.id ?? source?._id ?? source?.sourceId, policyVersion: source?.policyVersion, retrievedAt: retrievedAt instanceof Date ? retrievedAt : new Date(retrievedAt), candidates: candidates.map(safeCandidate) }
  }

  async upsertCandidate({ article, session } = {}) {
    const document = articleDocument(article)
    const filters = [{ canonicalUrlHash: document.canonicalUrlHash }]
    if (document.externalId) filters.unshift({ sourceId: document.sourceId, externalId: document.externalId })
    const existing = await this.articles().findOne({ $or: filters }, { session })
    if (!existing) {
      const possibleMatches = await this.articles().find({ status: { $ne: 'removed' } }, { session }).sort({ updatedAt: -1, _id: -1 }).limit(100).toArray()
      if (possibleMatches.some((possible) => assessDedupe(serializeArticle(possible), serializeArticle(document)).decision === 'review-needed')) document.status = 'review-needed'
      await this.articles().insertOne(document, { session })
      return { article: serializeArticle(document), created: 1, updated: 0, duplicate: 0 }
    }
    if (existing.status === 'removed') return { article: serializeArticle(existing), created: 0, updated: 0, duplicate: 1 }
    const merged = articleDocument(mergeArticleRecords(serializeArticle(existing), serializeArticle(document)), existing._id)
    const mergedFields = { ...merged }
    delete mergedFields._id
    const result = await this.articles().updateOne({ _id: existing._id }, { $set: mergedFields }, { session })
    if (result.matchedCount !== 1) throw articleConflict()
    return { article: serializeArticle(merged), created: 0, updated: 1, duplicate: 1 }
  }

  async commitIngestionBatch({ job, fence, source, expectedSourcePolicyVersion, expectedConnectorConfig, candidates = [], articles, checkpoint, counters, retrievedAt } = {}) {
    commitFence(fence, job)
    if (!jobIdentifier(job)) throw leaseFenceStale()
    if (!job?.connectorType || !sameIdentifier(source?.id ?? source?._id ?? source?.sourceId, job?.sourceId)) throw policyVersionMismatch()
    const expectedVersion = expectedSourcePolicyVersion ?? job?.expectedSourcePolicyVersion
    const expectedConfig = expectedConnectorConfig ?? job?.expectedConnectorConfig ?? source?.connectorConfig
    if (!Number.isInteger(expectedVersion) || !expectedConfig) throw policyVersionMismatch()
    const sanitized = this.sanitizeCommitInput({ source, candidates, retrievedAt })
    const runCommit = () => this.withTransaction(async (session) => {
      const now = dateValue(this.clock(), 'Authoritative article clock')
      const leaseFilter = { key: fence.key, 'activeOwner.jobId': idValue(jobIdentifier(job)), 'activeOwner.ownerTokenHash': fence.ownerTokenHash, 'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now } }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (touched.matchedCount !== 1) throw leaseFenceStale()
      const currentJob = await this.jobs().findOne({ _id: idValue(jobIdentifier(job)), status: 'running', leaseGeneration: fence.leaseGeneration }, { session })
      if (!currentJob) throw leaseFenceStale()
      const currentSource = await this.sources().findOne({ _id: idValue(source.id ?? source._id ?? source.sourceId), policyVersion: expectedVersion, operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] }, connectorType: job.connectorType, 'technicalCheck.status': 'passed' }, { session })
      if (!currentSource || stableJson(currentSource.connectorConfig) !== stableJson(expectedConfig)) throw policyVersionMismatch()
      const incomingCheckpoint = checkpoint ? safeCheckpoint(checkpoint) : undefined
      const currentCheckpoint = currentJob.checkpoint
      const sameMarker = incomingCheckpoint && currentCheckpoint && (incomingCheckpoint.lastExternalId !== undefined || incomingCheckpoint.cursor !== undefined) && incomingCheckpoint.lastExternalId === currentCheckpoint.lastExternalId && incomingCheckpoint.cursor === currentCheckpoint.cursor
      const markerlessReplay = incomingCheckpoint && currentCheckpoint && !incomingCheckpoint.lastExternalId && !incomingCheckpoint.cursor && incomingCheckpoint.processedCount <= (currentCheckpoint.processedCount ?? 0)
      const replayedBatch = Boolean(sameMarker || markerlessReplay)
      if (incomingCheckpoint && currentCheckpoint && incomingCheckpoint.processedCount <= (currentCheckpoint.processedCount ?? 0) && !replayedBatch) throw leaseFenceStale()
      const result = { created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0, fetched: replayedBatch ? 0 : sanitized.candidates.length, candidates: [] }
      const normalizedArticles = replayedBatch ? [] : Array.isArray(articles) ? articles : sanitized.candidates.map((candidate) => normalizeCandidateToArticle(candidate, { source: { ...source, id: currentSource._id?.toHexString?.() ?? String(currentSource._id ?? source.id ?? source.sourceId), policyVersion: currentSource.policyVersion }, now }))
      for (const article of normalizedArticles) {
        try {
          assertArticleMatchesCurrent(article, currentSource)
          const saved = await this.upsertCandidate({ article, session })
          result.created += saved.created
          result.updated += saved.updated
          result.duplicate += saved.duplicate
          result.candidates.push(saved.article)
        } catch (error) {
          if (error instanceof ArticleError && error.code === 'candidate_invalid') result.skipped += 1
          else throw error
        }
      }
      const nextCheckpoint = replayedBatch ? currentJob.checkpoint : incomingCheckpoint ?? currentJob.checkpoint
      const nextCounters = replayedBatch ? safeCounters(currentJob.counters) : addCounters(currentJob.counters, counterDelta(result, counters))
      if (replayedBatch) return Object.freeze({ ...result, counters: nextCounters, checkpoint: nextCheckpoint, articles: Object.freeze(result.candidates) })
      const jobUpdate = { $set: { counters: nextCounters, updatedAt: now, ...(nextCheckpoint ? { checkpoint: nextCheckpoint } : {}) } }
      const advanced = await this.jobs().updateOne({ _id: currentJob._id, status: 'running', leaseGeneration: fence.leaseGeneration }, jobUpdate, { session })
      if (advanced.matchedCount !== 1) throw leaseFenceStale()
      return Object.freeze({ ...result, counters: nextCounters, checkpoint: nextCheckpoint, articles: Object.freeze(result.candidates) })
    })
    try {
      return await runCommit()
    } catch (error) {
      if (error?.code !== 11000) throw error
      return runCommit()
    }
  }

  commitCandidates(input) { return this.commitIngestionBatch(input) }

  async hideArticle({ articleId, reason = 'article_hidden', now = this.clock() } = {}) {
    const existing = await this.articles().findOne({ _id: idValue(articleId) })
    if (!existing) return null
    const next = articleDocument({ ...hideArticleRecord(serializeArticle(existing), reason), updatedAt: now }, existing._id)
    const result = await this.articles().replaceOne({ _id: existing._id, status: existing.status }, next)
    if (result.matchedCount !== 1) throw articleConflict()
    return serializeArticle(next)
  }

  async restoreArticle({ articleId, now = this.clock() } = {}) {
    const existing = await this.articles().findOne({ _id: idValue(articleId) })
    if (!existing) return null
    const sourceCollection = this.sources()
    const currentSource = typeof sourceCollection?.findOne === 'function' ? await sourceCollection.findOne({ _id: existing.sourceId }) : null
    const next = articleDocument(restoreArticleRecord(serializeArticle(existing), { source: currentSource, now }), existing._id)
    const result = await this.articles().replaceOne({ _id: existing._id, status: existing.status }, next)
    if (result.matchedCount !== 1) throw articleConflict()
    return serializeArticle(next)
  }

  async removeArticle({ articleId, now = this.clock() } = {}) {
    const existing = await this.articles().findOne({ _id: idValue(articleId) })
    if (!existing) return null
    const next = articleDocument(removeArticleRecord(serializeArticle(existing), { now }), existing._id)
    const result = await this.articles().replaceOne({ _id: existing._id, status: existing.status }, next)
    if (result.matchedCount !== 1) throw articleConflict()
    return serializeArticle(next)
  }

  async mergeArticles({ canonicalId, duplicateId, now = this.clock() } = {}) {
    return this.withTransaction(async (session) => {
      const canonicalDocument = await this.articles().findOne({ _id: idValue(canonicalId) }, { session })
      const duplicateDocument = await this.articles().findOne({ _id: idValue(duplicateId) }, { session })
      if (!canonicalDocument || !duplicateDocument || canonicalDocument._id.equals(duplicateDocument._id)) throw articleConflict()
      const merged = articleDocument(mergeArticleRecords(serializeArticle(canonicalDocument), serializeArticle(duplicateDocument)), canonicalDocument._id)
      const duplicate = articleDocument({ ...serializeArticle(duplicateDocument), status: 'hidden', duplicateOfId: canonicalDocument._id.toHexString(), leadMedia: null, leadMediaStatus: 'none', updatedAt: now }, duplicateDocument._id)
      await this.articles().replaceOne({ _id: canonicalDocument._id }, merged, { session })
      await this.articles().replaceOne({ _id: duplicateDocument._id }, duplicate, { session })
      return { canonical: serializeArticle(merged), duplicate: serializeArticle(duplicate) }
    })
  }

  async findVisibleArticles({ sourceId, limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleError('article_query_invalid', 'Article limit is invalid', { status: 400 })
    const filter = { status: 'published', ...(sourceId ? { sourceId: idValue(sourceId) } : {}) }
    const collection = this.articles()
    if (typeof collection.aggregate !== 'function') {
      const documents = await collection.find(filter).sort({ publishedAt: -1, _id: -1 }).limit(limit).toArray()
      const visible = []
      for (const document of documents) {
        const source = await sourceForArticle(this.sources(), document)
        if (isSourceProductionEligible(source)) visible.push(serializeVisibleArticle(document, source))
      }
      return visible
    }
    const sourceFilter = currentArticleVisibilityFilter({ sourcePath: '_currentSource' })
    const documents = await collection.aggregate([
      { $match: filter },
      { $lookup: { from: 'sources', localField: 'sourceId', foreignField: '_id', as: '_currentSource' } },
      { $unwind: '$_currentSource' },
      { $match: sourceFilter },
      { $sort: { publishedAt: -1, _id: -1 } },
      { $limit: limit },
    ]).toArray()
    return documents.flatMap(({ _currentSource: source, ...document }) => isSourceProductionEligible(source) ? [serializeVisibleArticle(document, source)] : [])
  }

  async findQnaEvidence({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleError('article_query_invalid', 'Article limit is invalid', { status: 400 })
    const collection = this.articles()
    const qnaFilter = qnaEvidenceFilter({ sourcePath: '_currentSource' })
    if (typeof collection.aggregate !== 'function') {
      const documents = await collection.find({ status: qnaFilter.status, authorityTier: qnaFilter.authorityTier, evidenceEligible: qnaFilter.evidenceEligible }).sort({ publishedAt: -1, _id: -1 }).limit(limit).toArray()
      const evidence = []
      for (const document of documents) {
        const source = await sourceForArticle(this.sources(), document)
        if (canUseQnaEvidence(document, source)) evidence.push(serializeVisibleArticle(document, source))
      }
      return evidence
    }
    const articles = await collection.aggregate([
      { $match: { status: qnaFilter.status, authorityTier: qnaFilter.authorityTier, evidenceEligible: qnaFilter.evidenceEligible } },
      { $lookup: { from: 'sources', localField: 'sourceId', foreignField: '_id', as: '_currentSource' } },
      { $unwind: '$_currentSource' },
      { $match: sourceOnlyFilter(qnaFilter) },
      { $sort: { publishedAt: -1, _id: -1 } },
      { $limit: limit },
    ]).toArray()
    return articles.flatMap(({ _currentSource: source, ...document }) => canUseQnaEvidence(document, source) ? [serializeVisibleArticle(document, source)] : [])
  }
}

export { articleDocument, assertArticleMatchesCurrent, commitFence, safeCandidate }
