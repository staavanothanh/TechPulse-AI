const SCOPE_SUBJECTS = Object.freeze({
  login: 'ip',
  register: 'ip',
  'answer-minute': 'user',
  'answer-daily': 'user',
  'admin-trigger': 'admin',
  'source-test': 'source',
})

export const RATE_LIMITS = Object.freeze({
  login: Object.freeze({ limit: 10, windowSeconds: 15 * 60 }),
  register: Object.freeze({ limit: 5, windowSeconds: 60 * 60 }),
  'answer-minute': Object.freeze({ limit: 10, windowSeconds: 60 }),
  'answer-daily': Object.freeze({ limit: 100, windowSeconds: 24 * 60 * 60 }),
  'admin-trigger': Object.freeze({ limit: 20, windowSeconds: 60 }),
  'source-test': Object.freeze({ limit: 10, windowSeconds: 60 }),
})

export function isScopeSubjectPairValid(scope, subjectType) {
  return SCOPE_SUBJECTS[scope] === subjectType
}

export function subjectTypeForScope(scope) {
  return SCOPE_SUBJECTS[scope]
}

export function rateLimitForScope(scope) {
  return RATE_LIMITS[scope]
}

export { SCOPE_SUBJECTS }
