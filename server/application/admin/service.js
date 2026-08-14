import { ObjectId } from 'mongodb'

export class AdminGovernanceError extends Error {
  constructor(status, code, message, options = {}) {
    super(message)
    this.name = 'AdminGovernanceError'
    this.status = status
    this.code = code
    this.details = options.details
    this.retryAfter = options.retryAfter
  }
}

function requireAdmin(auth) {
  if (!auth?.user) throw new AdminGovernanceError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status !== 'active') throw new AdminGovernanceError(403, 'forbidden', 'Administrator role is required')
  return auth.user
}

function articleId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) throw new AdminGovernanceError(400, 'bad_request', 'Article identifier is invalid')
  return value.toLowerCase()
}

function dateIso(value, nullable = false) {
  if (value === null && nullable) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function safeError(error) {
  if (!error) return null
  const artifactFailure = ['provider_failed', 'artifact_generation_failed', 'artifact_failed'].includes(error.code)
  const result = {
    code: artifactFailure ? 'artifact_generation_failed' : 'operation_failed',
    message: artifactFailure ? 'AI artifact did not complete safely' : 'Operation did not complete safely',
    retryable: Boolean(error.retryable),
    occurredAt: dateIso(error.occurredAt) ?? new Date().toISOString(),
  }
  if (Number.isInteger(error.upstreamStatus)) result.upstreamStatus = error.upstreamStatus
  return result
}

function safeHttps(value) {
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch { return null }
}

function safeMedia(media) {
  if (!media || typeof media !== 'object') return null
  const url = safeHttps(media.url)
  const sourcePageUrl = safeHttps(media.sourcePageUrl)
  if (!url || !sourcePageUrl || !['image', 'video'].includes(media.type)) return null
  return {
    type: media.type,
    displayMode: media.displayMode,
    url,
    sourcePageUrl,
    altText: typeof media.altText === 'string' ? media.altText : null,
    credit: typeof media.credit === 'string' ? media.credit : null,
    attribution: typeof media.attribution === 'string' ? media.attribution.slice(0, 500) : '',
    mediaEvidenceStatus: 'not-analyzed',
  }
}

function idString(value) {
  return value?.toHexString?.() ?? String(value)
}

function safeArticle(document, detail = false) {
  if (!document) return null
  if (document.status === 'removed') {
    return {
      id: idString(document._id ?? document.id),
      sourceId: idString(document.sourceId),
      status: 'removed',
      removalPolicyVersion: document.removalPolicyVersion,
      removedAt: dateIso(document.removedAt),
      updatedAt: dateIso(document.updatedAt),
    }
  }
  const base = {
    id: idString(document._id ?? document.id),
    sourceId: idString(document.sourceId),
    titleOriginal: String(document.titleOriginal ?? ''),
    status: document.status,
    topics: Array.isArray(document.topics) ? [...document.topics] : [],
    leadMedia: safeMedia(document.leadMedia),
    leadMediaStatus: document.leadMediaStatus ?? 'none',
    summaryStatus: document.summaryStatus,
    embeddingStatus: document.embeddingStatus,
    embeddingModel: document.embeddingModel ?? null,
    embeddingVersion: Number.isInteger(document.embeddingVersion) ? document.embeddingVersion : null,
    updatedAt: dateIso(document.updatedAt),
  }
  if (!detail) return base
  return {
    ...base,
    originalUrl: safeHttps(document.originalUrl),
    provenance: (document.provenance ?? []).flatMap((entry) => {
      const originalUrl = safeHttps(entry.originalUrl)
      return originalUrl ? [{ sourceId: idString(entry.sourceId), originalUrl, observedAt: dateIso(entry.observedAt) }] : []
    }),
    rightsSnapshot: document.rightsSnapshot ? {
      sourcePolicyVersion: document.rightsSnapshot.sourcePolicyVersion,
      licenseStatus: document.rightsSnapshot.licenseStatus,
      llmInputScope: document.rightsSnapshot.llmInputScope,
      capturedAt: dateIso(document.rightsSnapshot.capturedAt),
    } : null,
    summaryModel: document.summaryModel ?? null,
    summarySourcePolicyVersion: document.summarySourcePolicyVersion ?? null,
    summaryGeneratedAt: dateIso(document.summaryGeneratedAt, true),
    summaryError: safeError(document.summaryError),
    embeddingSourcePolicyVersion: document.embeddingSourcePolicyVersion ?? null,
    embeddedAt: dateIso(document.embeddedAt, true),
    embeddingError: safeError(document.embeddingError),
  }
}

function safeOverview(value = {}) {
  const fields = ['activeSources', 'pausedSources', 'sourcesNeedingReview', 'queuedJobs', 'failedJobs', 'articlesNeedingReview', 'failedIndexes', 'openTakedowns', 'failedAccountDeletions']
  return Object.fromEntries([...fields.map((field) => [field, Number.isInteger(value[field]) && value[field] >= 0 ? value[field] : 0]), ['lastSuccessfulIngestionAt', dateIso(value.lastSuccessfulIngestionAt, true)]])
}

function safeAudit(value) {
  return {
    id: idString(value._id ?? value.id), actorType: value.actorType, actorId: idString(value.actorId), action: value.action,
    targetType: value.targetType, targetId: idString(value.targetId), changedFields: Array.isArray(value.changedFields) ? [...value.changedFields] : [],
    stateTransition: value.stateTransition ? { from: value.stateTransition.from, to: value.stateTransition.to } : null,
    reasonCode: value.reasonCode, requestId: String(value.requestId), result: value.result, createdAt: dateIso(value.createdAt),
  }
}

function validateArticlePatch(patch = {}) {
  const categories = [['status', 'article_status_changed'], ['topics', 'article_topics_changed'], ['leadMediaStatus', 'article_media_visibility_changed']].filter(([field]) => Object.hasOwn(patch, field))
  if (categories.length !== 1 || patch.reasonCode !== categories[0][1]) throw new AdminGovernanceError(422, 'validation_error', 'Exactly one article mutation category and matching reasonCode are required')
  if (categories[0][0] === 'topics' && (!Array.isArray(patch.topics) || patch.topics.length === 0 || patch.topics.length > 20 || new Set(patch.topics).size !== patch.topics.length || patch.topics.some((topic) => typeof topic !== 'string' || topic.length < 1 || topic.length > 64))) throw new AdminGovernanceError(422, 'validation_error', 'Article topics are invalid')
  return categories[0][0]
}

function unavailable() { throw new AdminGovernanceError(503, 'service_unavailable', 'Admin governance service is not configured') }

export function createAdminGovernanceService({ repository, rateLimitAdmission } = {}) {
  const repo = repository ?? {}
  return Object.freeze({
    async getAdminOverview({ auth } = {}) { requireAdmin(auth); return safeOverview(await (repo.getOverview ?? unavailable).call(repo)) },
    async listAdminArticles({ auth, query } = {}) {
      requireAdmin(auth)
      const result = await (repo.listAdminArticles ?? unavailable).call(repo, query)
      return { articles: (result?.articles ?? []).map((item) => safeArticle(item)), hasNext: Boolean(result?.hasNext), nextCursor: result?.nextCursor ?? null }
    },
    async getAdminArticle({ auth, articleId: value } = {}) {
      requireAdmin(auth)
      const item = await (repo.findAdminArticle ?? unavailable).call(repo, articleId(value))
      if (!item) throw new AdminGovernanceError(404, 'not_found', 'Article not found')
      return safeArticle(item, true)
    },
    async updateAdminArticle({ auth, articleId: value, patch, request } = {}) {
      requireAdmin(auth)
      const id = articleId(value)
      const category = validateArticlePatch(patch)
      const item = await (repo.updateAdminArticle ?? unavailable).call(repo, id, { category, value: patch[category], reasonCode: patch.reasonCode, actor: auth.user, actorFence: { userId: auth.user.id ?? auth.user._id, sessionId: auth.session?.id ?? auth.session?._id, sessionVersion: auth.session?.userSessionVersion }, request, rateLimitAdmission })
      if (!item) throw new AdminGovernanceError(404, 'not_found', 'Article not found')
      return safeArticle(item)
    },
    async mergeDuplicateArticles({ auth, input, idempotencyKey, request } = {}) {
      requireAdmin(auth)
      if (!input || typeof input.canonicalArticleId !== 'string' || !Array.isArray(input.duplicateArticleIds) || input.reasonCode !== 'duplicate_merge_confirmed') throw new AdminGovernanceError(422, 'validation_error', 'Duplicate merge request is invalid')
      if (!idempotencyKey) throw new AdminGovernanceError(400, 'bad_request', 'Idempotency-Key is invalid')
      const result = await (repo.mergeDuplicateArticles ?? unavailable).call(repo, { ...input, idempotencyKey, actor: auth.user, actorFence: { userId: auth.user.id ?? auth.user._id, sessionId: auth.session?.id ?? auth.session?._id, sessionVersion: auth.session?.userSessionVersion }, request: { serverRequestId: request?.requestId ?? request?.serverRequestId, idempotencyKey }, rateLimitAdmission, reasonCode: input.reasonCode })
      if (!result?.canonical) throw new AdminGovernanceError(404, 'not_found', 'Article not found')
      return safeArticle(result.canonical)
    },
    async listAuditLogs({ auth, query } = {}) {
      requireAdmin(auth)
      const result = await (repo.listAuditLogs ?? unavailable).call(repo, query)
      return { logs: (result?.logs ?? []).map(safeAudit), hasNext: Boolean(result?.hasNext), nextCursor: result?.nextCursor ?? null }
    },
  })
}

export { safeArticle, safeAudit, safeOverview, validateArticlePatch }
