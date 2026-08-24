import { randomBytes } from 'node:crypto'
import { csrfTokenForSession, hashCsrfToken, hashSessionToken, createSessionToken, verifyCsrfToken } from '../../security/session-token.js'
import { hashPassword, verifyPassword } from '../../security/password.js'
import { createHmacKeyring } from '../../security/hmac-keyring.js'
import { createAuditEvent } from '../../audit/writer.js'
import { createGoogleOAuthService, GoogleOAuthError } from './google-oauth.js'

const IDLE_MS = 24 * 60 * 60 * 1000
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
const DUMMY_PASSWORD_HASH = hashPassword(`oauth-dummy:${randomBytes(32).toString('base64url')}`)

export class AuthError extends Error {
  constructor(status, code, message, options = {}) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
    this.retryAfter = options.retryAfter
    this.details = options.details
  }
}

function normalizeEmail(email) {
  if (typeof email !== 'string') throw new AuthError(422, 'validation_error', 'Email is invalid')
  const normalized = email.trim().toLowerCase()
  if (!normalized || normalized.length > 254 || !normalized.includes('@')) throw new AuthError(422, 'validation_error', 'Email is invalid')
  return normalized
}

function serializeUser(user) {
  if (!user) return null
  return {
    id: String(user._id ?? user.id),
    email: user.status === 'deleted' ? null : user.emailDisplay ?? user.emailNormalized ?? user.email ?? null,
    role: user.status === 'deleted' ? null : user.role ?? null,
    status: user.status,
    topicPreferences: user.topicPreferences ?? [],
    createdAt: new Date(user.createdAt).toISOString(),
  }
}

function serializeAdminUser(user) {
  return {
    id: String(user._id ?? user.id),
    email: user.status === 'deleted' ? null : user.emailDisplay ?? user.emailNormalized ?? user.email ?? null,
    role: user.status === 'deleted' ? null : user.role ?? null,
    status: user.status,
    createdAt: new Date(user.createdAt).toISOString(),
    updatedAt: new Date(user.updatedAt ?? user.createdAt).toISOString(),
  }
}

function clientIp(request, adapter) {
  return adapter?.getClientIp?.(request) ?? null
}

function validMongoId(value) {
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)
}

function requireAdminTargetId(userId) {
  if (!validMongoId(userId)) throw new AuthError(404, 'not_found', 'User not found')
  return userId
}

export function createAuthService({ repository, runtime, environment = process.env, clock = () => new Date(), clientIpAdapter, quotaKeyring, rateLimitAdmission } = {}) {
  if (!repository) throw new Error('auth repository is required')
  const keyring = quotaKeyring ?? (runtime?.quotaKeyring ? createHmacKeyring({ ...runtime.quotaKeyring }) : null)

  function requireKeyring() {
    if (!keyring) throw new AuthError(503, 'service_unavailable', 'Authentication service is not configured')
    return keyring
  }

  async function reserve(scope, request) {
    const currentKeyring = requireKeyring()
    const subject = clientIp(request, clientIpAdapter)
    if (!subject) throw new AuthError(503, 'service_unavailable', 'Client identity is unavailable')
    const keyHash = currentKeyring.digest(subject)
    const rotationKeyHashes = []
    for (const version of currentKeyring.versions ?? []) if (version !== currentKeyring.currentVersion) rotationKeyHashes.push(currentKeyring.digest(subject, version))
    const result = await repository.reserveRateLimit({ scope, subjectType: 'ip', keyHash, keyVersion: currentKeyring.currentVersion, keyring: currentKeyring, rotationKeyHashes, now: clock() })
    if (!result.allowed) throw new AuthError(429, 'rate_limit_exceeded', 'Too many attempts', { retryAfter: result.retryAfterSeconds })
  }

  async function reserveAdmin(userId, session) {
    try {
      if (rateLimitAdmission?.reserve) return await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(userId), session })
      const currentKeyring = requireKeyring()
      const raw = String(userId)
      const rotationKeyHashes = (currentKeyring.versions ?? []).filter((version) => version !== currentKeyring.currentVersion).map((version) => currentKeyring.digest(raw, version))
      return await repository.reserveRateLimit({ scope: 'admin-trigger', subjectType: 'admin', keyHash: currentKeyring.digest(raw), keyVersion: currentKeyring.currentVersion, keyring: currentKeyring, rotationKeyHashes, now: clock() }, { session })
    } catch (error) {
      if (error instanceof AuthError) throw error
      throw new AuthError(503, 'service_unavailable', 'Admin admission is unavailable')
    }
  }

  async function createSession(user, request, transactionSession) {
    const clearToken = createSessionToken()
    const csrfToken = csrfTokenForSession(clearToken)
    const createdAt = clock()
    try {
      await repository.createSession({
        userId: user._id,
        userSessionVersion: user.sessionVersion,
        tokenHash: hashSessionToken(clearToken),
        csrfSecretHash: hashCsrfToken(csrfToken),
        absoluteExpiresAt: new Date(createdAt.getTime() + ABSOLUTE_MS),
        expiresAt: new Date(createdAt.getTime() + IDLE_MS),
        createdAt,
        userAgentSummary: request?.get?.('User-Agent')?.slice(0, 256),
      }, { session: transactionSession, expectedUserSessionVersion: user.sessionVersion, expectedUserStatus: 'active' })
    } catch (error) {
      if (error?.message === 'session user fence mismatch') throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      throw error
    }
    return { sessionToken: clearToken, csrfToken, maxAgeSeconds: Math.floor(ABSOLUTE_MS / 1000) }
  }

  async function inTransaction(work) {
    return typeof repository.withTransaction === 'function' ? repository.withTransaction(work) : work(undefined)
  }

  async function register({ email, password, request } = {}) {
    await reserve('register', request)
    const emailNormalized = normalizeEmail(email)
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new AuthError(422, 'validation_error', 'Password is invalid')
    const existing = await repository.findUserByEmail(emailNormalized)
    if (existing) throw new AuthError(409, 'conflict', 'Account already exists')
    const passwordHash = await hashPassword(password)
    return inTransaction(async (session) => {
      let user
      try {
        user = await repository.createUser({ emailNormalized, emailDisplay: email.trim(), passwordHash, role: 'user', status: 'active', topicPreferences: [], sessionVersion: 0 }, { session })
      } catch (error) {
        if (error?.code === 11000) throw new AuthError(409, 'conflict', 'Account already exists')
        throw error
      }
      const sessionData = await createSession(user, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'user_registered', targetId: user._id, changedFields: ['status'], reasonCode: 'user_registered', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  async function login({ email, password, request } = {}) {
    await reserve('login', request)
    const emailNormalized = normalizeEmail(email)
    const user = await repository.findUserByEmail(emailNormalized)
    const candidateHash = user?.passwordHash ?? await DUMMY_PASSWORD_HASH
    const passwordMatches = await verifyPassword(password, candidateHash)
    const valid = Boolean(user && user.status === 'active' && passwordMatches)
    if (!valid) throw new AuthError(401, 'unauthorized', 'Email or password is invalid')
    return inTransaction(async (session) => {
      const sessionData = await createSession(user, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'user_logged_in', targetId: user._id, reasonCode: 'user_login', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  async function authenticate({ token, tokenHash = hashSessionToken(token), request } = {}) {
    const session = await repository.findSessionByTokenHash(tokenHash)
    if (!session) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    const user = await repository.findUserById(session.userId)
    const now = clock()
    if (!user || user.status !== 'active' || user.sessionVersion !== session.userSessionVersion || new Date(session.expiresAt) <= now || new Date(session.absoluteExpiresAt) <= now) {
      throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    }
    return { token, session, user, request }
  }

  async function currentUser({ token, request } = {}) {
    const auth = await authenticate({ token, request })
    const csrfToken = csrfTokenForSession(token)
    const touched = await inTransaction((session) => repository.touchSession(auth.session._id, clock(), {
      session,
      userId: auth.user._id,
      expectedSessionVersion: auth.session.userSessionVersion,
    }))
    if (!touched) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
    return { user: serializeUser(auth.user), csrfToken }
  }

  async function verifyCsrf({ auth, token } = {}) {
    if (!auth?.session || !verifyCsrfToken(token, auth.session.csrfSecretHash)) throw new AuthError(403, 'csrf_invalid', 'CSRF token is invalid')
    return true
  }

  async function logout({ auth, csrfToken, request } = {}) {
    await verifyCsrf({ auth, token: csrfToken })
    await inTransaction(async (session) => {
      if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion }, { session }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      await repository.revokeSession(auth.session._id, { session })
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action: 'user_logged_out', targetId: auth.user._id, reasonCode: 'user_logout', request: request ?? auth.request }), { session })
    })
  }

  async function updatePreferences({ auth, csrfToken, topicPreferences, request } = {}) {
    await verifyCsrf({ auth, token: csrfToken })
    if (!Array.isArray(topicPreferences) || new Set(topicPreferences).size !== topicPreferences.length || topicPreferences.length > 20 || topicPreferences.some((topic) => typeof topic !== 'string' || topic.length < 1 || topic.length > 64)) {
      throw new AuthError(422, 'validation_error', 'Topic preferences are invalid')
    }
    return inTransaction(async (session) => {
      const updated = await repository.updatePreferences(auth.user._id, topicPreferences, { session, expectedSessionId: auth.session._id, expectedSessionVersion: auth.session.userSessionVersion })
      if (!updated) throw new AuthError(401, 'unauthorized', 'Session is invalid or expired')
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action: 'user_preferences_updated', targetId: auth.user._id, changedFields: ['topicPreferences'], reasonCode: 'preferences_updated', request }), { session })
      return serializeUser(updated)
    })
  }

  function requireAdmin(auth) {
    if (auth?.user?.role !== 'admin') throw new AuthError(403, 'forbidden', 'Admin role is required')
  }

  async function requireLiveAdmin(auth) {
    requireAdmin(auth)
    if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
  }

  async function listAdminUsers({ auth, query } = {}) {
    await requireLiveAdmin(auth)
    const limit = Number(query?.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AuthError(422, 'validation_error', 'Limit is invalid')
    if (query?.status && !['active', 'suspended', 'deletion-pending', 'deleted'].includes(query.status)) throw new AuthError(422, 'validation_error', 'Status is invalid')
    if (query?.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.email)) throw new AuthError(422, 'validation_error', 'Email is invalid')
    let cursor
    if (query?.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        if (!decoded || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== 'string' || !/^[a-f0-9]{24}$/i.test(decoded.id)) throw new Error('invalid cursor')
        cursor = decoded
      } catch {
        throw new AuthError(422, 'validation_error', 'Cursor is invalid')
      }
    }
    const rows = await repository.listUsers({ limit: limit + 1, status: query?.status, emailNormalized: query?.email?.trim().toLowerCase(), cursor })
    const hasNext = rows.length > limit
    const users = hasNext ? rows.slice(0, limit) : rows
    const last = users.at(-1)
    const nextCursor = hasNext && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })).toString('base64url') : null
    return { users, hasNext, nextCursor }
  }

  async function getAdminUser({ auth, userId } = {}) {
    await requireLiveAdmin(auth)
    const targetId = requireAdminTargetId(userId)
    const user = await repository.findUserById(targetId)
    if (!user) throw new AuthError(404, 'not_found', 'User not found')
    return serializeAdminUser(user)
  }

  async function updateUserStatus({ auth, userId, status, reasonCode, csrfToken, request } = {}) {
    requireAdmin(auth)
    await verifyCsrf({ auth, token: csrfToken })
    const targetId = requireAdminTargetId(userId)
    if (!['active', 'suspended'].includes(status) || (status === 'active' && reasonCode !== 'user_restored') || (status === 'suspended' && reasonCode !== 'user_suspended')) throw new AuthError(422, 'validation_error', 'Status transition is invalid')
    const action = status === 'suspended' ? 'user_suspended' : 'user_restored'
    const stateTransition = { from: status === 'suspended' ? 'active' : 'suspended', to: status }
    const outcome = await inTransaction(async (session) => {
      if (repository.assertActiveSessionForUser && !(await repository.assertActiveSessionForUser({ sessionId: auth.session._id, userId: auth.user._id, sessionVersion: auth.session.userSessionVersion, role: 'admin' }, { session }))) throw new AuthError(401, 'unauthorized', 'Session is no longer active')
      const admission = await reserveAdmin(auth.user._id ?? auth.user.id, session)
      if (admission?.allowed === false) throw new AuthError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: admission.retryAfterSeconds })
      const updated = await repository.updateUserStatus(targetId, status, reasonCode, { session })
      if (updated?.conflict) return { conflict: true }
      if (!updated) throw new AuthError(404, 'not_found', 'User not found')
      await repository.revokeSessionsByUserId(targetId, { session })
      await repository.insertAudit(createAuditEvent({ actor: auth.user, action, targetId, changedFields: ['status', 'sessionVersion'], reasonCode, stateTransition, request }), { session })
      return { user: serializeAdminUser(updated) }
    })
    if (outcome.conflict) {
      throw new AuthError(409, 'conflict', 'User status transition conflicts with current state')
    }
    return outcome.user
  }

  function mapGoogleOAuthError(error) {
    if (error instanceof GoogleOAuthError) return new AuthError(error.status, error.code, error.message)
    if (error instanceof AuthError) return error
    return null
  }

  function mapRepositoryError(error) {
    if (error instanceof AuthError) return error
    if (error?.name?.startsWith('Mongo') || [6, 7, 89, 91, 189].includes(error?.code)) return new AuthError(503, 'service_unavailable', 'Authentication service is temporarily unavailable')
    return error
  }

  function googleOAuthService() {
    return createGoogleOAuthService({
      clientIdEnv: runtime?.googleOAuth?.clientIdEnv,
      clientSecretEnv: runtime?.googleOAuth?.clientSecretEnv,
      redirectUriEnv: runtime?.googleOAuth?.redirectUriEnv,
      stateSecretEnv: runtime?.googleOAuth?.stateSecretEnv,
      values: environment,
    })
  }

  function generateGoogleAuthUrl() {
    const googleOAuth = googleOAuthService()
    const state = googleOAuth.createState()
    return { authUrl: googleOAuth.generateAuthUrl({ state }), state }
  }

  async function googleLogin({ code, state, stateCookie, request } = {}) {
    const googleOAuth = googleOAuthService()
    try {
      googleOAuth.verifyState(state)
      if (typeof stateCookie !== 'string' || stateCookie.length === 0) throw new AuthError(403, 'oauth_state_invalid', 'OAuth state cookie is missing')
      if (stateCookie !== state) throw new AuthError(409, 'oauth_state_replayed', 'OAuth state has already been used')
    } catch (error) {
      const mapped = mapGoogleOAuthError(error)
      if (mapped) throw mapped
      throw error
    }
    // Do not spend the shared login quota on cross-site callbacks that fail
    // the browser-bound state check before this point.
    await reserve('login', request)
    let googleUser
    try {
      googleUser = await googleOAuth.verifyGoogleUser(code)
    } catch (error) {
      const mapped = mapGoogleOAuthError(error)
      if (mapped) throw mapped
      throw new AuthError(502, 'oauth_provider_error', 'Google OAuth verification failed')
    }
    const emailNormalized = normalizeEmail(googleUser.email)
    const existingBySubject = repository.findUserByGoogleSub ? await repository.findUserByGoogleSub(googleUser.sub) : null
    if (existingBySubject && (existingBySubject.emailNormalized !== emailNormalized || existingBySubject.status !== 'active')) throw new AuthError(409, 'oauth_identity_conflict', 'Google identity is linked to another account')
    let user = existingBySubject
    if (!user) {
      const existingByEmail = await repository.findUserByEmail(emailNormalized)
      if (existingByEmail) {
        if (existingByEmail.googleSub !== googleUser.sub) throw new AuthError(409, 'oauth_identity_conflict', 'Email account requires explicit Google linking')
        user = existingByEmail
      }
    }
    if (!user) {
      return inTransaction(async (session) => {
        try {
          user = await repository.createUser({ emailNormalized, emailDisplay: googleUser.email, passwordHash: await hashPassword(`oauth-dummy:${randomBytes(32).toString('base64url')}`), role: 'user', status: 'active', topicPreferences: [], sessionVersion: 0, googleSub: googleUser.sub }, { session })
        } catch (error) {
          if (error?.code === 11000) throw new AuthError(409, 'conflict', 'Account already exists')
          throw error
        }
        const sessionData = await createSession(user, request, session)
        await repository.insertAudit(createAuditEvent({ actor: user, action: 'google_oauth_registered', targetId: user._id, changedFields: ['status'], reasonCode: 'google_oauth_registered', request }), { session })
        return { user: serializeUser(user), ...sessionData }
      })
    }
    return inTransaction(async (session) => {
      const sessionData = await createSession(user, request, session)
      await repository.insertAudit(createAuditEvent({ actor: user, action: 'google_oauth_login', targetId: user._id, reasonCode: 'google_oauth_login', request }), { session })
      return { user: serializeUser(user), ...sessionData }
    })
  }

  const expose = (method) => async (...args) => {
    try { return await method(...args) } catch (error) { throw mapRepositoryError(error) }
  }
  return Object.freeze({
    register: expose(register), login: expose(login), authenticate: expose(authenticate), currentUser: expose(currentUser),
    verifyCsrf: expose(verifyCsrf), logout: expose(logout), updatePreferences: expose(updatePreferences), listAdminUsers: expose(listAdminUsers),
    getAdminUser: expose(getAdminUser), updateUserStatus: expose(updateUserStatus), googleLogin: expose(googleLogin), generateGoogleAuthUrl,
  })
}

export { normalizeEmail, serializeUser, serializeAdminUser }
