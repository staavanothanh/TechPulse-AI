import { ObjectId } from 'mongodb'
import { createSourceAuditEvent, sourceAuditEventId } from '../../audit/source-writer.js'
import { applySourceUpdate, createDraftSource, requestPolicyReReview, reviewSourcePolicy } from '../../domain/source/state-machine.js'
import { SourceValidationError, normalizeReviewedHostname } from '../../domain/source/validation.js'

export class SourceError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options)
    this.name = 'SourceError'
    this.status = status
    this.code = code
    this.retryAfter = options.retryAfter
    if (options.details) this.details = options.details
  }
}

function requireAdmin(auth) {
  if (!auth?.user) throw new SourceError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status && auth.user.status !== 'active') throw new SourceError(403, 'forbidden', 'Insufficient permissions')
  return auth.user
}

function actorFence(auth) {
  return {
    userId: auth.user._id ?? auth.user.id,
    sessionId: auth.session?._id ?? auth.session?.id,
    sessionVersion: auth.session?.userSessionVersion,
  }
}

function sourceId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) throw new SourceError(404, 'not_found', 'Source not found')
  return value
}

function repositoryRequired(repository) {
  if (!repository) throw new SourceError(503, 'service_unavailable', 'Source Registry service is not configured')
  return repository
}

function mapError(error) {
  if (error instanceof SourceError) return error
  if (error instanceof SourceValidationError && error.details?.reasonCode === 'invalid_state_transition') return new SourceError(409, 'invalid_state_transition', error.message, { cause: error })
  if (error instanceof SourceValidationError) return new SourceError(422, 'validation_error', error.message, { cause: error, details: error.details })
  if (error?.code === 'idempotency_mismatch') return new SourceError(409, 'idempotency_mismatch', 'Idempotency key does not match the original source intent', { cause: error })
  if (error?.code === 11000) return new SourceError(409, 'conflict', 'Source already exists', { cause: error })
  if (error?.code === 'source_conflict') return new SourceError(409, 'conflict', 'Source changed concurrently', { cause: error })
  if (error?.code === 'source_validation') return new SourceError(422, 'validation_error', error.message, { cause: error })
  if (error?.name?.startsWith('Mongo') || [6, 7, 89, 91, 189].includes(error?.code)) return new SourceError(503, 'service_unavailable', 'Source Registry is temporarily unavailable', { cause: error })
  return error
}

function requestIdentity(request, idempotencyKey, auth) {
  return { serverRequestId: request?.serverRequestId, idempotencyKey, actorSessionId: auth?.session?._id ?? auth?.session?.id }
}

function auditFor({ auth, actor, action, source, changedFields, reasonCode, request, result, stateTransition, idempotencyKey, createdAt }) {
  return createSourceAuditEvent({ actor, action, targetId: source.id, changedFields, reasonCode, request: requestIdentity(request, idempotencyKey, auth), result, stateTransition, createdAt: createdAt ?? source.updatedAt ?? new Date() })
}

const CONFIGURATION_AUDIT_FIELDS = new Set(['name', 'publisherName', 'domain', 'authorityTier', 'connectorConfig', 'mediaPolicy', 'attributionRequired', 'attributionText', 'operationalStatus'])
const POLICY_REVIEW_AUDIT_FIELDS = Object.freeze(['licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'attributionText', 'termsUrl', 'licenseUrl', 'evidenceNote', 'reviewedAt', 'reviewedBy', 'policyVersion'])
const RE_REVIEW_AUDIT_FIELDS = Object.freeze(['licenseStatus', 'llmInputScope', 'storageScope', 'reviewedAt', 'reviewedBy', 'policyVersion'])

function updateAuditAttempt(previous, patch = {}) {
  const fields = Object.keys(patch).filter((field) => field !== 'reasonCode' && (field === 'operationalStatus' || CONFIGURATION_AUDIT_FIELDS.has(field))).sort()
  if (fields.length === 1 && fields[0] === 'operationalStatus') return { action: 'source_status_updated', changedFields: fields, reasonCode: 'source_status_changed', stateTransition: { from: previous.operationalStatus, to: patch.operationalStatus } }
  if (fields.length > 0) return { action: 'source_configuration_updated', changedFields: fields, reasonCode: 'source_configuration_changed', ...(fields.includes('operationalStatus') ? { stateTransition: { from: previous.operationalStatus, to: patch.operationalStatus } } : {}) }
  return null
}

function validTechnicalCheck(result, now) {
  if (!result || !['passed', 'failed'].includes(result.status)) throw new SourceError(503, 'service_unavailable', 'Technical check returned an invalid result')
  const checkedAt = result.checkedAt instanceof Date ? result.checkedAt : now
  if (result.status === 'passed') {
    if (typeof result.contentType !== 'string' || !result.contentType.trim() || result.contentType.trim().length > 255 || typeof result.resolvedHost !== 'string' || !Number.isInteger(result.sampleCount) || result.sampleCount < 1 || result.sampleCount > 100) throw new SourceError(503, 'service_unavailable', 'Technical check returned an invalid result')
    let resolvedHost
    try { resolvedHost = normalizeReviewedHostname(result.resolvedHost) } catch (error) { throw new SourceError(503, 'service_unavailable', 'Technical check returned an invalid result', { cause: error }) }
    return { status: 'passed', checkedAt, contentType: result.contentType.trim(), resolvedHost, sampleCount: result.sampleCount, error: null }
  }
  if (!result.error || typeof result.error.code !== 'string' || !/^[a-z0-9_:-]{1,128}$/.test(result.error.code) || typeof result.error.message !== 'string' || !result.error.message.trim() || result.error.message.length > 500 || typeof result.error.retryable !== 'boolean' || result.error.upstreamStatus !== undefined && (!Number.isInteger(result.error.upstreamStatus) || result.error.upstreamStatus < 100 || result.error.upstreamStatus > 599)) throw new SourceError(503, 'service_unavailable', 'Technical check returned an invalid result')
  return { status: 'failed', checkedAt, contentType: null, resolvedHost: null, sampleCount: null, error: { code: result.error.code, message: result.error.message, retryable: result.error.retryable, occurredAt: result.error.occurredAt instanceof Date ? result.error.occurredAt : checkedAt, ...(Number.isInteger(result.error.upstreamStatus) ? { upstreamStatus: result.error.upstreamStatus } : {}) } }
}

function nextMutationTime(previous, candidate) {
  if (!(candidate instanceof Date) || Number.isNaN(candidate.getTime())) throw new SourceError(503, 'service_unavailable', 'Server time is unavailable')
  const previousTime = previous?.updatedAt instanceof Date ? previous.updatedAt.getTime() : Number.NaN
  return Number.isFinite(previousTime) && candidate.getTime() <= previousTime ? new Date(previousTime + 1) : candidate
}

function technicalCheckInput(source) {
  return Object.freeze({
    id: source.id,
    sourceKey: source.sourceKey,
    domain: source.domain,
    connectorType: source.connectorType,
    accessMethod: source.accessMethod,
    authorityTier: source.authorityTier,
    connectorConfig: Object.freeze({ ...source.connectorConfig }),
    policyVersion: source.policyVersion,
  })
}

export function createSourceService({ repository, technicalCheckAdapter, rateLimitAdmission, now = () => new Date() } = {}) {
  if (technicalCheckAdapter?.run && typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  async function recordFailed({ auth, actor, sourceId: targetId, action, changedFields, reasonCode, request, stateTransition, idempotencyKey, createdAt = now() }) {
    try {
      if (!repository?.commitFailedAudit) throw new Error('failed source audit repository is unavailable')
      const audit = auditFor({ auth, actor, action, source: { id: targetId, updatedAt: createdAt }, changedFields, reasonCode, request, result: 'failed', stateTransition, idempotencyKey, createdAt })
      await repository.commitFailedAudit({ audit, actorFence: actorFence(auth) })
    } catch (error) {
      throw new SourceError(503, 'service_unavailable', 'Required source audit could not be persisted', { cause: error })
    }
  }

  async function current(auth, rawId) {
    requireAdmin(auth)
    let found
    try { found = await repositoryRequired(repository).findSourceById(sourceId(rawId)) } catch (error) { throw mapError(error) }
    if (!found) throw new SourceError(404, 'not_found', 'Source not found')
    return found
  }

  async function commit(auth, previous, result, audit) {
    try {
      return await repositoryRequired(repository).commitReplacement({ source: result.source, expectedUpdatedAt: previous.updatedAt, expectedPolicyVersion: previous.policyVersion, audit, actorFence: actorFence(auth) })
    } catch (error) { throw mapError(error) }
  }

  return Object.freeze({
    async list({ auth, query = {} } = {}) {
      requireAdmin(auth)
      try { return await repositoryRequired(repository).listSources(query) } catch (error) { throw mapError(error) }
    },
    async get({ auth, sourceId: rawId } = {}) { return current(auth, rawId) },
    async create({ auth, input, request } = {}) {
      const actor = requireAdmin(auth)
      const createdAt = now()
      const targetId = new ObjectId().toHexString()
      let source
      try { source = createDraftSource(input, { id: targetId, now: createdAt }) } catch (error) {
        await recordFailed({ auth, actor, sourceId: targetId, action: 'source_created', changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request, createdAt })
        throw mapError(error)
      }
      const audit = auditFor({ auth, actor, action: 'source_created', source, changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request })
      try { return await repositoryRequired(repository).commitCreate({ source, audit, actorFence: actorFence(auth) }) } catch (error) {
        await recordFailed({ auth, actor, sourceId: source.id, action: 'source_created', changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request, createdAt })
        throw mapError(error)
      }
    },
    async update({ auth, sourceId: rawId, patch, request } = {}) {
      const actor = requireAdmin(auth)
      const previous = await current(auth, rawId)
      const attempt = updateAuditAttempt(previous, patch)
      let result
      try { result = applySourceUpdate(previous, patch, { now: nextMutationTime(previous, now()) }) } catch (error) {
        if (attempt) await recordFailed({ auth, actor, sourceId: previous.id, ...attempt, request })
        throw mapError(error)
      }
      const statusOnly = result.changedFields.length === 1 && result.changedFields[0] === 'operationalStatus'
      const audit = auditFor({ auth, actor, action: statusOnly ? 'source_status_updated' : 'source_configuration_updated', source: result.source, changedFields: result.changedFields, reasonCode: patch.reasonCode, request, stateTransition: result.stateTransition })
      try { return await commit(auth, previous, result, audit) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: statusOnly ? 'source_status_updated' : 'source_configuration_updated', changedFields: result.changedFields, reasonCode: patch.reasonCode, request, stateTransition: result.stateTransition })
        throw error
      }
    },
    async reviewPolicy({ auth, sourceId: rawId, review, request } = {}) {
      const actor = requireAdmin(auth)
      const previous = await current(auth, rawId)
      let result
      try { result = reviewSourcePolicy(previous, review, { reviewerId: actor._id ?? actor.id, now: nextMutationTime(previous, now()) }) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_policy_reviewed', changedFields: [...POLICY_REVIEW_AUDIT_FIELDS], reasonCode: 'source_policy_reviewed', request })
        throw mapError(error)
      }
      const audit = auditFor({ auth, actor, action: 'source_policy_reviewed', source: result.source, changedFields: result.changedFields, reasonCode: review.reasonCode, request })
      try { return await commit(auth, previous, result, audit) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_policy_reviewed', changedFields: result.changedFields, reasonCode: 'source_policy_reviewed', request })
        throw error
      }
    },
    async requestReReview({ auth, sourceId: rawId, request, idempotencyKey } = {}) {
      const actor = requireAdmin(auth)
      const previous = await current(auth, rawId)
      const actorId = actor._id ?? actor.id
      const replay = idempotencyKey && repository.findAuditReplay ? await repository.findAuditReplay({
        eventId: sourceAuditEventId('source_policy_re_review_requested', previous.id, idempotencyKey, actorId, auth.session?._id ?? auth.session?.id),
      }).catch((error) => { throw mapError(error) }) : null
      if (replay) {
        const sameIntent = replay.action === 'source_policy_re_review_requested' && String(replay.targetId) === String(previous.id) && String(replay.actorId) === String(actorId) && replay.requestId === idempotencyKey && replay.result === 'succeeded'
        const requestedAt = previous.reconciliation?.requestedAt
        if (sameIntent && previous.licenseStatus === 'review-needed' && previous.policyVersion === previous.reconciliation?.requiredPolicyVersion && requestedAt instanceof Date && replay.createdAt instanceof Date && requestedAt.getTime() === replay.createdAt.getTime()) return previous
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_policy_re_review_requested', changedFields: previous.operationalStatus === 'active' ? ['operationalStatus', ...RE_REVIEW_AUDIT_FIELDS] : [...RE_REVIEW_AUDIT_FIELDS], reasonCode: 'source_policy_re_review_requested', request, stateTransition: previous.operationalStatus === 'active' ? { from: 'active', to: 'paused' } : undefined })
        throw new SourceError(409, 'idempotency_mismatch', 'Idempotency key no longer matches current source state')
      }
      const attemptedFields = previous.operationalStatus === 'active' ? ['operationalStatus', ...RE_REVIEW_AUDIT_FIELDS] : [...RE_REVIEW_AUDIT_FIELDS]
      const attemptedTransition = previous.operationalStatus === 'active' ? { from: 'active', to: 'paused' } : undefined
      let result
      try { result = requestPolicyReReview(previous, { reviewerId: actorId, now: nextMutationTime(previous, now()) }) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_policy_re_review_requested', changedFields: attemptedFields, reasonCode: 'source_policy_re_review_requested', request, stateTransition: attemptedTransition, idempotencyKey })
        throw mapError(error)
      }
      const audit = auditFor({ auth, actor, action: 'source_policy_re_review_requested', source: result.source, changedFields: result.changedFields, reasonCode: 'source_policy_re_review_requested', request, stateTransition: result.stateTransition, idempotencyKey })
      try { return await commit(auth, previous, result, audit) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_policy_re_review_requested', changedFields: result.changedFields, reasonCode: 'source_policy_re_review_requested', request, stateTransition: result.stateTransition, idempotencyKey: error?.code === 'idempotency_mismatch' ? undefined : idempotencyKey })
        throw error
      }
    },
    async runTechnicalCheck({ auth, sourceId: rawId, request } = {}) {
      const actor = requireAdmin(auth)
      if (!technicalCheckAdapter?.run) throw new SourceError(503, 'service_unavailable', 'Technical check is unavailable until Step 4')
      const previous = await current(auth, rawId)
      if (typeof rateLimitAdmission?.reserve !== 'function') throw new SourceError(503, 'service_unavailable', 'Rate-limit service is unavailable')
      let admission
      try { admission = await rateLimitAdmission.reserve({ scope: 'source-test', subject: previous.id }) } catch { throw new SourceError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable') }
      if (!admission || typeof admission.allowed !== 'boolean') throw new SourceError(503, 'service_unavailable', 'Rate-limit service is temporarily unavailable')
      if (!admission.allowed) throw new SourceError(429, 'rate_limit_exceeded', 'Too many source technical checks', { retryAfter: admission.retryAfterSeconds })
      let adapterResult
      try { adapterResult = await technicalCheckAdapter.run({ source: technicalCheckInput(previous) }) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_technical_check_recorded', changedFields: ['technicalCheck'], reasonCode: 'source_technical_check_requested', request })
        throw new SourceError(503, 'service_unavailable', 'Technical check is unavailable', { cause: error })
      }
      const mutationAt = nextMutationTime(previous, now())
      let check
      try { check = validTechnicalCheck(adapterResult, mutationAt) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_technical_check_recorded', changedFields: ['technicalCheck'], reasonCode: 'source_technical_check_requested', request, createdAt: mutationAt })
        throw error
      }
      const result = { source: { ...previous, technicalCheck: check, updatedAt: mutationAt }, changedFields: ['technicalCheck'], versionChanged: false }
      const audit = auditFor({ auth, actor, action: 'source_technical_check_recorded', source: result.source, changedFields: result.changedFields, reasonCode: 'source_technical_check_requested', request })
      let saved
      try { saved = await commit(auth, previous, result, audit) } catch (error) {
        await recordFailed({ auth, actor, sourceId: previous.id, action: 'source_technical_check_recorded', changedFields: ['technicalCheck'], reasonCode: 'source_technical_check_requested', request })
        throw error
      }
      return { sourceId: saved.id, technicalCheck: saved.technicalCheck }
    },
  })
}
