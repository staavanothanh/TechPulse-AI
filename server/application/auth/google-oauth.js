import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GMAIL_DOMAIN = 'gmail.com'
const STATE_TTL_SECONDS = 10 * 60
const STATE_PATTERN = /^[0-9]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const SUBJECT_PATTERN = /^[A-Za-z0-9._-]{1,255}$/
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_AUTH_CODE_LENGTH = 2_048
const MAX_ACCESS_TOKEN_LENGTH = 4_096
const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 256
const MAX_PICTURE_LENGTH = 2_048

export class GoogleOAuthError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.status = status
    this.code = code
  }
}

function resolveClientId(clientId, clientIdEnv, values) {
  if (clientId) return clientId
  if (clientIdEnv && values[clientIdEnv]) return values[clientIdEnv]
  return undefined
}

function resolveClientSecret(clientSecret, clientSecretEnv, values) {
  if (clientSecret) return clientSecret
  if (clientSecretEnv && values[clientSecretEnv]) return values[clientSecretEnv]
  return undefined
}

function resolveSecret(secret, secretEnv, values) {
  const resolved = secret || (secretEnv && values[secretEnv])
  if (typeof resolved !== 'string' || Buffer.byteLength(resolved, 'utf8') < 32) {
    throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth state secret is not configured')
  }
  return resolved
}

function validDate(now) {
  return now instanceof Date && Number.isFinite(now.getTime())
}

function boundedString(value, maximum, code = 'invalid_user_info') {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new GoogleOAuthError(422, code, 'Google user information is invalid')
  }
  return value
}

function optionalBoundedString(value, maximum) {
  if (value === undefined || value === null) return null
  return boundedString(value, maximum)
}

function signedStatePayload(expiresAt, nonce) {
  return `${expiresAt}.${nonce}`
}

function stateSignature(payload, secret) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
}

function sameSecretValue(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false
  let receivedBuffer
  let expectedBuffer
  try {
    receivedBuffer = Buffer.from(received, 'base64url')
    expectedBuffer = Buffer.from(expected, 'base64url')
  } catch {
    return false
  }
  // Reject non-canonical base64url aliases. Comparing decoded bytes alone
  // would allow a modified signature with equivalent trailing bits.
  if (receivedBuffer.toString('base64url') !== received || expectedBuffer.toString('base64url') !== expected) return false
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer)
}

function stateError(code, message) {
  return new GoogleOAuthError(code === 'oauth_state_replayed' ? 409 : 403, code, message)
}

export function createGoogleOAuthService({
  clientId,
  clientIdEnv,
  clientSecret,
  clientSecretEnv,
  redirectUri,
  redirectUriEnv,
  stateSecret,
  stateSecretEnv,
  values = process.env,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  fetchImpl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stateTtlSeconds = STATE_TTL_SECONDS,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Google OAuth timeout is invalid')
  if (!Number.isInteger(stateTtlSeconds) || stateTtlSeconds < 60 || stateTtlSeconds > 900) throw new Error('Google OAuth state TTL is invalid')

  function getClientId() {
    const resolved = resolveClientId(clientId, clientIdEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  function getClientSecret() {
    const resolved = resolveClientSecret(clientSecret, clientSecretEnv, values)
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth is not configured')
    return resolved
  }

  function getRedirectUri() {
    const resolved = redirectUri || (redirectUriEnv && values[redirectUriEnv])
    if (!resolved) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth redirect URI is not configured')
    return resolved
  }

  function getStateSecret() {
    return resolveSecret(stateSecret, stateSecretEnv, values)
  }

  function createState() {
    const current = now()
    if (!validDate(current)) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth clock is unavailable')
    const expiresAt = Math.floor(current.getTime() / 1000) + stateTtlSeconds
    const nonce = randomBytesImpl(24).toString('base64url')
    const payload = signedStatePayload(expiresAt, nonce)
    return `${payload}.${stateSignature(payload, getStateSecret())}`
  }

  function verifyState(state) {
    if (typeof state !== 'string' || state.length > 512 || !STATE_PATTERN.test(state)) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const [expiresAtText, nonce, signature] = state.split('.')
    const expiresAt = Number(expiresAtText)
    if (!Number.isSafeInteger(expiresAt) || !nonce || !signature) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const payload = signedStatePayload(expiresAt, nonce)
    const expected = stateSignature(payload, getStateSecret())
    if (!sameSecretValue(signature, expected)) throw stateError('oauth_state_invalid', 'OAuth state is invalid')
    const current = now()
    if (!validDate(current)) throw new GoogleOAuthError(503, 'service_unavailable', 'Google OAuth clock is unavailable')
    if (expiresAt <= Math.floor(current.getTime() / 1000)) throw stateError('oauth_state_expired', 'OAuth state has expired')
    return { expiresAt, nonce }
  }

  function generateAuthUrl({ state, scope = 'openid email profile' } = {}) {
    const params = new URLSearchParams({
      client_id: getClientId(),
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      scope,
    })
    if (state) params.set('state', state)
    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
  }

  async function fetchProvider(url, init = {}, signal) {
    const request = fetchImpl ?? globalThis.fetch
    if (typeof request !== 'function') throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider is unavailable')
    const controller = new globalThis.AbortController()
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
    const forwardAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener?.('abort', forwardAbort, { once: true })
    try {
      return await request(url, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw new GoogleOAuthError(502, 'oauth_provider_timeout', 'Google OAuth provider timed out')
      }
      throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider is unavailable')
    } finally {
      globalThis.clearTimeout(timer)
      signal?.removeEventListener?.('abort', forwardAbort)
    }
  }

  async function parseProviderJson(response) {
    if (!response?.ok) return null
    try {
      const payload = await response.json()
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null
    } catch {
      throw new GoogleOAuthError(502, 'oauth_provider_error', 'Google OAuth provider returned invalid data')
    }
  }

  async function exchangeCodeForTokens(code, { signal } = {}) {
    if (typeof code !== 'string' || code.length < 1 || code.length > MAX_AUTH_CODE_LENGTH) throw new GoogleOAuthError(422, 'validation_error', 'Authorization code is invalid')
    const body = new URLSearchParams({
      code,
      client_id: getClientId(),
      client_secret: getClientSecret(),
      redirect_uri: getRedirectUri(),
      grant_type: 'authorization_code',
    })
    const response = await fetchProvider(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, signal)
    if (!response?.ok) throw new GoogleOAuthError(401, 'invalid_oauth_code', 'Authorization code is invalid')
    const tokens = await parseProviderJson(response)
    const accessToken = boundedString(tokens?.access_token, MAX_ACCESS_TOKEN_LENGTH, 'invalid_access_token')
    return { ...tokens, access_token: accessToken }
  }

  async function getUserInfo(accessToken, { signal } = {}) {
    const token = boundedString(accessToken, MAX_ACCESS_TOKEN_LENGTH, 'invalid_access_token')
    const response = await fetchProvider(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
    }, signal)
    if (!response?.ok) throw new GoogleOAuthError(401, 'invalid_access_token', 'Google access token is invalid')
    const payload = await parseProviderJson(response)
    if (!payload) throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    return payload
  }

  async function verifyGoogleUser(code, { signal } = {}) {
    const tokens = await exchangeCodeForTokens(code, { signal })
    const userInfo = await getUserInfo(tokens.access_token, { signal })
    const email = boundedString(userInfo.email, MAX_EMAIL_LENGTH).trim().toLowerCase()
    // The v2 userinfo endpoint returns `id`; OIDC-compatible deployments may
    // return the equivalent stable `sub` claim. Accept either, but never use
    // an email address as the identity key.
    const sub = boundedString(userInfo.sub ?? userInfo.id, 255)
    if (!SUBJECT_PATTERN.test(sub)) throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    if (typeof userInfo.verified_email !== 'boolean') throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
    if (!userInfo.verified_email) throw new GoogleOAuthError(422, 'unverified_email', 'Google email is not verified')
    if (!email.endsWith(`@${GMAIL_DOMAIN}`)) throw new GoogleOAuthError(422, 'non_gmail_address', 'Only Gmail addresses are supported')
    const name = optionalBoundedString(userInfo.name, MAX_NAME_LENGTH)
    const picture = optionalBoundedString(userInfo.picture, MAX_PICTURE_LENGTH)
    if (picture) {
      try {
        const parsed = new URL(picture)
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid picture')
      } catch {
        throw new GoogleOAuthError(422, 'invalid_user_info', 'Google user information is invalid')
      }
    }
    return { email, emailVerified: true, name, picture, sub }
  }

  return Object.freeze({
    generateAuthUrl,
    createState,
    verifyState,
    exchangeCodeForTokens,
    getUserInfo,
    verifyGoogleUser,
    isConfigured() {
      const configuredStateSecret = stateSecret || (stateSecretEnv && values[stateSecretEnv])
      return Boolean(
        resolveClientId(clientId, clientIdEnv, values) &&
        resolveClientSecret(clientSecret, clientSecretEnv, values) &&
        (redirectUri || (redirectUriEnv && values[redirectUriEnv])) &&
        typeof configuredStateSecret === 'string' &&
        Buffer.byteLength(configuredStateSecret, 'utf8') >= 32,
      )
    },
  })
}

export { GMAIL_DOMAIN, STATE_TTL_SECONDS }
