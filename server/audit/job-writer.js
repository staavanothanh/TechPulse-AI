import { createHash } from 'node:crypto'

const JOB_AUDIT_RULES = Object.freeze({
  ingestion_job_created: Object.freeze({ reasonCode: 'ingestion_trigger_requested', exactFields: ['status'] }),
  ingestion_job_retry_created: Object.freeze({ reasonCode: 'job_retry_requested', exactFields: ['status', 'attempt', 'parentJobId'] }),
  ingestion_job_cancelled: Object.freeze({ reasonCode: 'job_cancel_requested', exactFields: ['status'] }),
  ingestion_job_cancellation_requested: Object.freeze({ reasonCode: 'job_cancel_requested', exactFields: ['cancellationRequestedAt'] }),
  ingestion_job_lease_recovered: Object.freeze({ reasonCode: 'lease_expired_recovered', exactFields: ['status', 'error'], systemOnly: true }),
})

function sameFields(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

export function validateJobAuditInput({ action, changedFields, reasonCode, actorType } = {}) {
  const rule = JOB_AUDIT_RULES[action]
  if (!rule || rule.reasonCode !== reasonCode || !sameFields(changedFields, rule.exactFields)) throw new Error('Job audit action, reason or changed fields are not allowlisted')
  if (rule.systemOnly && actorType !== undefined && actorType !== 'system-worker') throw new Error('Job audit actor is not allowlisted')
  return true
}

function eventId({ action, targetId, requestIdentity, actorId, sessionId }) {
  return `job:${createHash('sha256').update(`${action}\u0000${targetId}\u0000${requestIdentity}\u0000${actorId}\u0000${sessionId ?? 'no-session'}`).digest('hex')}`
}

export function createJobAuditEvent({ actor, action, targetId, changedFields, reasonCode, request, result = 'succeeded', createdAt = new Date() } = {}) {
  const actorType = actor?.role === 'admin' ? 'admin' : actor?.role === 'system-worker' ? 'system-worker' : null
  validateJobAuditInput({ action, changedFields, reasonCode, actorType })
  const actorId = actor?._id ?? actor?.id
  const requestIdentity = request?.idempotencyKey ?? request?.serverRequestId
  const sessionId = request?.actorSessionId
  if (!actorType || !actorId || !targetId || !requestIdentity || !['succeeded', 'failed', 'pending'].includes(result) || !(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Error('Job audit identity is invalid')
  return {
    eventId: eventId({ action, targetId, requestIdentity, actorId, sessionId }),
    actorType, actorId, action, targetType: 'ingestion-job', targetId,
    changedFields: [...changedFields], reasonCode, requestId: String(requestIdentity), result, createdAt,
  }
}

export { JOB_AUDIT_RULES }
