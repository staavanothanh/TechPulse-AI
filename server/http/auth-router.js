import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import {
  parseOAuthStateCookie,
  parseSessionCookie,
  serializeClearOAuthStateCookie,
  serializeClearSessionCookie,
  serializeOAuthStateCookie,
  serializeSessionCookie,
} from './cookies.js'
import { AuthError, serializeAdminUser } from '../application/auth/service.js'

const OPENAPI = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validators = new Map()
for (const name of ['RegisterRequest', 'LoginRequest', 'PreferencesRequest', 'AdminUserUpdateRequest']) validators.set(name, ajv.compile({ $ref: `#/components/schemas/${name}` }))
const responseValidators = new Map(['AdminUserListResponse', 'AdminUserResponse'].map((name) => [name, ajv.compile({ $ref: `#/components/schemas/${name}` })]))

function noStore(res) {
  res.set('Cache-Control', 'no-store, private')
}

function validateBody(name, body) {
  const validate = validators.get(name)
  if (validate(body)) return
  throw new AuthError(422, 'validation_error', 'Request body is invalid', { details: validate.errors?.map(({ instancePath, message, keyword }) => ({ field: instancePath || 'body', message, code: `invalid_${keyword}` })) })
}

function sendValidated(res, status, name, payload) {
  if (!responseValidators.get(name)?.(payload)) throw new AuthError(500, 'internal_error', 'Authentication response failed contract validation')
  noStore(res)
  return res.status(status).json(payload)
}

function sessionToken(req) {
  return parseSessionCookie(req.get('Cookie'))
}

async function requireAuth(authService, req) {
  const token = sessionToken(req)
  if (!token) throw new AuthError(401, 'unauthorized', 'Authentication is required')
  return authService.authenticate({ token, request: req })
}

function authPayload(result) {
  return { data: { user: result.user, csrfToken: result.csrfToken } }
}

function setAuthCookie(res, result) {
  res.append('Set-Cookie', serializeSessionCookie(result.sessionToken, result.maxAgeSeconds))
  noStore(res)
  res.set('Vary', 'Cookie')
}

function adminUser(user) {
  return serializeAdminUser(user)
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

export function createAuthRouter({ authService } = {}) {
  const router = Router()
  const unavailable = () => { throw new AuthError(503, 'service_unavailable', 'Authentication service is not configured') }
  const service = authService ?? { register: unavailable, login: unavailable, currentUser: unavailable, logout: unavailable, updatePreferences: unavailable, listAdminUsers: unavailable, getAdminUser: unavailable, updateUserStatus: unavailable, authenticate: unavailable, googleLogin: unavailable, verifyGoogleState: unavailable, generateGoogleAuthUrl: unavailable }

  router.post('/api/v1/auth/register', asyncRoute(async (req, res) => {
    validateBody('RegisterRequest', req.body)
    const result = await service.register({ ...req.body, request: req })
    setAuthCookie(res, result)
    res.status(201).json(authPayload(result))
  }))

  router.post('/api/v1/auth/login', asyncRoute(async (req, res) => {
    validateBody('LoginRequest', req.body)
    const result = await service.login({ ...req.body, request: req })
    setAuthCookie(res, result)
    res.status(200).json(authPayload(result))
  }))

  router.post('/api/v1/auth/logout', asyncRoute(async (req, res) => {
    const auth = await requireAuth(service, req)
    await service.logout({ auth, csrfToken: req.get('X-CSRF-Token'), request: req })
    noStore(res)
    res.set('Set-Cookie', serializeClearSessionCookie())
    res.status(204).end()
  }))

  router.get('/api/v1/me', asyncRoute(async (req, res) => {
    const token = sessionToken(req)
    if (!token) throw new AuthError(401, 'unauthorized', 'Authentication is required')
    const result = await service.currentUser({ token, request: req })
    noStore(res)
    res.set('Vary', 'Cookie')
    res.status(200).json(authPayload(result))
  }))

  router.patch('/api/v1/me/preferences', asyncRoute(async (req, res) => {
    validateBody('PreferencesRequest', req.body)
    const auth = await requireAuth(service, req)
    const user = await service.updatePreferences({ auth, csrfToken: req.get('X-CSRF-Token'), topicPreferences: req.body.topicPreferences, request: req })
    noStore(res)
    res.status(200).json({ data: user })
  }))

  router.get('/api/v1/admin/users', asyncRoute(async (req, res) => {
    const auth = await requireAuth(service, req)
    const result = await service.listAdminUsers({ auth, query: req.query })
    sendValidated(res, 200, 'AdminUserListResponse', { data: (result.users ?? []).map(adminUser), meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))

  router.get('/api/v1/admin/users/:userId', asyncRoute(async (req, res) => {
    const auth = await requireAuth(service, req)
    const user = await service.getAdminUser({ auth, userId: req.params.userId })
    sendValidated(res, 200, 'AdminUserResponse', { data: adminUser(user) })
  }))

  router.patch('/api/v1/admin/users/:userId', asyncRoute(async (req, res) => {
    validateBody('AdminUserUpdateRequest', req.body)
    const auth = await requireAuth(service, req)
    const user = await service.updateUserStatus({ auth, userId: req.params.userId, ...req.body, csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 200, 'AdminUserResponse', { data: adminUser(user) })
  }))

  router.get('/api/v1/auth/google', asyncRoute(async (req, res) => {
    const result = await service.generateGoogleAuthUrl()
    if (!result || typeof result.authUrl !== 'string' || typeof result.state !== 'string') throw new AuthError(500, 'internal_error', 'Authentication response is invalid')
    res.set('Set-Cookie', serializeOAuthStateCookie(result.state))
    noStore(res)
    res.status(200).json({ data: { authUrl: result.authUrl } })
  }))

  router.get('/api/v1/auth/google/callback', asyncRoute(async (req, res) => {
    // The query contains a short-lived authorization code and signed state.
    // Mark the response private before any validation or provider/database I/O,
    // including error responses handled by the shared error middleware.
    noStore(res)
    const { code, state, error } = req.query ?? {}
    if (typeof state !== 'string' || state.length === 0) throw new AuthError(422, 'validation_error', 'OAuth state is required')
    const stateCookie = parseOAuthStateCookie(req.get('Cookie'))
    const hasErrorMetadata = typeof req.query?.error_description === 'string' || typeof req.query?.error_uri === 'string'
    if (hasErrorMetadata && typeof error !== 'string') throw new AuthError(400, 'bad_request', 'OAuth error metadata requires an error code')
    if (typeof error === 'string') {
      await service.verifyGoogleState({ state, stateCookie, request: req })
      res.set('Set-Cookie', serializeClearOAuthStateCookie())
      if (typeof code === 'string') throw new AuthError(400, 'bad_request', 'OAuth response contains both code and error')
      if (error === 'access_denied') throw new AuthError(403, 'forbidden', 'Google OAuth authorization was denied')
      throw new AuthError(502, 'oauth_provider_error', 'Google OAuth provider returned an authorization error')
    }
    if (typeof code !== 'string' || code.length === 0) throw new AuthError(422, 'validation_error', 'Authorization code is required')
    await service.verifyGoogleState({ state, stateCookie, request: req })
    res.set('Set-Cookie', serializeClearOAuthStateCookie())
    const result = await service.googleLogin({ code, state, stateCookie, request: req })
    setAuthCookie(res, result)
    noStore(res)
    res.status(303).location('/').end()
  }))

  return router
}
