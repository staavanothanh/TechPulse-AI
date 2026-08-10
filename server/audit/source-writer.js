import { createHash } from 'node:crypto'

const CONFIGURATION_FIELDS = new Set(['name', 'publisherName', 'domain', 'authorityTier', 'connectorConfig', 'mediaPolicy', 'attributionRequired', 'attributionText', 'operationalStatus', 'technicalCheck'])
const POLICY_REVIEW_FIELDS = ['licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'attributionText', 'termsUrl', 'licenseUrl', 'evidenceNote', 'reviewedAt', 'reviewedBy', 'policyVersion']
const RE_REVIEW_FIELDS = new Set(['operationalStatus', 'licenseStatus', 'llmInputScope', 'storageScope', 'reviewedAt', 'reviewedBy', 'policyVersion'])
const STATUS_TRANSITIONS = new Set(['draft:testing', 'testing:active', 'testing:paused', 'active:paused', 'paused:active', 'paused:archived'])
const SOURCE_STATUSES = new Set(['draft', 'testing', 'active', 'paused', 'archived'])

export const SOURCE_AUDIT_RULES = Object.freeze({
  source_created: Object.freeze({ reasonCode: 'source_created', exactFields: ['sourceKey', 'operationalStatus', 'policyVersion'] }),
  source_configuration_updated: Object.freeze({ reasonCode: 'source_configuration_changed', allowedFields: CONFIGURATION_FIELDS }),
  source_status_updated: Object.freeze({ reasonCode: 'source_status_changed', exactFields: ['operationalStatus'], requiresTransition: true }),
  source_policy_reviewed: Object.freeze({ reasonCode: 'source_policy_reviewed', exactFields: POLICY_REVIEW_FIELDS }),
  source_policy_re_review_requested: Object.freeze({ reasonCode: 'source_policy_re_review_requested', allowedFields: RE_REVIEW_FIELDS }),
  source_technical_check_recorded: Object.freeze({ reasonCode: 'source_technical_check_requested', exactFields: ['technicalCheck'] }),
})

function sameFields(actual, expected) {
  return actual.length === expected.length && actual.every((field, index) => field === expected[index])
}

function validateTransition(action, transition, result) {
  if (result === 'failed' && ['source_status_updated', 'source_configuration_updated'].includes(action)) return action === 'source_configuration_updated' && !transition || transition && SOURCE_STATUSES.has(transition.from) && SOURCE_STATUSES.has(transition.to)
  if (action === 'source_status_updated') return transition && STATUS_TRANSITIONS.has(`${transition.from}:${transition.to}`)
  if (action === 'source_configuration_updated') return !transition || STATUS_TRANSITIONS.has(`${transition.from}:${transition.to}`)
  if (action === 'source_policy_re_review_requested') return !transition || transition.from === 'active' && transition.to === 'paused'
  return transition === undefined
}

function deterministicEventId(action, targetId, requestId, actorId, sessionId) {
  return `source:${createHash('sha256').update(`${action}\u0000${targetId}\u0000${requestId}\u0000${actorId}\u0000${sessionId ?? 'no-session'}`).digest('hex')}`
}

function deterministicIdempotencyEventId(requestId, actorId, sessionId) {
  return `source:${createHash('sha256').update(`source-re-review\u0000${actorId}\u0000${sessionId}\u0000${requestId}`).digest('hex')}`
}

export function sourceAuditEventId(action, targetId, requestId, actorId, sessionId) {
  if (!SOURCE_AUDIT_RULES[action] || !targetId || !requestId || !actorId) throw new Error('source audit identity is invalid')
  if (action === 'source_policy_re_review_requested') {
    if (!sessionId) throw new Error('source audit session identity is invalid')
    return deterministicIdempotencyEventId(String(requestId), String(actorId), String(sessionId))
  }
  return deterministicEventId(action, String(targetId), String(requestId), String(actorId), sessionId ? String(sessionId) : undefined)
}

export function validateSourceAuditInput({ action, changedFields, reasonCode, stateTransition, result = 'succeeded' }) {
  const rule = SOURCE_AUDIT_RULES[action]
  if (!rule || rule.reasonCode !== reasonCode || !Array.isArray(changedFields) || changedFields.length === 0) throw new Error('source audit action or reason code is not allowlisted')
  if (rule.exactFields && !sameFields(changedFields, rule.exactFields)) throw new Error('source audit changed fields are not allowlisted')
  if (rule.allowedFields && (new Set(changedFields).size !== changedFields.length || changedFields.some((field) => !rule.allowedFields.has(field)))) throw new Error('source audit changed fields are not allowlisted')
  if (action === 'source_configuration_updated') {
    const hasOperationalStatus = changedFields.includes('operationalStatus')
    if (changedFields.every((field) => field === 'operationalStatus') || hasOperationalStatus !== Boolean(stateTransition)) throw new Error('source configuration audit transition is not allowlisted')
  }
  if (rule.requiresTransition && !stateTransition || !validateTransition(action, stateTransition, result)) throw new Error('source audit state transition is not allowlisted')
  return true
}

export function createSourceAuditEvent({ actor, action, targetId, changedFields, reasonCode, request, result = 'succeeded', stateTransition, createdAt = new Date() } = {}) {
  validateSourceAuditInput({ action, changedFields, reasonCode, stateTransition, result })
  const actorId = actor?._id ?? actor?.id
  const requestId = request?.idempotencyKey ?? request?.serverRequestId
  const actorType = actor?.role === 'admin' ? 'admin' : actor?.role === 'system-worker' ? 'system-worker' : null
  if (!actorId || !actorType || actorType === 'system-worker' && action !== 'source_created' || !targetId || !requestId) throw new Error('source audit identity is invalid')
  if (!['succeeded', 'failed'].includes(result)) throw new Error('source audit result is invalid')
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Error('source audit timestamp is invalid')
  const event = {
    eventId: sourceAuditEventId(action, targetId, requestId, actorId, request?.actorSessionId),
    actorType, actorId, action, targetType: 'source', targetId,
    changedFields: [...changedFields], reasonCode, requestId: String(requestId), result, createdAt,
  }
  if (stateTransition) event.stateTransition = { from: stateTransition.from, to: stateTransition.to }
  return event
}
