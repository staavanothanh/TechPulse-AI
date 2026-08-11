import { ObjectId } from 'mongodb'
import { createJobAuditEvent } from '../../audit/job-writer.js'
import { BGE_M3 } from '../../ai/embedding.js'
import { JobError, actorScopeForAdmin, canonicalRequestHash } from '../../domain/jobs/idempotency.js'

const DAY_MS = 24 * 60 * 60 * 1000
const AGING_MS = 30 * 60 * 1000
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MAX_ATTEMPTS = 3

function requireAdmin(auth) {
  if (!auth?.user) throw new JobError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status && auth.user.status !== 'active') throw new JobError(403, 'forbidden', 'Administrator role is required')
  return auth.user
}

function objectIdString(value, label) {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) throw new JobError(400, 'bad_request', `${label} is invalid`)
  return value.toLowerCase()
}

function requireKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw new JobError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}

function assertEligible(source) {
  if (!source) throw new JobError(404, 'not_found', 'Source not found')
  if (source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus) || source.technicalCheck?.status !== 'passed') throw new JobError(409, 'source_policy_blocked', 'Current source policy does not permit indexing')
}

function actorFence(auth) {
  return { userId: auth.user.id ?? auth.user._id, sessionId: auth.session?.id ?? auth.session?._id, sessionVersion: auth.session?.userSessionVersion }
}

function auditRequest(request, key, auth) {
  return { serverRequestId: request?.requestId ?? request?.serverRequestId ?? key, idempotencyKey: key, actorSessionId: auth.session?.id ?? auth.session?._id }
}

function buildJob({ article, source, auth, idempotencyKey, task, trigger, attempt = 1, parentJobId, createdAt, operation }) {
  const id = new ObjectId().toHexString()
  const requestHash = canonicalRequestHash({ operation, articleId: article.id, sourceId: source.id, expectedSourcePolicyVersion: source.policyVersion, task, targetEmbeddingVersion: task === 'embedding' ? BGE_M3.version : null, parentJobId: parentJobId ?? null })
  return {
    id, idempotencyKey, actorScope: actorScopeForAdmin(auth), requestHash, articleId: article.id, sourceId: source.id,
    expectedSourcePolicyVersion: source.policyVersion, task, trigger, requestedBy: auth.user.id ?? auth.user._id,
    ...(parentJobId ? { parentJobId } : {}), status: 'queued', attempt, priority: trigger === 'admin' ? 50 : 25,
    availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + AGING_MS), idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * DAY_MS),
    leaseGeneration: 0, ...(task === 'embedding' ? { targetEmbeddingVersion: BGE_M3.version } : {}), createdAt, updatedAt: createdAt,
  }
}

export function createIndexingJobService({ indexingJobRepository, articleRepository, sourceRepository, rateLimitAdmission, runDueWork, now = () => new Date() } = {}) {
  if (!indexingJobRepository || !articleRepository || !sourceRepository) throw new Error('Indexing repositories are required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  const contextFor = async (articleId) => {
    const id = objectIdString(articleId, 'articleId')
    const article = await articleRepository.findArticleForIndexing(id)
    if (!article) throw new JobError(404, 'not_found', 'Article not found')
    const source = await sourceRepository.findSourceById(objectIdString(article.sourceId, 'sourceId'))
    assertEligible(source)
    return { article, source }
  }
  const create = async ({ auth, articleId, task, idempotencyKey, request, trigger = 'admin', attempt = 1, parentJobId, operation }) => {
    const actor = requireAdmin(auth)
    const key = requireKey(idempotencyKey)
    const { article, source } = await contextFor(articleId)
    const createdAt = now()
    const job = buildJob({ article, source, auth, idempotencyKey: key, task, trigger, attempt, parentJobId, createdAt, operation })
    const action = trigger === 'retry' ? 'indexing_job_retry_created' : 'indexing_job_created'
    const reasonCode = trigger === 'retry' ? 'job_retry_requested' : 'artifact_regeneration_requested'
    const changedFields = trigger === 'retry' ? ['status', 'attempt', 'parentJobId'] : ['status']
    const audit = createJobAuditEvent({ actor, action, targetId: job.id, changedFields, reasonCode, request: auditRequest(request, key, auth), result: 'pending', createdAt })
    const result = await indexingJobRepository.createOrReuseIndexingJobWithAdmission({
      job, audit, actorFence: actorFence(auth), rateLimitAdmission, admission: { scope: 'admin-trigger', subject: actor.id ?? actor._id },
      ...(parentJobId ? { parentJobId, nextAttempt: attempt } : {}),
    })
    await runDueWork?.()
    return result
  }
  return Object.freeze({
    async listIndexingJobs({ auth, query } = {}) { requireAdmin(auth); return indexingJobRepository.listIndexingJobs(query) },
    async getIndexingJob({ auth, jobId } = {}) {
      requireAdmin(auth)
      const job = await indexingJobRepository.findIndexingJobById(objectIdString(jobId, 'jobId'))
      if (!job) throw new JobError(404, 'not_found', 'Indexing job not found')
      return job
    },
    async createSummaryJob({ auth, articleId, reasonCode, idempotencyKey, request } = {}) {
      if (reasonCode !== 'artifact_regeneration_requested') throw new JobError(422, 'validation_error', 'reasonCode must match artifact regeneration')
      return create({ auth, articleId, task: 'summary', idempotencyKey, request, operation: 'create-summary-job' })
    },
    async createIndexingJob({ auth, articleId, input = {}, idempotencyKey, request } = {}) {
      if (!['embedding', 'visibility-reconcile'].includes(input.task) || input.reasonCode !== 'artifact_regeneration_requested') throw new JobError(422, 'validation_error', 'Indexing job request is invalid')
      return create({ auth, articleId, task: input.task, idempotencyKey, request, operation: 'create-indexing-job' })
    },
    async retryIndexingJob({ auth, jobId, reasonCode, idempotencyKey, request } = {}) {
      requireAdmin(auth)
      if (reasonCode !== 'job_retry_requested') throw new JobError(422, 'validation_error', 'reasonCode must match job retry')
      const parent = await indexingJobRepository.findIndexingJobById(objectIdString(jobId, 'jobId'))
      if (!parent) throw new JobError(404, 'not_found', 'Indexing job not found')
      if (!(parent.status === 'partial' || parent.status === 'failed' && parent.error?.retryable === true) || parent.attempt >= MAX_ATTEMPTS) throw new JobError(409, 'conflict', 'Indexing job is not retryable')
      return create({ auth, articleId: parent.articleId, task: parent.task, idempotencyKey, request, trigger: 'retry', attempt: parent.attempt + 1, parentJobId: parent.id, operation: 'retry-indexing-job' })
    },
    async cancelIndexingJob({ auth, jobId, reasonCode, request } = {}) {
      const actor = requireAdmin(auth)
      if (reasonCode !== 'job_cancel_requested') throw new JobError(422, 'validation_error', 'reasonCode must match job cancellation')
      const id = objectIdString(jobId, 'jobId')
      return indexingJobRepository.cancelIndexingJob({ jobId: id, actor, reasonCode, request: { serverRequestId: request?.requestId ?? request?.serverRequestId ?? `cancel:${id}`, actorSessionId: auth.session?.id ?? auth.session?._id }, actorFence: actorFence(auth), now: now() })
    },
  })
}

export { JobError }
