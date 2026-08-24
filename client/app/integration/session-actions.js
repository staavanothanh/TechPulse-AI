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

export function withSessionRecovery(api, onSessionExpired) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(api).map(([name, operation]) => [
        name,
        async (...args) => {
          try {
            return await operation(...args)
          } catch (error) {
            if (isSessionAccessFailure(error))
              onSessionExpired?.('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.')
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
  createIdempotencyKey = () => `account-deletion-${Date.now()}`,
  redirect = redirectToGoogleAuth,
}) {
  async function authenticate({ mode, email, password }) {
    const operation = mode === 'register' ? api.registerUser : api.login
    const response = await operation({
      body: JSON.stringify({ email, password }),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    })
    applySession(response.data.user, response.data.csrfToken, null)
    return response
  }

  async function authenticateWithGoogle() {
    const response = await api.getGoogleAuthUrl({ credentials: 'same-origin' })
    redirect(validatedGoogleAuthUrl(response))
    return response
  }

  async function logout() {
    const csrfToken = getCsrfToken()
    await api.logout({ credentials: 'same-origin', headers: csrfHeaders(csrfToken) })
    applySession(null, null, null)
  }

  async function updatePreferences(topics) {
    const draft = validateTopicPreferences(topics)
    if (!draft.valid)
      throw Object.assign(new Error('Chủ đề quan tâm không hợp lệ.'), { status: 422 })
    const csrfToken = getCsrfToken()
    const response = await api.updatePreferences({
      body: JSON.stringify({ topicPreferences: draft.topics }),
      credentials: 'same-origin',
      headers: csrfHeaders(csrfToken, { 'Content-Type': 'application/json' }),
    })
    applySession(response.data, csrfToken, null)
    return response
  }

  async function requestDeletion() {
    const csrfToken = getCsrfToken()
    const response = await api.requestAccountDeletion({
      credentials: 'same-origin',
      headers: csrfHeaders(csrfToken, { 'Idempotency-Key': createIdempotencyKey() }),
    })
    applySession(null, null, DELETION_NOTICE)
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
