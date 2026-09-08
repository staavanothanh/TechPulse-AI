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
  let sessionMutationTail = null
  let currentCsrfToken

  function readCsrfToken() {
    if (currentCsrfToken === undefined) currentCsrfToken = getCsrfToken()
    return currentCsrfToken
  }

  function enqueueSessionMutation(operation) {
    let next
    if (sessionMutationTail === null) {
      try { next = Promise.resolve(operation()) } catch (error) { next = Promise.reject(error) }
    } else {
      next = sessionMutationTail.then(operation, operation)
    }
    sessionMutationTail = next
    next.finally(() => {
      if (sessionMutationTail === next) sessionMutationTail = null
    }).catch(() => undefined)
    return next
  }

  function startTransition() {
    return beginSessionTransition()
  }

  function canCommit(transition) {
    return transition === null || transition === undefined || isSessionTransitionCurrent(transition)
  }

  function commitSessionState(nextUser, nextCsrfToken, nextNotice, transition) {
    const result = commitSession(nextUser, nextCsrfToken, nextNotice, transition)
    if (nextCsrfToken !== undefined) currentCsrfToken = nextCsrfToken
    return result
  }

  async function authenticate({ mode, email, password }) {
    return enqueueSessionMutation(async () => {
      const transition = startTransition()
      const operation = mode === 'register' ? api.registerUser : api.login
      const response = await operation({
        body: JSON.stringify({ email, password }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      })
      if (canCommit(transition)) commitSessionState(response.data.user, response.data.csrfToken, null, transition)
      return response
    })
  }

  async function authenticateWithGoogle() {
    startTransition()
    const response = await api.getGoogleAuthUrl({ credentials: 'same-origin' })
    redirect(validatedGoogleAuthUrl(response))
    return response
  }

  async function logout() {
    return enqueueSessionMutation(async () => {
      const transition = startTransition()
      const csrfToken = readCsrfToken()
      await api.logout({ credentials: 'same-origin', headers: csrfHeaders(csrfToken) })
      if (canCommit(transition)) commitSessionState(null, null, null, transition)
    })
  }

  async function updatePreferences(topics) {
    const draft = validateTopicPreferences(topics)
    if (!draft.valid)
      throw Object.assign(new Error('Chủ đề quan tâm không hợp lệ.'), { status: 422 })
    return enqueueSessionMutation(async () => {
      const transition = startTransition()
      const csrfToken = readCsrfToken()
      const response = await api.updatePreferences({
        body: JSON.stringify({ topicPreferences: draft.topics }),
        credentials: 'same-origin',
        headers: csrfHeaders(csrfToken, { 'Content-Type': 'application/json' }),
      })
      if (canCommit(transition)) commitSessionState(response.data, csrfToken, null, transition)
      return response
    })
  }

  async function requestDeletion() {
    return enqueueSessionMutation(async () => {
      const transition = startTransition()
      const csrfToken = readCsrfToken()
      const response = await api.requestAccountDeletion({
        credentials: 'same-origin',
        headers: csrfHeaders(csrfToken, { 'Idempotency-Key': createIdempotencyKey() }),
      })
      if (canCommit(transition)) commitSessionState(null, null, DELETION_NOTICE, transition)
      return response
    })
  }

  // Đổi/đặt mật khẩu: server thu hồi mọi session cũ và cấp lại MỘT session mới,
  // nên phải commit user + CSRF token MỚI (token cũ đã hết hiệu lực).
  // currentPassword chỉ gửi khi tài khoản đã có mật khẩu thật (OAuth-only bỏ trống).
  async function changePassword({ currentPassword, newPassword } = {}) {
    return enqueueSessionMutation(async () => {
      const transition = startTransition()
      const csrfToken = readCsrfToken()
      const body = newPassword === undefined ? {} : { newPassword }
      if (currentPassword !== undefined && currentPassword !== null) body.currentPassword = currentPassword
      const response = await api.changePassword({
        body: JSON.stringify(body),
        credentials: 'same-origin',
        headers: csrfHeaders(csrfToken, { 'Content-Type': 'application/json' }),
      })
      if (canCommit(transition)) commitSessionState(response.data.user, response.data.csrfToken, null, transition)
      return response
    })
  }

  return Object.freeze({
    authenticate,
    authenticateWithGoogle,
    logout,
    requestDeletion,
    updatePreferences,
    changePassword,
  })
}
