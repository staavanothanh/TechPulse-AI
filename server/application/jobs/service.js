import { ObjectId } from 'mongodb'
import { createJobAuditEvent } from '../../audit/job-writer.js'
import { JobError, actorScopeForAdmin, canonicalRequestHash } from '../../domain/jobs/idempotency.js'

const DAY_MS = 24 * 60 * 60 * 1000
const AGING_MS = 30 * 60 * 1000
const MAX_ATTEMPTS = 3
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function requireAdmin(auth) {
  if (!auth?.user) throw new JobError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status && auth.user.status !== 'active') throw new JobError(403, 'forbidden', 'Administrator role is required')
  return auth.user
}

function objectIdString(value, label) {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) throw new JobError(400, 'bad_request', `${label} is invalid`)
  return value.toLowerCase()
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw new JobError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}

function actorFence(auth) {
  return { userId: auth.user.id ?? auth.user._id, sessionId: auth.session?._id ?? auth.session?.id, sessionVersion: auth.session?.userSessionVersion }
}

function assertEligibleSource(source) {
  if (!source) throw new JobError(404, 'not_found', 'Source not found')
  if (source.operationalStatus !== 'active') throw new JobError(409, 'source_policy_blocked', 'Source must be active before ingestion')
  if (!['permitted', 'metadata-only'].includes(source.licenseStatus)) throw new JobError(409, 'source_policy_blocked', 'Source policy does not permit production ingestion')
  if (source.technicalCheck?.status !== 'passed') throw new JobError(409, 'source_policy_blocked', 'Source technical check has not passed')
}

function zeroCounters() {
  return { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }
}

function buildJob({ source, auth, idempotencyKey, batchSize, trigger, attempt, parentJobId, createdAt, operation }) {
  const id = new ObjectId().toHexString()
  const actorScope = actorScopeForAdmin(auth)
  const normalizedBatch = batchSize ?? source.connectorConfig?.batchSize ?? 20
  if (!Number.isInteger(normalizedBatch) || normalizedBatch < 1 || normalizedBatch > 100) throw new JobError(422, 'validation_error', 'batchSize must be between 1 and 100')
  const requestHash = canonicalRequestHash({ operation, sourceId: source.id, batchSize: normalizedBatch, expectedSourcePolicyVersion: source.policyVersion, parentJobId: parentJobId ?? null })
  return {
    id, idempotencyKey, actorScope, requestHash, sourceId: source.id, connectorType: source.connectorType,
    expectedSourcePolicyVersion: source.policyVersion, trigger, requestedBy: auth.user.id ?? auth.user._id,
    ...(parentJobId ? { parentJobId } : {}), status: 'queued', attempt, priority: trigger === 'admin' ? 50 : 25,
    availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + AGING_MS), idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * DAY_MS),
    leaseGeneration: 0, batchSize: normalizedBatch, counters: zeroCounters(), createdAt, updatedAt: createdAt,
  }
}

function auditRequest(request, idempotencyKey, auth) {
  return { serverRequestId: request?.requestId ?? request?.serverRequestId ?? idempotencyKey, idempotencyKey, actorSessionId: auth.session?._id ?? auth.session?.id }
}

export function createJobService({ jobRepository, sourceRepository, rateLimitAdmission, runDueWork, now = () => new Date() } = {}) {
  if (!jobRepository || !sourceRepository) throw new Error('Job and source repositories are required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  if (typeof jobRepository.createOrReuseIngestionJobWithAdmission !== 'function') throw new Error('Atomic job admission repository is required')
  const coordinateDueWork = runDueWork
  const sourceFor = async (sourceId) => {
    const source = await sourceRepository.findSourceById(objectIdString(sourceId, 'sourceId'))
    assertEligibleSource(source)
    return source
  }
  return Object.freeze({
    async listIngestionJobs({ auth, query } = {}) {
      requireAdmin(auth)
      return jobRepository.listIngestionJobs(query)
    },
    async getIngestionJob({ auth, jobId } = {}) {
      requireAdmin(auth)
      const job = await jobRepository.findIngestionJobById(objectIdString(jobId, 'jobId'))
      if (!job) throw new JobError(404, 'not_found', 'Ingestion job not found')
      return job
    },
    async createIngestionJob({ auth, input = {}, idempotencyKey, request } = {}) {
      const actor = requireAdmin(auth)
      const key = requireIdempotencyKey(idempotencyKey)
      const source = await sourceFor(input.sourceId)
      const createdAt = now()
      const job = buildJob({ source, auth, idempotencyKey: key, batchSize: input.batchSize, trigger: 'admin', attempt: 1, createdAt, operation: 'create-ingestion-job' })
      const audit = createJobAuditEvent({ actor, action: 'ingestion_job_created', targetId: job.id, changedFields: ['status'], reasonCode: 'ingestion_trigger_requested', request: auditRequest(request, key, auth), result: 'pending', createdAt })
      const created = await jobRepository.createOrReuseIngestionJobWithAdmission({
        job, audit, actorFence: actorFence(auth), rateLimitAdmission,
        admission: { scope: 'admin-trigger', subject: String(actor.id ?? actor._id) },
      })
      await coordinateDueWork?.()
      return created
    },
    async retryIngestionJob({ auth, jobId, idempotencyKey, reasonCode, request } = {}) {
      const actor = requireAdmin(auth)
      if (reasonCode !== 'job_retry_requested') throw new JobError(422, 'validation_error', 'reasonCode must match job retry')
      const key = requireIdempotencyKey(idempotencyKey)
      const parent = await jobRepository.findIngestionJobById(objectIdString(jobId, 'jobId'))
      if (!parent) throw new JobError(404, 'not_found', 'Ingestion job not found')
      const retryable = parent.status === 'partial' || parent.status === 'failed' && parent.error?.retryable === true
      if (!retryable) throw new JobError(409, 'conflict', 'Ingestion job is not retryable')
      if (parent.attempt >= MAX_ATTEMPTS) throw new JobError(409, 'conflict', 'Ingestion job retry limit is reached')
      const source = await sourceFor(parent.sourceId)
      const createdAt = now()
      const job = buildJob({ source, auth, idempotencyKey: key, batchSize: parent.batchSize, trigger: 'retry', attempt: parent.attempt + 1, parentJobId: parent.id, createdAt, operation: 'retry-ingestion-job' })
      const audit = createJobAuditEvent({ actor, action: 'ingestion_job_retry_created', targetId: job.id, changedFields: ['status', 'attempt', 'parentJobId'], reasonCode, request: auditRequest(request, key, auth), createdAt })
      const created = await jobRepository.createOrReuseIngestionJobWithAdmission({
        job, audit, actorFence: actorFence(auth), rateLimitAdmission,
        admission: { scope: 'admin-trigger', subject: String(actor.id ?? actor._id) }, parentJobId: parent.id, nextAttempt: parent.attempt + 1,
      })
      await coordinateDueWork?.()
      return created
    },
    async runDueWork({ auth } = {}) {
      const actor = requireAdmin(auth)
      if (typeof coordinateDueWork !== 'function') throw new JobError(503, 'service_unavailable', 'Due-work coordinator is not configured')
      let admission
      try {
        admission = await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(actor.id ?? actor._id) })
      } catch {
        throw new JobError(503, 'service_unavailable', 'Admin admission is unavailable')
      }
      if (admission?.allowed === false) throw new JobError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: admission.retryAfterSeconds })
      return coordinateDueWork()
    },
    async cancelIngestionJob({ auth, jobId, reasonCode, request } = {}) {
      const actor = requireAdmin(auth)
      if (reasonCode !== 'job_cancel_requested') throw new JobError(422, 'validation_error', 'reasonCode must match job cancellation')
      const id = objectIdString(jobId, 'jobId')
      const createdAt = now()
      return jobRepository.cancelIngestionJob({ jobId: id, actor, reasonCode, request: { serverRequestId: request?.requestId ?? request?.serverRequestId ?? `cancel:${id}`, actorSessionId: auth.session?._id ?? auth.session?.id }, actorFence: actorFence(auth), now: createdAt })
    },
  })
}

export { JobError }
