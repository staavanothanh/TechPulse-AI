import { ObjectId } from 'mongodb'
import { createHash } from 'node:crypto'
import { assertCanonicalLeaseKey } from '../../domain/jobs/lease-keys.js'
import { assessDedupe, mergeArticleRecords } from '../../domain/article/dedupe.js'
import { ArticleError, articleConflict, leaseFenceStale, policyVersionMismatch, sourcePolicyBlocked } from '../../domain/article/errors.js'
import { hideArticle as hideArticleRecord, removeArticle as removeArticleRecord, restoreArticle as restoreArticleRecord } from '../../domain/article/lifecycle.js'
import { normalizeCandidateToArticle } from '../../domain/article/normalization.js'
import { classifyTopics } from '../../domain/article/topic-classifier.js'
import { evaluateMediaPolicy } from '../../domain/policy/media-policy.js'
import { evaluateContentPolicy } from '../../domain/policy/content-policy.js'
import { canUseQnaEvidence, currentArticleVisibilityFilter, isSourceProductionEligible, qnaEvidenceFilter } from '../../domain/article/visibility.js'
import { validateArticleDocument } from '../../../scripts/migrations/articles.js'
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_VERSION, validateEmbeddingVector } from '../../ai/embedding.js'
import { validateVietnameseSummary } from '../../ai/summary.js'
import { cosineSimilarity, rankQnaEvidence } from '../../ai/retrieval.js'
import { buildPolicyDerivedInput } from '../../ai/policy-input.js'
import { buildIngestionArtifactJobs, indexingJobDocument } from './indexing-job-repository.js'
import { buildRemovedArticleTombstone, serializeRemovedArticleTombstone, validateRemovedArticleTombstone } from '../../domain/article/removed-tombstone.js'

const COUNTER_KEYS = Object.freeze(['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed'])
const FORBIDDEN_FIELDS = Object.freeze(['raw', 'rawHtml', 'html', 'body', 'content', 'fullText', 'translatedFullText', 'mediaBinary', 'binary', 'imageBinary', 'videoBinary', 'audioBinary', 'base64', 'gridFsId', 'providerPayload', 'qnaFenceToken'])
const MAX_ARTICLE_PAGE_OFFSET = 100_000

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

function nextDate(value, previous, label = 'Article date') {
  const candidate = dateValue(value, label)
  const baseline = dateValue(previous, label)
  return candidate.getTime() > baseline.getTime() ? candidate : new Date(baseline.getTime() + 1)
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
  if (article?.status === 'removed') {
    const tombstone = buildRemovedArticleTombstone(article, { id, now: article.updatedAt })
    const validation = validateRemovedArticleTombstone(tombstone)
    if (!validation.valid) throw new ArticleError('article_invalid', 'Removed article tombstone is invalid', { status: 422, details: validation.errors })
    return tombstone
  }
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
  if (document.status === 'removed') return serializeRemovedArticleTombstone(document)
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

function mediaBackfillLimit(value) {
  const limit = value === undefined ? 100 : Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleError('article_query_invalid', 'Media backfill limit is invalid', { status: 400 })
  return limit
}

function mediaBackfillCounters() {
  return { inspected: 0, updated: 0, wouldUpdate: 0, skipped: 0, failed: 0, skippedReasons: {}, failedReasons: {} }
}

function recordMediaBackfillReason(report, category, reason) {
  report[category] += 1
  const key = typeof reason === 'string' && /^[a-z0-9_:-]{1,128}$/.test(reason) ? reason : category === 'failed' ? 'media_backfill_failed' : 'media_backfill_skipped'
  const target = category === 'failed' ? report.failedReasons : report.skippedReasons
  target[key] = (target[key] ?? 0) + 1
}

function mediaBackfillPolicyEnabled(source) {
  const policy = source?.mediaPolicy
  return Boolean(policy && Array.isArray(policy.allowedHosts) && policy.allowedHosts.length > 0 && (policy.imageMode === 'remote-preview' || policy.videoMode === 'link-only'))
}

function mediaBackfillSourceMatches(source, expectedSourcePolicyVersion, expectedConnectorConfig) {
  return source?.operationalStatus === 'active'
    && ['permitted', 'metadata-only'].includes(source.licenseStatus)
    && source.technicalCheck?.status === 'passed'
    && source.connectorType === 'rss'
    && source.policyVersion === expectedSourcePolicyVersion
    && stableJson(source.connectorConfig) === stableJson(expectedConnectorConfig)
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

function serializeSourceForQna(source) {
  if (!source) return null
  return {
    id: source._id?.toHexString?.() ?? String(source.id ?? source.sourceId),
    sourceKey: typeof source.sourceKey === 'string' ? source.sourceKey : undefined,
    name: typeof source.name === 'string' ? source.name : '',
    authorityTier: source.authorityTier,
    operationalStatus: source.operationalStatus,
    licenseStatus: source.licenseStatus,
    policyVersion: source.policyVersion,
    llmInputScope: source.llmInputScope,
    storageScope: source.storageScope ? { ...source.storageScope } : undefined,
    mediaPolicy: source.mediaPolicy ? { ...source.mediaPolicy, allowedHosts: [...(source.mediaPolicy.allowedHosts ?? [])] } : undefined,
    technicalCheck: { status: source.technicalCheck?.status },
  }
}

const PUBLIC_SUMMARY_STATUSES = new Set(['pending', 'processing', 'ready', 'failed'])
const SUMMARY_BASES = new Set(['metadata', 'excerpt', 'fulltext-temporary', 'official-payload'])
const EMBEDDING_COMPATIBILITY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function embeddingTargetValue(value = {}) {
  const dimensions = value.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  const version = value.version ?? DEFAULT_EMBEDDING_VERSION
  if (!Number.isInteger(dimensions) || dimensions < 1 || !Number.isInteger(version) || version < 1) throw new Error('Embedding target is invalid')
  return Object.freeze({
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    dimensions,
    version,
    ...(typeof value.artifactCompatibilityId === 'string' && value.artifactCompatibilityId ? { artifactCompatibilityId: value.artifactCompatibilityId } : {}),
  })
}

function embeddingQueryCompatible(value, { expectedCompatibilityId } = {}) {
  if (!value || typeof value.model !== 'string' || !value.model || !Number.isInteger(value.dimensions) || value.dimensions < 1 || !Number.isInteger(value.version) || value.version < 1 || !Array.isArray(value.embedding) || value.embedding.length !== value.dimensions || value.embedding.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return false
  if (value.artifactCompatibilityId !== undefined && (typeof value.artifactCompatibilityId !== 'string' || !EMBEDDING_COMPATIBILITY_ID.test(value.artifactCompatibilityId))) return false
  if (expectedCompatibilityId && value.artifactCompatibilityId !== expectedCompatibilityId) return false
  return true
}

function embeddingArtifactCompatible(document, query) {
  return document?.embeddingStatus === 'ready'
    && document.embeddingModel === query.model
    && document.embeddingDimensions === query.dimensions
    && document.embeddingVersion === query.version
    && (document.embeddingArtifactCompatibilityId === query.artifactCompatibilityId || document.embeddingArtifactCompatibilityId === undefined && query.artifactCompatibilityId === undefined)
    && Array.isArray(document.embedding)
    && document.embedding.length === query.embedding.length
    && document.embedding.every((item) => typeof item === 'number' && Number.isFinite(item))
}

function contentQueryInvalid(message = 'Content cursor is invalid') {
  return new ArticleError('validation_error', message, { status: 422 })
}

function contentFenceStale() {
  return new ArticleError('conflict', 'Saved article state changed', { status: 409 })
}

function contentObjectId(value, { nullable = false } = {}) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  if (nullable) return null
  throw contentQueryInvalid('Content identifier is invalid')
}

function normalizedSearchText(value) {
  return String(value ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').replaceAll(/đ/gi, (letter) => letter === 'Đ' ? 'D' : 'd').toLocaleLowerCase('vi').trim().replaceAll(/\s+/g, ' ')
}

function publicDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw contentQueryInvalid('Stored article date is invalid')
  return date.toISOString()
}

function canonicalPublicHttps(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function publicLeadMedia(media) {
  if (!media || !['image', 'video'].includes(media.type) || typeof media.attribution !== 'string' || media.attribution.length < 1) return null
  if (media.type === 'image' && media.displayMode !== 'remote-preview') return null
  if (media.type === 'video' && media.displayMode !== 'link-only') return null
  const url = canonicalPublicHttps(media.url)
  const sourcePageUrl = canonicalPublicHttps(media.sourcePageUrl)
  if (!url || !sourcePageUrl) return null
  return {
    type: media.type,
    displayMode: media.displayMode,
    url,
    sourcePageUrl,
    altText: typeof media.altText === 'string' ? media.altText : null,
    credit: typeof media.credit === 'string' ? media.credit : null,
    attribution: media.attribution,
    mediaEvidenceStatus: 'not-analyzed',
  }
}

function summaryFields(article) {
  const ready = article.summaryStatus === 'ready' && typeof article.summaryVi === 'string' && article.summaryVi.length > 0 && SUMMARY_BASES.has(article.summaryBasis)
  const status = ready ? 'ready' : PUBLIC_SUMMARY_STATUSES.has(article.summaryStatus) && article.summaryStatus !== 'ready' ? article.summaryStatus : 'failed'
  return { summaryStatus: status, summaryVi: ready ? article.summaryVi : null, summaryBasis: ready ? article.summaryBasis : null }
}

function summaryDetailFields(article) {
  if (article?.summaryDetailStatus === 'ready' && article.summaryStatus === 'ready') {
    try {
      const output = validateVietnameseSummary({
        titleVi: article.titleVi,
        summaryVi: article.summaryVi,
        summaryParagraphsVi: article.summaryParagraphsVi,
      })
      return { summaryDetailStatus: 'ready', summaryParagraphsVi: [...output.summaryParagraphsVi] }
    } catch { /* fail closed below */ }
  }
  const status = PUBLIC_SUMMARY_STATUSES.has(article?.summaryDetailStatus) && article.summaryDetailStatus !== 'ready'
    ? article.summaryDetailStatus
    : article?.summaryDetailStatus === undefined ? 'pending' : 'failed'
  return { summaryDetailStatus: status, summaryParagraphsVi: null }
}

function savedMarker(document) {
  return Boolean(document?._isSaved?.length || document?._saved === true)
}

function publicArticleCard(document, source = document?._currentSource) {
  const article = serializeVisibleArticle(document, source)
  if (!article || !source || typeof article.titleOriginal !== 'string' || article.titleOriginal.length < 1) return null
  return {
    id: article.id,
    titleOriginal: article.titleOriginal,
    titleVi: typeof article.titleVi === 'string' ? article.titleVi : null,
    source: {
      id: source._id?.toHexString?.() ?? String(source.id ?? article.sourceId),
      name: String(source.name ?? ''),
      authorityTier: source.authorityTier,
    },
    publishedAt: publicDate(article.publishedAt),
    sourceLanguage: String(article.sourceLanguage),
    topics: classifyTopics({
      values: article.topics,
      titleOriginal: article.titleOriginal,
      excerptOriginal: article.excerptOriginal,
    }),
    ...summaryFields(article),
    leadMedia: publicLeadMedia(article.leadMedia),
    isSaved: savedMarker(document),
  }
}

function publicArticleDetail(document, source = document?._currentSource) {
  const card = publicArticleCard(document, source)
  const originalUrl = canonicalPublicHttps(document?.originalUrl)
  if (!card || !originalUrl) return null
  const author = typeof document.author === 'string' ? document.author : null
  return {
    ...card,
    ...summaryDetailFields(document),
    originalUrl,
    author,
    retrievedAt: publicDate(document.retrievedAt),
    citation: {
      sourceId: card.source.id,
      sourceName: card.source.name,
      titleOriginal: card.titleOriginal,
      originalUrl,
      author,
      publishedAt: card.publishedAt,
      sourceLanguage: card.sourceLanguage,
    },
    aiDisclosure: 'AI tổng hợp; hãy kiểm chứng với nguồn gốc.',
  }
}

function cursorFingerprint(kind, input) {
  return createHash('sha256').update(stableJson({ kind, ...input })).digest('hex')
}

function encodeContentCursor(kind, fingerprint, position) {
  return Buffer.from(JSON.stringify({ v: 1, kind, fingerprint, position }), 'utf8').toString('base64url')
}

function decodeContentCursor(value, kind, fingerprint) {
  if (!value) return null
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (cursor?.v !== 1 || cursor.kind !== kind || cursor.fingerprint !== fingerprint || !cursor.position || typeof cursor.position !== 'object') throw contentQueryInvalid()
    return cursor.position
  } catch (error) {
    if (error instanceof ArticleError) throw error
    throw contentQueryInvalid()
  }
}

function contentBaseFilter({ topic, sourceId, publishedAfter, publishedBefore, cursorPosition } = {}) {
  const filters = [{ status: 'published' }]
  if (topic) filters.push({ topics: topic })
  if (sourceId) filters.push({ sourceId: contentObjectId(sourceId) })
  if (publishedAfter || publishedBefore) filters.push({ publishedAt: { ...(publishedAfter ? { $gte: publishedAfter } : {}), ...(publishedBefore ? { $lte: publishedBefore } : {}) } })
  if (cursorPosition) {
    const publishedAt = new Date(cursorPosition.publishedAt)
    const id = contentObjectId(cursorPosition.id)
    if (Number.isNaN(publishedAt.getTime())) throw contentQueryInvalid()
    filters.push({ $or: [{ publishedAt: { $lt: publishedAt } }, { publishedAt, _id: { $lt: id } }] })
  }
  return filters.length === 1 ? filters[0] : { $and: filters }
}

function qnaScopeFilter(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw contentQueryInvalid('Q&A scope is invalid')
  const match = {}
  if (scope.articleId !== undefined && scope.articleId !== null) match._id = contentObjectId(scope.articleId)
  if (scope.topics !== undefined) {
    if (!Array.isArray(scope.topics) || scope.topics.length < 1 || scope.topics.length > 10 || scope.topics.some((topic) => typeof topic !== 'string' || topic.length < 1 || topic.length > 100)) throw contentQueryInvalid('Q&A topics are invalid')
    match.topics = { $in: scope.topics }
  }
  const publishedAfter = scope.publishedAfter === undefined ? null : dateValue(scope.publishedAfter, 'Q&A publishedAfter')
  const publishedBefore = scope.publishedBefore === undefined ? null : dateValue(scope.publishedBefore, 'Q&A publishedBefore')
  if (Boolean(publishedAfter) !== Boolean(publishedBefore) || publishedAfter && publishedBefore && publishedAfter > publishedBefore) throw contentQueryInvalid('Q&A date range is invalid')
  if (publishedAfter) match.publishedAt = { $gte: publishedAfter, $lte: publishedBefore }
  return match
}

const PUBLIC_ARTICLE_CARD_PROJECTION = Object.freeze({
  _id: 1,
  sourceId: 1,
  status: 1,
  titleOriginal: 1,
  titleVi: 1,
  publishedAt: 1,
  sourceLanguage: 1,
  topics: 1,
  excerptOriginal: 1,
  summaryVi: 1,
  summaryStatus: 1,
  summaryBasis: 1,
  leadMedia: 1,
  leadMediaStatus: 1,
  _isSaved: 1,
  '_currentSource._id': 1,
  '_currentSource.name': 1,
  '_currentSource.authorityTier': 1,
  '_currentSource.operationalStatus': 1,
  '_currentSource.licenseStatus': 1,
  '_currentSource.llmInputScope': 1,
  '_currentSource.storageScope': 1,
  '_currentSource.mediaPolicy': 1,
  '_currentSource.attributionRequired': 1,
  '_currentSource.attributionText': 1,
  '_currentSource.policyVersion': 1,
})

function visibilityBasePipeline({ match } = {}) {
  return [
    { $match: match },
    { $lookup: { from: 'sources', localField: 'sourceId', foreignField: '_id', as: '_currentSource' } },
    { $unwind: '$_currentSource' },
    { $match: currentArticleVisibilityFilter({ sourcePath: '_currentSource' }) },
  ]
}

function savedArticleLookupStage(userId) {
  return userId ? { $lookup: { from: 'savedArticles', let: { articleId: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$articleId', '$$articleId'] }, { $eq: ['$userId', contentObjectId(userId)] }] } } }, { $limit: 1 }], as: '_isSaved' } } : null
}

function visibilityPipeline({ match, userId, limit, skip = 0, projection, sort = true } = {}) {
  const savedLookup = savedArticleLookupStage(userId)
  return [
    ...visibilityBasePipeline({ match }),
    ...(projection ? [{ $project: projection }] : []),
    ...(sort ? [{ $sort: { publishedAt: -1, _id: -1 } }] : []),
    ...(skip > 0 ? [{ $skip: skip }] : []),
    ...(limit ? [{ $limit: limit }] : []),
    ...(savedLookup ? [savedLookup] : []),
  ]
}

export class MongoArticleRepository {
  constructor(context, { embeddingTarget } = {}) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
    this.embeddingTarget = embeddingTargetValue(embeddingTarget)
  }

  collection(name = 'articles') { return this.db.collection(name) }
  articles() { return this.collection('articles') }
  jobs() { return this.collection('ingestionJobs') }
  indexingJobs() { return this.collection('indexingJobs') }
  leases() { return this.collection('jobLeases') }
  sources() { return this.collection('sources') }
  savedArticles() { return this.collection('savedArticles') }
  users() { return this.collection('users') }
  sessions() { return this.collection('sessions') }

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

  async backfillLeadMediaCandidates({ source, expectedSourcePolicyVersion, expectedConnectorConfig, candidates = [], dryRun = false, limit } = {}) {
    const sourceId = idValue(source?.id ?? source?._id ?? source?.sourceId)
    const boundedLimit = mediaBackfillLimit(limit)
    if (!Number.isInteger(expectedSourcePolicyVersion) || !expectedConnectorConfig) throw policyVersionMismatch()
    if (!Array.isArray(candidates)) throw new ArticleError('candidate_invalid', 'Media backfill candidates are invalid', { status: 422 })
    const input = candidates.slice(0, boundedLimit).map(safeCandidate)
    return this.withTransaction(async (session) => {
      const report = mediaBackfillCounters()
      const currentSource = await this.sources().findOne({
        _id: sourceId,
        policyVersion: expectedSourcePolicyVersion,
        operationalStatus: 'active',
        licenseStatus: { $in: ['permitted', 'metadata-only'] },
        connectorType: 'rss',
        'technicalCheck.status': 'passed',
      }, { session })
      if (!mediaBackfillSourceMatches(currentSource, expectedSourcePolicyVersion, expectedConnectorConfig)) {
        recordMediaBackfillReason(report, 'skipped', 'source_policy_changed')
        return Object.freeze(report)
      }
      if (!mediaBackfillPolicyEnabled(currentSource)) {
        recordMediaBackfillReason(report, 'skipped', 'media_policy_disabled')
        return Object.freeze(report)
      }
      if (input.length === 0) return Object.freeze(report)
      const eligible = []
      for (const candidate of input) {
        let normalized
        try {
          normalized = normalizeCandidateToArticle(candidate, {
            source: { ...currentSource, id: currentSource._id.toHexString(), policyVersion: currentSource.policyVersion },
            now: dateValue(this.clock(), 'Media backfill clock'),
          })
        } catch (error) {
          recordMediaBackfillReason(report, 'skipped', error?.code === 'source_policy_blocked' ? 'source_policy_changed' : 'candidate_invalid')
          continue
        }
        if (normalized.leadMediaStatus !== 'available' || !normalized.leadMedia) {
          const policy = evaluateMediaPolicy(
            currentSource,
            candidate?.mediaCandidate
              ? { ...candidate.mediaCandidate, sourcePageUrl: candidate.mediaCandidate.sourcePageUrl ?? candidate.originalUrl }
              : null,
          )
          recordMediaBackfillReason(report, 'skipped', policy?.code ?? 'media_unavailable')
          continue
        }
        eligible.push({ normalized })
      }
      if (eligible.length === 0) return Object.freeze(report)
      if (!dryRun) {
        const sourceFence = await this.sources().updateOne(
          {
            _id: sourceId,
            policyVersion: expectedSourcePolicyVersion,
            updatedAt: currentSource.updatedAt,
            operationalStatus: 'active',
            licenseStatus: { $in: ['permitted', 'metadata-only'] },
            connectorType: 'rss',
            'technicalCheck.status': 'passed',
            connectorConfig: currentSource.connectorConfig,
          },
          { $set: { updatedAt: nextDate(this.clock(), currentSource.updatedAt, 'Media backfill clock') } },
          { session },
        )
        if (sourceFence.matchedCount !== 1) {
          recordMediaBackfillReason(report, 'skipped', 'source_policy_changed')
          return Object.freeze(report)
        }
      }
      for (const { normalized } of eligible) {
        report.inspected += 1
        let existing
        if (normalized.externalId) {
          existing = await this.articles().findOne({ sourceId, externalId: normalized.externalId }, { session })
        } else {
          const matches = await this.articles().find({ sourceId, canonicalUrlHash: normalized.canonicalUrlHash }, { session }).limit(2).toArray()
          existing = matches.length === 1 ? matches[0] : null
        }
        if (!existing || !sameIdentifier(existing.sourceId, sourceId) || existing.canonicalUrlHash !== normalized.canonicalUrlHash || existing.duplicateOfId !== undefined || existing.status !== 'published' || existing.leadMedia !== null || existing.leadMediaStatus !== 'none') {
          recordMediaBackfillReason(report, 'skipped', 'no_matching_article')
          continue
        }
        if (dryRun) {
          report.wouldUpdate += 1
          continue
        }
        const update = await this.articles().updateOne(
          {
            _id: existing._id,
            sourceId,
            canonicalUrlHash: normalized.canonicalUrlHash,
            duplicateOfId: { $exists: false },
            status: 'published',
            leadMedia: null,
            leadMediaStatus: 'none',
            updatedAt: existing.updatedAt,
          },
          {
            $set: {
              leadMedia: normalized.leadMedia,
              leadMediaStatus: 'available',
              updatedAt: nextDate(this.clock(), existing.updatedAt, 'Media backfill clock'),
            },
            $unset: { leadMediaHiddenReason: '' },
          },
          { session },
        )
        if (update.matchedCount === 1) report.updated += 1
        else recordMediaBackfillReason(report, 'skipped', 'article_changed')
      }
      return Object.freeze(report)
    })
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
          for (const indexingJob of buildIngestionArtifactJobs({ source: { ...currentSource, id: currentSource._id.toHexString() }, article: saved.article, now, embeddingTarget: this.embeddingTarget })) {
            await this.indexingJobs().updateOne(
              { actorScope: indexingJob.actorScope, idempotencyKey: indexingJob.idempotencyKey },
              { $setOnInsert: indexingJobDocument(indexingJob) },
              { upsert: true, session },
            )
          }
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

  async listVisibleArticles({ userId, topic, sourceId, publishedAfter, publishedBefore, cursor, page = 1, limit = 20, lastPage = false } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw contentQueryInvalid('Article limit is invalid')
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw contentQueryInvalid('Article page is invalid')
    const pageOffset = (page - 1) * limit
    if (!lastPage && pageOffset > MAX_ARTICLE_PAGE_OFFSET) throw contentQueryInvalid('Article page is too deep')
    const fingerprint = cursorFingerprint('articles', { userId, topic, sourceId, publishedAfter: publishedAfter?.toISOString?.(), publishedBefore: publishedBefore?.toISOString?.(), limit })
    const cursorPosition = decodeContentCursor(cursor, 'articles', fingerprint)
    if (lastPage && cursorPosition) throw contentQueryInvalid('lastPage and cursor cannot be used together')
    const match = contentBaseFilter({ topic, sourceId, publishedAfter, publishedBefore, cursorPosition })
    const totalMatch = contentBaseFilter({ topic, sourceId, publishedAfter, publishedBefore })
    const collection = this.articles()
    const savedLookup = savedArticleLookupStage(userId)
    const pagePipeline = (skip = 0) => [
      ...(cursorPosition ? [{ $match: match }] : []),
      { $project: PUBLIC_ARTICLE_CARD_PROJECTION },
      { $sort: { publishedAt: -1, _id: -1 } },
      ...(skip > 0 ? [{ $skip: skip }] : []),
      { $limit: limit + 1 },
      ...(savedLookup ? [savedLookup] : []),
    ]
    const lastPagePipeline = [
      { $project: PUBLIC_ARTICLE_CARD_PROJECTION },
      { $sort: { publishedAt: 1, _id: 1 } },
      { $limit: limit },
      ...(savedLookup ? [savedLookup] : []),
    ]
    const aggregateRows = await collection.aggregate([
      ...visibilityBasePipeline({ match: totalMatch }),
      {
        $facet: {
          page: lastPage ? lastPagePipeline : pagePipeline(cursorPosition ? 0 : pageOffset),
          total: [{ $count: 'totalItems' }],
        },
      },
    ]).toArray()
    const facet = aggregateRows[0]
    let documents = Array.isArray(facet?.page) ? facet.page : aggregateRows
    const totalRows = Array.isArray(facet?.total) ? facet.total[0]?.totalItems ?? 0 : 0
    if (lastPage) {
      const lastPageSize = totalRows === 0 ? 0 : totalRows % limit || limit
      documents = documents.slice(0, lastPageSize).toReversed()
    }
    const cards = documents.map((document) => publicArticleCard(document)).filter(Boolean)
    const hasNext = !lastPage && cards.length > limit
    const pageItems = cards.slice(0, limit)
    const lastDocument = documents[Math.min(pageItems.length, limit) - 1]
    return {
      articles: pageItems,
      hasNext,
      nextCursor: hasNext && lastDocument ? encodeContentCursor('articles', fingerprint, { publishedAt: publicDate(lastDocument.publishedAt), id: lastDocument._id.toHexString() }) : null,
      totalItems: totalRows,
    }
  }

  async findVisibleArticleDocument({ userId, articleId, session } = {}) {
    const id = contentObjectId(articleId, { nullable: true })
    if (!id) return null
    const documents = await this.articles().aggregate(visibilityPipeline({ match: { status: 'published', _id: id }, userId, limit: 1 }), session ? { session } : {}).toArray()
    return documents[0] ?? null
  }

  async getVisibleArticle({ userId, articleId, session } = {}) {
    const document = await this.findVisibleArticleDocument({ userId, articleId, session })
    return document ? publicArticleDetail(document) : null
  }

  async findArticleForIndexing(articleId, options = {}) {
    const id = contentObjectId(articleId, { nullable: true })
    if (!id) return null
    return serializeArticle(await this.articles().findOne({ _id: id, status: { $ne: 'removed' } }, options))
  }

  async commitArtifact({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, fields, unsetFields = [], onCommitted, cancellationRequested = false } = {}) {
    const articleId = contentObjectId(job?.articleId, { nullable: true })
    const sourceId = contentObjectId(job?.sourceId, { nullable: true })
    const jobId = contentObjectId(job?.id, { nullable: true })
    if (!articleId || !sourceId || !jobId || !Number.isInteger(expectedSourcePolicyVersion)) return false
    try {
      assertCanonicalLeaseKey(fence?.key)
      if (fence.key !== `indexing:article:${articleId.toHexString()}` || typeof fence.ownerTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(fence.ownerTokenHash) || !Number.isInteger(fence.leaseGeneration) || fence.leaseGeneration < 1) return false
    } catch { return false }
    return this.withTransaction(async (session) => {
      const now = dateValue(this.clock(), 'Artifact commit clock')
      const leaseFilter = {
        key: fence.key, 'activeOwner.jobId': jobId, 'activeOwner.ownerTokenHash': fence.ownerTokenHash,
        'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now },
      }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (touched.matchedCount !== 1) return false
      const currentJob = await this.indexingJobs().findOne({
        _id: jobId, articleId, sourceId, expectedSourcePolicyVersion, task: purpose, status: 'running', leaseGeneration: fence.leaseGeneration,
        cancellationRequestedAt: { $exists: cancellationRequested },
      }, { session })
      if (!currentJob) return false
      const source = await this.sources().findOne({
        _id: sourceId, policyVersion: expectedSourcePolicyVersion, operationalStatus: 'active',
        licenseStatus: { $in: ['permitted', 'metadata-only'] }, 'technicalCheck.status': 'passed',
        [`storageScope.${purpose}`]: true, llmInputScope: { $ne: 'none' },
      }, { session })
      if (!source) return false
      const currentArticle = await this.articles().findOne({ _id: articleId, sourceId, status: 'published' }, { session })
      if (!currentArticle) return false
      try {
        const currentInput = buildPolicyDerivedInput({ article: serializeArticle(currentArticle), source: { ...source, id: source._id.toHexString() }, purpose })
        if (currentInput.inputHash !== inputHash) return false
      } catch { return false }
      const filter = { _id: articleId, sourceId, status: 'published', ...(currentArticle.updatedAt ? { updatedAt: currentArticle.updatedAt } : {}) }
      const update = { $set: { ...fields, updatedAt: now }, ...(unsetFields.length > 0 ? { $unset: Object.fromEntries(unsetFields.map((field) => [field, ''])) } : {}) }
      const updated = await this.articles().updateOne(filter, update, { session })
      if (updated.matchedCount !== 1) return false
      const committedDocument = Object.fromEntries(Object.entries({ ...currentArticle, ...fields, updatedAt: now }).filter(([field]) => !unsetFields.includes(field)))
      await onCommitted?.({ session, source, article: serializeArticle(committedDocument), now })
      return true
    })
  }

  async commitSummaryArtifact({ job, fence, expectedSourcePolicyVersion, inputHash, summary } = {}) {
    let output
    try { output = validateVietnameseSummary({ titleVi: summary?.titleVi, summaryVi: summary?.summaryVi, summaryParagraphsVi: summary?.summaryParagraphsVi }) } catch { return false }
    if (summary?.summaryStatus !== 'ready' || summary?.summaryDetailStatus !== 'ready' || !SUMMARY_BASES.has(summary.summaryBasis) || summary.summaryInputHash !== inputHash || summary.summarySourcePolicyVersion !== expectedSourcePolicyVersion || typeof summary.summaryModel !== 'string' || !summary.summaryModel || !(summary.summaryGeneratedAt instanceof Date)) return false
    return this.commitArtifact({
      job, fence, expectedSourcePolicyVersion, purpose: 'summary',
      inputHash,
      fields: { ...output, summaryStatus: 'ready', summaryDetailStatus: 'ready', summaryBasis: summary.summaryBasis, summaryModel: summary.summaryModel, summaryInputHash: inputHash, summarySourcePolicyVersion: expectedSourcePolicyVersion, summaryGeneratedAt: summary.summaryGeneratedAt, summaryError: null },
      onCommitted: async ({ session, source, article: committedArticle, now }) => {
        for (const successor of buildIngestionArtifactJobs({ source: { ...source, id: source._id.toHexString() }, article: committedArticle, now, embeddingTarget: this.embeddingTarget }).filter((item) => item.task === 'embedding')) {
          await this.indexingJobs().updateOne({ actorScope: successor.actorScope, idempotencyKey: successor.idempotencyKey }, { $setOnInsert: indexingJobDocument(successor) }, { upsert: true, session })
        }
      },
    })
  }

  async commitEmbeddingArtifact({ job, fence, expectedSourcePolicyVersion, inputHash, embedding } = {}) {
    try { validateEmbeddingVector(embedding?.embedding, { dimensions: this.embeddingTarget.dimensions }) } catch { return false }
    if (embedding?.embeddingStatus !== 'ready' || typeof embedding.embeddingModel !== 'string' || !embedding.embeddingModel || embedding.embeddingDimensions !== this.embeddingTarget.dimensions || embedding.embeddingVersion !== this.embeddingTarget.version || typeof embedding.embeddingArtifactCompatibilityId !== 'string' || !EMBEDDING_COMPATIBILITY_ID.test(embedding.embeddingArtifactCompatibilityId) || this.embeddingTarget.artifactCompatibilityId && embedding.embeddingArtifactCompatibilityId !== this.embeddingTarget.artifactCompatibilityId || embedding.embeddingInputHash !== inputHash || embedding.embeddingSourcePolicyVersion !== expectedSourcePolicyVersion || !(embedding.embeddedAt instanceof Date)) return false
    return this.commitArtifact({
      job, fence, expectedSourcePolicyVersion, purpose: 'embedding',
      inputHash,
      fields: { embeddingStatus: 'ready', embedding: [...embedding.embedding], embeddingModel: embedding.embeddingModel, embeddingDimensions: this.embeddingTarget.dimensions, embeddingArtifactCompatibilityId: embedding.embeddingArtifactCompatibilityId, embeddingInputHash: inputHash, embeddingVersion: this.embeddingTarget.version, embeddingSourcePolicyVersion: expectedSourcePolicyVersion, embeddedAt: embedding.embeddedAt, embeddingError: null },
    })
  }

  async markArtifactProcessing({ job, fence, expectedSourcePolicyVersion, purpose, inputHash } = {}) {
    if (!['summary', 'embedding'].includes(purpose) || typeof inputHash !== 'string') return false
    const fields = purpose === 'summary'
      ? { titleVi: null, summaryVi: null, summaryParagraphsVi: null, summaryStatus: 'processing', summaryDetailStatus: 'processing', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null }
      : { embeddingStatus: 'processing', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null }
    return this.commitArtifact({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, fields, ...(purpose === 'embedding' ? { unsetFields: ['embeddingArtifactCompatibilityId'] } : {}) })
  }

  async resetArtifactPending({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, cancellationRequested = false } = {}) {
    if (!['summary', 'embedding'].includes(purpose) || typeof inputHash !== 'string') return false
    const fields = purpose === 'summary'
      ? { titleVi: null, summaryVi: null, summaryParagraphsVi: null, summaryStatus: 'pending', summaryDetailStatus: 'pending', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null }
      : { embeddingStatus: 'pending', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null }
    return this.commitArtifact({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, fields, cancellationRequested, ...(purpose === 'embedding' ? { unsetFields: ['embeddingArtifactCompatibilityId'] } : {}) })
  }

  async markArtifactFailed({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, error } = {}) {
    if (!['summary', 'embedding'].includes(purpose) || typeof inputHash !== 'string') return false
    const occurredAt = dateValue(this.clock(), 'Artifact failure clock')
    const safe = { code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'artifact_failed', message: 'AI artifact did not complete safely', retryable: Boolean(error?.retryable), occurredAt }
    const fields = purpose === 'summary'
      ? { titleVi: null, summaryVi: null, summaryParagraphsVi: null, summaryStatus: 'failed', summaryDetailStatus: 'failed', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: safe }
      : { embeddingStatus: 'failed', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: safe }
    return this.commitArtifact({ job, fence, expectedSourcePolicyVersion, purpose, inputHash, fields, ...(purpose === 'embedding' ? { unsetFields: ['embeddingArtifactCompatibilityId'] } : {}) })
  }

  async reconcileArticleVisibility({ job, fence, expectedSourcePolicyVersion, now: suppliedNow } = {}) {
    const articleId = contentObjectId(job?.articleId, { nullable: true })
    const sourceId = contentObjectId(job?.sourceId, { nullable: true })
    const jobId = contentObjectId(job?.id, { nullable: true })
    if (!articleId || !sourceId || !jobId || job.task !== 'visibility-reconcile' || fence?.key !== `indexing:article:${articleId.toHexString()}`) return false
    return this.withTransaction(async (session) => {
      const now = dateValue(suppliedNow ?? this.clock(), 'Reconciliation commit clock')
      const leaseFilter = { key: fence.key, 'activeOwner.jobId': jobId, 'activeOwner.ownerTokenHash': fence.ownerTokenHash, 'activeOwner.leaseGeneration': fence.leaseGeneration, 'activeOwner.expiresAt': { $gt: now } }
      const touched = await this.leases().updateOne(leaseFilter, { $set: { lastFenceValidatedAt: now, updatedAt: now } }, { session })
      if (touched.matchedCount !== 1) return false
      const currentJob = await this.indexingJobs().findOne({ _id: jobId, articleId, sourceId, expectedSourcePolicyVersion, task: 'visibility-reconcile', status: 'running', leaseGeneration: fence.leaseGeneration }, { session })
      if (!currentJob) return false
      const source = await this.sources().findOne({ _id: sourceId, policyVersion: expectedSourcePolicyVersion, 'reconciliation.requiredPolicyVersion': expectedSourcePolicyVersion }, { session })
      if (!source) return false
      const article = await this.articles().findOne({ _id: articleId, sourceId, status: { $ne: 'removed' } }, { session })
      if (!article) return false
      const productionEligible = isSourceProductionEligible(source)
      const summaryAllowed = evaluateContentPolicy(source, 'summary').allowed
      const embeddingAllowed = evaluateContentPolicy(source, 'embedding').allowed
      const excerptAllowed = evaluateContentPolicy(source, 'excerpt').allowed
      const summaryCurrent = summaryAllowed && article.summaryStatus === 'ready' && article.summarySourcePolicyVersion === expectedSourcePolicyVersion
      const embeddingCurrent = embeddingAllowed && article.embeddingStatus === 'ready' && article.embeddingSourcePolicyVersion === expectedSourcePolicyVersion && article.embeddingDimensions === this.embeddingTarget.dimensions && article.embeddingVersion === this.embeddingTarget.version && (!this.embeddingTarget.artifactCompatibilityId || article.embeddingArtifactCompatibilityId === this.embeddingTarget.artifactCompatibilityId)
      const mediaAllowed = article.leadMedia ? evaluateMediaPolicy(source, article.leadMedia).allowed : false
      const set = {
        rightsSnapshot: { sourcePolicyVersion: expectedSourcePolicyVersion, licenseStatus: source.licenseStatus, llmInputScope: source.llmInputScope, capturedAt: now },
        updatedAt: now,
      }
      if (!productionEligible && article.status === 'published') { set.status = 'hidden'; set.hiddenReason = 'source_policy_changed' }
      if (!mediaAllowed && article.leadMedia) { set.leadMedia = null; set.leadMediaStatus = 'hidden'; set.leadMediaHiddenReason = 'source_policy_changed' }
      if (!summaryCurrent) Object.assign(set, {
        titleVi: null, summaryVi: null, summaryParagraphsVi: null, summaryStatus: summaryAllowed ? 'pending' : 'removed', summaryDetailStatus: summaryAllowed ? 'pending' : 'removed', summaryBasis: null, summaryModel: null,
        summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null,
      })
      if (!embeddingCurrent) Object.assign(set, {
        embeddingStatus: embeddingAllowed ? 'pending' : 'removed', embedding: null, embeddingModel: null, embeddingDimensions: null,
        embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null,
      })
      const unset = { ...(!excerptAllowed && article.excerptOriginal !== undefined ? { excerptOriginal: '' } : {}), ...(!embeddingCurrent ? { embeddingArtifactCompatibilityId: '' } : {}) }
      const update = { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) }
      if (!excerptAllowed) set.contentScope = 'metadata'
      const result = await this.articles().updateOne({ _id: articleId, sourceId, status: article.status }, update, { session })
      return result.matchedCount === 1
    })
  }

  async searchVisibleArticles({ userId, q, mode = 'text', queryEmbedding, topic, sourceId, publishedAfter, publishedBefore, cursor, limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw contentQueryInvalid('Search limit is invalid')
    const normalizedQuery = normalizedSearchText(q)
    if (normalizedQuery.length < 2 || normalizedQuery.length > 300) throw contentQueryInvalid('Search query is invalid')
    const hybrid = mode === 'hybrid' && embeddingQueryCompatible(queryEmbedding, { expectedCompatibilityId: this.embeddingTarget.artifactCompatibilityId })
    const fingerprint = cursorFingerprint('search', { userId, q: normalizedQuery, mode: hybrid ? 'hybrid' : 'text', topic, sourceId, publishedAfter: publishedAfter?.toISOString?.(), publishedBefore: publishedBefore?.toISOString?.(), limit, queryEmbedding: hybrid ? { model: queryEmbedding.model, dimensions: queryEmbedding.dimensions, version: queryEmbedding.version, artifactCompatibilityId: queryEmbedding.artifactCompatibilityId ?? null } : null })
    const cursorPosition = decodeContentCursor(cursor, 'search', fingerprint)
    const match = contentBaseFilter({ topic, sourceId, publishedAfter, publishedBefore })
    const textMatch = match.$and ? { $and: [...match.$and, { $text: { $search: normalizedQuery } }] } : { ...match, $text: { $search: normalizedQuery } }
    const pipeline = visibilityPipeline({ match: textMatch, userId })
    pipeline.splice(1, 0, { $set: { _textScore: { $meta: 'textScore' } } })
    pipeline[pipeline.length - 1] = { $sort: { _textScore: -1, publishedAt: -1, _id: -1 } }
    if (cursorPosition && !hybrid) {
      const rawScore = Number(cursorPosition.rawScore)
      const publishedAt = new Date(cursorPosition.publishedAt)
      const id = contentObjectId(cursorPosition.id)
      if (!Number.isFinite(rawScore) || Number.isNaN(publishedAt.getTime())) throw contentQueryInvalid()
      pipeline.splice(pipeline.length - 1, 0, { $match: { $expr: { $or: [
        { $lt: ['$_textScore', rawScore] },
        { $and: [{ $eq: ['$_textScore', rawScore] }, { $lt: ['$publishedAt', publishedAt] }] },
        { $and: [{ $eq: ['$_textScore', rawScore] }, { $eq: ['$publishedAt', publishedAt] }, { $lt: ['$_id', id] }] },
      ] } } })
    }
    pipeline.push({ $limit: hybrid ? 401 : limit + 1 })
    const documents = await this.articles().aggregate(pipeline).toArray()
    const ranked = documents.map((document) => {
      const textScore = Math.max(0, Math.min(1, Number(document._textScore ?? 0) / (Number(document._textScore ?? 0) + 1)))
      return { document, article: publicArticleCard(document), score: textScore, textScore, semanticScore: null }
    }).filter((result) => result.article)
    if (hybrid) {
      const semanticFilter = {
        embeddingStatus: 'ready', embeddingModel: queryEmbedding.model, embeddingDimensions: queryEmbedding.dimensions,
        embeddingVersion: queryEmbedding.version, embedding: { $type: 'array' },
        ...(queryEmbedding.artifactCompatibilityId !== undefined ? { embeddingArtifactCompatibilityId: queryEmbedding.artifactCompatibilityId } : {}),
      }
      const semanticMatch = match.$and ? { $and: [...match.$and, semanticFilter] } : { $and: [match, semanticFilter] }
      const semanticDocuments = await this.articles().aggregate(visibilityPipeline({ match: semanticMatch, userId, limit: 400 })).toArray()
      if (semanticDocuments.length === 0) {
        const fallbackPage = ranked.slice(0, limit)
        const fallbackHasNext = ranked.length > limit
        const fallbackLast = fallbackPage.at(-1)
        return {
          results: fallbackPage.map(({ article, score, textScore }) => ({ article, score, textScore, semanticScore: null })),
          hasNext: fallbackHasNext,
          nextCursor: fallbackHasNext && fallbackLast ? encodeContentCursor('search', fingerprint, { id: fallbackLast.document._id.toHexString(), publishedAt: publicDate(fallbackLast.document.publishedAt), score: fallbackLast.score, textScore: fallbackLast.textScore }) : null,
          fallbackReason: 'no-compatible-vectors',
        }
      }
      const candidates = new Map()
      for (const document of semanticDocuments) candidates.set(document._id.toHexString(), { document, rawTextScore: 0 })
      for (const document of documents) candidates.set(document._id.toHexString(), { document, rawTextScore: Number(document._textScore ?? 0) })
      let hybridRanked = [...candidates.values()].flatMap(({ document, rawTextScore }) => {
        const article = publicArticleCard(document)
        if (!article) return []
        const textScore = Math.max(0, Math.min(1, rawTextScore / (rawTextScore + 1)))
        const compatible = embeddingArtifactCompatible(document, queryEmbedding)
        const semanticScore = compatible ? Math.max(0, cosineSimilarity(queryEmbedding.embedding, document.embedding)) : null
        const score = compatible ? 0.45 * textScore + 0.55 * semanticScore : 0.45 * textScore
        return [{ document, article, score: Number(score.toFixed(12)), textScore, semanticScore }]
      }).sort((left, right) => right.score - left.score || right.textScore - left.textScore || right.document.publishedAt - left.document.publishedAt || right.document._id.toHexString().localeCompare(left.document._id.toHexString()))
      if (cursorPosition) {
        const score = Number(cursorPosition.score)
        const textScore = Number(cursorPosition.textScore)
        const publishedAt = new Date(cursorPosition.publishedAt)
        const id = contentObjectId(cursorPosition.id)
        if (!Number.isFinite(score) || !Number.isFinite(textScore) || Number.isNaN(publishedAt.getTime())) throw contentQueryInvalid()
        hybridRanked = hybridRanked.filter((item) => item.score < score || item.score === score && (item.textScore < textScore || item.textScore === textScore && (item.document.publishedAt < publishedAt || item.document.publishedAt.getTime() === publishedAt.getTime() && item.document._id.toHexString() < id.toHexString())))
      }
      const page = hybridRanked.slice(0, limit)
      const hasNext = hybridRanked.length > limit
      const last = page.at(-1)
      return {
        results: page.map(({ article, score, textScore, semanticScore }) => ({ article, score, textScore, semanticScore })),
        hasNext,
        nextCursor: hasNext && last ? encodeContentCursor('search', fingerprint, { id: last.document._id.toHexString(), publishedAt: publicDate(last.document.publishedAt), score: last.score, textScore: last.textScore }) : null,
        fallbackReason: null,
      }
    }
    const page = ranked.slice(0, limit)
    const hasNext = ranked.length > limit
    const last = page.at(-1)
    return {
      results: page.map(({ article, score, textScore, semanticScore }) => ({ article, score, textScore, semanticScore })),
      hasNext,
      nextCursor: hasNext && last ? encodeContentCursor('search', fingerprint, { id: last.document._id.toHexString(), publishedAt: publicDate(last.document.publishedAt), rawScore: Number(last.document._textScore ?? 0) }) : null,
      ...(mode === 'hybrid' && !hybrid ? { fallbackReason: 'no-compatible-vectors' } : {}),
    }
  }

  async visibleArticlesByIds(articleIds, userId) {
    const ids = articleIds.map((value) => contentObjectId(value, { nullable: true })).filter(Boolean)
    if (ids.length === 0) return new Map()
    const documents = await this.articles().aggregate(visibilityPipeline({ match: { status: 'published', _id: { $in: ids } }, userId })).toArray()
    return new Map(documents.map((document) => [document._id.toHexString(), document]))
  }

  async listSavedVisibleArticles({ userId, cursor, limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw contentQueryInvalid('Saved article limit is invalid')
    const userObjectId = contentObjectId(userId)
    const fingerprint = cursorFingerprint('saved', { userId, limit })
    const position = decodeContentCursor(cursor, 'saved', fingerprint)
    const batchSize = 100
    const visibleItems = []
    let scanPosition = position
    let exhausted = false
    while (!exhausted && visibleItems.length <= limit) {
      const relationFilter = { userId: userObjectId }
      if (scanPosition) {
        const createdAt = new Date(scanPosition.createdAt)
        const id = contentObjectId(scanPosition.id)
        if (Number.isNaN(createdAt.getTime())) throw contentQueryInvalid()
        relationFilter.$or = [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }]
      }
      const relations = await this.savedArticles().find(relationFilter).sort({ createdAt: -1, _id: -1 }).limit(batchSize).toArray()
      if (relations.length === 0) break
      const visible = await this.visibleArticlesByIds(relations.map((relation) => relation.articleId), userId)
      const invalidRelations = []
      for (const relation of relations) {
        const document = visible.get(relation.articleId.toHexString())
        const article = document ? publicArticleCard({ ...document, _saved: true }) : null
        if (article) visibleItems.push({ relation, article })
        else invalidRelations.push(relation)
      }
      if (invalidRelations.length > 0) await this.savedArticles().deleteMany({ userId: userObjectId, _id: { $in: invalidRelations.map((relation) => relation._id) } })
      const lastScanned = relations.at(-1)
      scanPosition = { createdAt: publicDate(lastScanned.createdAt), id: lastScanned._id.toHexString() }
      exhausted = relations.length < batchSize
    }
    const pageItems = visibleItems.slice(0, limit)
    const articles = pageItems.map(({ article }) => article)
    const hasNext = visibleItems.length > limit
    const last = pageItems.at(-1)?.relation
    return {
      articles,
      hasNext,
      nextCursor: hasNext && last ? encodeContentCursor('saved', fingerprint, { createdAt: publicDate(last.createdAt), id: last._id.toHexString() }) : null,
    }
  }

  async saveVisibleArticle({ userId, articleId, actorFence } = {}) {
    const userObjectId = contentObjectId(userId)
    const articleObjectId = contentObjectId(articleId, { nullable: true })
    const sessionObjectId = contentObjectId(actorFence?.sessionId, { nullable: true })
    if (!articleObjectId) return false
    if (!sessionObjectId || !Number.isInteger(actorFence?.sessionVersion) || actorFence.sessionVersion < 0) throw contentFenceStale()
    return this.withTransaction(async (session) => {
      const now = dateValue(this.clock(), 'Saved article date')
      const userFence = await this.users().updateOne({ _id: userObjectId, status: 'active', sessionVersion: actorFence.sessionVersion }, { $set: { updatedAt: now } }, { session })
      if (userFence.matchedCount !== 1) throw contentFenceStale()
      const sessionFence = await this.sessions().updateOne({ _id: sessionObjectId, userId: userObjectId, userSessionVersion: actorFence.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { $set: { lastSeenAt: now } }, { session })
      if (sessionFence.matchedCount !== 1) throw contentFenceStale()
      const visible = await this.findVisibleArticleDocument({ userId, articleId, session })
      if (!visible) return false
      const articleFence = await this.articles().updateOne({ _id: articleObjectId, status: 'published', sourceId: visible.sourceId }, { $set: { updatedAt: now } }, { session })
      if (articleFence.matchedCount !== 1) throw contentFenceStale()
      const sourceFence = await this.sources().updateOne({ _id: visible._currentSource._id, operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] }, policyVersion: visible._currentSource.policyVersion }, { $set: { updatedAt: now } }, { session })
      if (sourceFence.matchedCount !== 1) throw contentFenceStale()
      await this.savedArticles().updateOne({ userId: userObjectId, articleId: articleObjectId }, { $setOnInsert: { _id: new ObjectId(), userId: userObjectId, articleId: articleObjectId, createdAt: now } }, { upsert: true, session })
      return true
    })
  }

  async unsaveArticle({ userId, articleId } = {}) {
    const articleObjectId = contentObjectId(articleId, { nullable: true })
    if (!articleObjectId) return
    await this.savedArticles().deleteOne({ userId: contentObjectId(userId), articleId: articleObjectId })
  }

  async clearSavedArticles({ userId } = {}) {
    await this.savedArticles().deleteMany({ userId: contentObjectId(userId) })
  }

  async findQnaEvidence({ limit = 20, includeSource = false, scope = {}, question, queryEmbedding, relevanceThreshold = 0.25 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ArticleError('article_query_invalid', 'Article limit is invalid', { status: 400 })
    const collection = this.articles()
    const qnaFilter = qnaEvidenceFilter({ sourcePath: '_currentSource' })
    const scopeFilter = qnaScopeFilter(scope)
    const candidateLimit = typeof question === 'string' ? Math.min(400, Math.max(limit, 100)) : limit
    if (typeof collection.aggregate !== 'function') {
      const documents = await collection.find({ status: qnaFilter.status, authorityTier: qnaFilter.authorityTier, evidenceEligible: qnaFilter.evidenceEligible, ...scopeFilter }).sort({ publishedAt: -1, _id: -1 }).limit(candidateLimit).toArray()
      const evidence = []
      for (const document of documents) {
        const source = await sourceForArticle(this.sources(), document)
        if (canUseQnaEvidence(document, source)) {
          const article = serializeVisibleArticle(document, source)
          evidence.push(includeSource ? { article, source: serializeSourceForQna(source) } : article)
        }
      }
      return typeof question === 'string' ? rankQnaEvidence({ question, records: evidence, queryEmbedding, relevanceThreshold, maxCandidates: Math.min(50, limit) }).slice(0, limit) : evidence
    }
    const articles = await collection.aggregate([
      { $match: { status: qnaFilter.status, authorityTier: qnaFilter.authorityTier, evidenceEligible: qnaFilter.evidenceEligible, ...scopeFilter } },
      { $lookup: { from: 'sources', localField: 'sourceId', foreignField: '_id', as: '_currentSource' } },
      { $unwind: '$_currentSource' },
      { $match: sourceOnlyFilter(qnaFilter) },
      { $sort: { publishedAt: -1, _id: -1 } },
      { $limit: candidateLimit },
    ]).toArray()
    const evidence = articles.flatMap(({ _currentSource: source, ...document }) => {
      if (!canUseQnaEvidence(document, source)) return []
      const article = serializeVisibleArticle(document, source)
      return [includeSource ? { article, source: serializeSourceForQna(source) } : article]
    })
    return typeof question === 'string' ? rankQnaEvidence({ question, records: evidence, queryEmbedding, relevanceThreshold, maxCandidates: Math.min(50, limit) }).slice(0, limit) : evidence
  }
}

export { articleDocument, assertArticleMatchesCurrent, commitFence, safeCandidate }
