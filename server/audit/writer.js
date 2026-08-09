export const AUDIT_RULES = Object.freeze({
  user_registered: Object.freeze({ reasonCode: 'user_registered', changedFields: ['status'] }),
  user_logged_in: Object.freeze({ reasonCode: 'user_login', changedFields: [] }),
  user_logged_out: Object.freeze({ reasonCode: 'user_logout', changedFields: [] }),
  user_preferences_updated: Object.freeze({ reasonCode: 'preferences_updated', changedFields: ['topicPreferences'] }),
  user_suspended: Object.freeze({ reasonCode: 'user_suspended', changedFields: ['status', 'sessionVersion'] }),
  user_restored: Object.freeze({ reasonCode: 'user_restored', changedFields: ['status', 'sessionVersion'] }),
})

export function createAuditEvent({ actor, action, targetId, changedFields = [], reasonCode, request, result = 'succeeded', stateTransition } = {}) {
  const rule = AUDIT_RULES[action]
  if (!rule || reasonCode !== rule.reasonCode || changedFields.length !== rule.changedFields.length || changedFields.some((field, index) => field !== rule.changedFields[index])) throw new Error('audit action or reason code is not allowlisted')
  if (stateTransition && !((action === 'user_suspended' && stateTransition.from === 'active' && stateTransition.to === 'suspended') || (action === 'user_restored' && stateTransition.from === 'suspended' && stateTransition.to === 'active'))) throw new Error('audit state transition is not allowlisted')
  const requestId = request?.serverRequestId ?? 'system'
  if (!targetId || !actor?._id && !actor?.id) throw new Error('audit actor and target are required')
  const event = {
    eventId: `${action}:${String(targetId)}:${requestId}`,
    actorType: actor.role === 'admin' ? 'admin' : 'user',
    actorId: actor._id ?? actor.id,
    action,
    targetType: 'user',
    targetId,
    changedFields: [...changedFields],
    reasonCode,
    requestId,
    result,
    createdAt: new Date(),
  }
  if (stateTransition) event.stateTransition = { from: stateTransition.from, to: stateTransition.to }
  return event
}
