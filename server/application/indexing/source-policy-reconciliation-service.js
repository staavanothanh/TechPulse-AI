import { canonicalRequestHash, JobError } from '../../domain/jobs/idempotency.js'
import { ObjectId } from 'mongodb'
import { createSourceAuditEvent, sourceAuditEventId } from '../../audit/source-writer.js'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const DEFAULT_LIMIT = 100
const DEFAULT_MAX_PAGES = 10

function requireAdmin(auth) {
  if (!auth?.user) throw new JobError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status && auth.user.status !== 'active') throw new JobError(403, 'forbidden', 'Administrator role is required')
  return auth.user
}

function sourceId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value) || new ObjectId(value).toHexString() !== value.toLowerCase()) throw new JobError(400, 'bad_request', 'sourceId is invalid')
  return value.toLowerCase()
}

function key(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw new JobError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}

function positiveBound(value, label, maximum) {
  if (value === undefined) return undefined
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new JobError(422, 'validation_error', `${label} is invalid`)
  return result
}

function actorFence(auth) {
  return { userId: auth.user.id ?? auth.user._id, sessionId: auth.session?.id ?? auth.session?._id, sessionVersion: auth.session?.userSessionVersion }
}

function reconciliationRequestHash({ sourceId, limit, maxPages, reasonCode }) {
  return canonicalRequestHash({ operation: 'source-policy-reconciliation', sourceId, limit, maxPages, reasonCode })
}

function replayReport(report) {
  return {
    ...report,
    outcome: 'skipped',
    mode: 'execute',
    inspected: 0,
    staleArticleCount: 0,
    wouldCreate: 0,
    created: 0,
    pages: 0,
    hasMore: false,
    jobs: [],
    skippedReasons: ['idempotency_replay'],
    failedReasons: [],
  }
}

async function claimReconciliationRequest({ sourceRepository, actorId, requestKey, expectedEventId, audit, actorFence, rateLimitAdmission, admission }) {
  const sameRequest = async () => sourceRepository.findReconciliationRequest({ actorId, requestId: requestKey })
  const assertSameIntent = (existing) => {
    if (existing && existing.eventId !== expectedEventId) throw new JobError(409, 'idempotency_mismatch', 'Idempotency key was reused for a different reconciliation request')
    return existing
  }
  if (assertSameIntent(await sameRequest())) return false
  try {
    const committed = await sourceRepository.commitReconciliationAudit({ audit, actorFence, rateLimitAdmission, admission })
    return committed?.replay !== true
  } catch (error) {
    if (error?.code !== 11000) throw error
    if (assertSameIntent(await sameRequest())) return false
    throw error
  }
}

export function createSourcePolicyReconciliationService({ worker, sourceRepository, rateLimitAdmission, now = () => new Date() } = {}) {
  if (!worker || typeof worker.run !== 'function') throw new Error('Source policy reconciliation worker is required')
  if (!sourceRepository || typeof sourceRepository.findReconciliationRequest !== 'function' || typeof sourceRepository.commitReconciliationAudit !== 'function') throw new Error('Source policy reconciliation audit repository is required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  return Object.freeze({
    async preview({ auth, sourceId: rawSourceId, limit } = {}) {
      requireAdmin(auth)
      const sourceIdValue = sourceId(rawSourceId)
      if (!await sourceRepository.findSourceById(sourceIdValue)) throw new JobError(404, 'not_found', 'Source not found')
      const boundedLimit = positiveBound(limit, 'limit', 100)
      return worker.run({ sourceId: sourceIdValue, dryRun: true, ...(boundedLimit === undefined ? {} : { limit: boundedLimit }) })
    },
    async execute({ auth, sourceId: rawSourceId, limit, maxPages, reasonCode, idempotencyKey } = {}) {
      const actor = requireAdmin(auth)
      if (reasonCode !== 'source_policy_reconciliation_requested') throw new JobError(422, 'validation_error', 'reasonCode must match source policy reconciliation')
      const requestKey = key(idempotencyKey)
      const sourceIdValue = sourceId(rawSourceId)
      if (!await sourceRepository.findSourceById(sourceIdValue)) throw new JobError(404, 'not_found', 'Source not found')
      const boundedLimit = positiveBound(limit, 'limit', DEFAULT_LIMIT) ?? DEFAULT_LIMIT
      const boundedMaxPages = positiveBound(maxPages, 'maxPages', DEFAULT_MAX_PAGES) ?? DEFAULT_MAX_PAGES
      const actorId = actor.id ?? actor._id
      const actorSessionId = auth.session?.id ?? auth.session?._id
      const requestHash = reconciliationRequestHash({ sourceId: sourceIdValue, limit: boundedLimit, maxPages: boundedMaxPages, reasonCode })
      const expectedEventId = sourceAuditEventId('source_policy_reconciliation_requested', sourceIdValue, requestKey, actorId, actorSessionId, requestHash)
      const existing = await sourceRepository.findReconciliationRequest({ actorId, requestId: requestKey })
      if (existing && existing.eventId !== expectedEventId) throw new JobError(409, 'idempotency_mismatch', 'Idempotency key was reused for a different reconciliation request')
      if (existing) return replayReport(await worker.run({ sourceId: sourceIdValue, dryRun: true, limit: boundedLimit }))
      const createdAt = now()
      if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new JobError(503, 'service_unavailable', 'Reconciliation clock is unavailable')
      const audit = createSourceAuditEvent({
        actor, action: 'source_policy_reconciliation_requested', targetId: sourceIdValue, changedFields: ['reconciliation'],
        reasonCode, request: { serverRequestId: requestKey, idempotencyKey: requestKey, actorSessionId, requestHash }, result: 'pending', createdAt,
      })
      const claimed = await claimReconciliationRequest({ sourceRepository, actorId, requestKey, expectedEventId, audit, actorFence: actorFence(auth), rateLimitAdmission, admission: { scope: 'admin-trigger', subject: String(actorId) } })
      if (!claimed) return replayReport(await worker.run({ sourceId: sourceIdValue, dryRun: true, limit: boundedLimit }))
      return worker.run({ sourceId: sourceIdValue, dryRun: false, limit: boundedLimit, maxPages: boundedMaxPages })
    },
  })
}
