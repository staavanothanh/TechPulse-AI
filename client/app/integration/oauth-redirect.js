export const OAUTH_REDIRECT_ERROR_MESSAGES = Object.freeze({
  conflict: 'Account already exists',
  account_suspended: 'This account has been suspended',
  oauth_identity_conflict: 'Email account requires explicit Google linking',
  oauth_provider_error: 'Google OAuth verification failed',
  rate_limit_exceeded: 'Too many attempts. Please try again later.',
})

const GENERIC_REDIRECT_ERROR = 'Sign-in could not be completed. Please try again.'
const OAUTH_REDIRECT_STATUS = Object.freeze({
  conflict: 409,
  account_suspended: 403,
  oauth_identity_conflict: 409,
  oauth_provider_error: 502,
})

function isKnownMarker(marker) {
  return typeof marker === 'string' && Object.hasOwn(OAUTH_REDIRECT_ERROR_MESSAGES, marker)
}

export function authErrorForRedirect(marker) {
  if (!isKnownMarker(marker)) return null
  const status = OAUTH_REDIRECT_STATUS[marker] ?? 400
  const error = new Error(OAUTH_REDIRECT_ERROR_MESSAGES[marker])
  error.status = status
  error.code = marker
  return error
}

export function genericOAuthRedirectError() {
  const error = new Error(GENERIC_REDIRECT_ERROR)
  error.status = 400
  error.code = 'oauth_redirect_failed'
  return error
}
