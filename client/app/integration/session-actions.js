import {
  bootstrapSessionFailure,
  validateTopicPreferences,
} from '../../features/auth/session-state.js'
import { isSessionAccessFailure } from './routing.js'

const DELETION_NOTICE = 'Yêu cầu xóa tài khoản đã được chấp nhận. Phiên của bạn đã bị thu hồi.'
const GOOGLE_AUTH_URL_ERROR = 'Không thể bắt đầu đăng nhập bằng Google.'

function redirectToGoogleAuth(authUrl) {
  if (typeof globalThis.location?.assign !== 'function')
    throw new Error('Không thể chuyển hướng đến Google trong môi trường hiện tại.')
  globalThis.location.assign(authUrl)
}

function validatedGoogleAuthUrl(response) {
  const authUrl = response?.data?.authUrl
  if (typeof authUrl !== 'string' || authUrl.length === 0) throw new Error(GOOGLE_AUTH_URL_ERROR)
  try {
    const parsed = new URL(authUrl)
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported URL scheme')
  } catch {
    throw new Error(GOOGLE_AUTH_URL_ERROR)
  }
  return authUrl
}

function csrfHeaders(csrfToken, extra = {}) {
  if (!csrfToken)
    throw Object.assign(new Error('Phiên đăng nhập không còn hợp lệ.'), { status: 401 })
  return { ...extra, 'X-CSRF-Token': csrfToken }
}

export function recoverBootstrapSession(error) {
  return bootstrapSessionFailure(error)
}

export function withSessionRecovery(api, onSessionExpired, { getSessionIdentity, isSessionIdentityCurrent, getSessionEpoch, isSessionEpochCurrent } = {}) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(api).map(([name, operation]) => [
        name,
        async (...args) => {
          const requestIdentity = getSessionIdentity?.()
          const requestEpoch = getSessionEpoch?.()
          try {
            return await operation(...args)
          } catch (error) {
            const identityIsCurrent = !isSessionIdentityCurrent || isSessionIdentityCurrent(requestIdentity)
            const epochIsCurrent = !isSessionEpochCurrent || isSessionEpochCurrent(requestEpoch)
            if (isSessionAccessFailure(error) && identityIsCurrent && epochIsCurrent)
              onSessionExpired?.('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.', requestIdentity, requestEpoch)
            throw error
          }
        },
      ]),
    ),
  )
}
export function createSessionActions({
  api,
  getCsrfToken,
  applySession,
  commitSession = (...values) => applySession(...values.slice(0, 3)),
  beginSessionTransition = () => null,
  isSessionTransitionCurrent = () => true,
  createIdempotencyKey = () => `account-deletion-${Date.now()}`,
  redirect = redirectToGoogleAuth,
}) {
  function startTransition() {
    return beginSessionTransition()
  }

  function canCommit(transition) {
    return transition === null || transition === undefined || isSessionTransitionCurrent(transition)
  }

  async function authenticate({ mode, email, password }) {
    const transition = startTransition()
    const operation = mode === 'register' ? api.registerUser : api.login
    const response = await operation({
      body: JSON.stringify({ email, password }),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    })
    if (canCommit(transition)) commitSession(response.data.user, response.data.csrfToken, null, transition)
    return response
  }

  async function authenticateWithGoogle() {
    startTransition()
    const response = await api.getGoogleAuthUrl({ credentials: 'same-origin' })
    redirect(validatedGoogleAuthUrl(response))
    return response
  }

  async function logout() {
    const transition = startTransition()
    const csrfToken = getCsrfToken()
    await api.logout({ credentials: 'same-origin', headers: csrfHeaders(csrfToken) })
    if (canCommit(transition)) commitSession(null, null, null, transition)
  }

  async function updatePreferences(topics) {
    const draft = validateTopicPreferences(topics)
    if (!draft.valid)
      throw Object.assign(new Error('Chủ đề quan tâm không hợp lệ.'), { status: 422 })
    const transition = startTransition()
    const csrfToken = getCsrfToken()
    const response = await api.updatePreferences({
      body: JSON.stringify({ topicPreferences: draft.topics }),
      credentials: 'same-origin',
      headers: csrfHeaders(csrfToken, { 'Content-Type': 'application/json' }),
    })
    if (canCommit(transition)) commitSession(response.data, csrfToken, null, transition)
    return response
  }

  async function requestDeletion() {
    const transition = startTransition()
    const csrfToken = getCsrfToken()
    const response = await api.requestAccountDeletion({
      credentials: 'same-origin',
      headers: csrfHeaders(csrfToken, { 'Idempotency-Key': createIdempotencyKey() }),
    })
    if (canCommit(transition)) commitSession(null, null, DELETION_NOTICE, transition)
    return response
  }

  return Object.freeze({
    authenticate,
    authenticateWithGoogle,
    logout,
    requestDeletion,
    updatePreferences,
  })
}
