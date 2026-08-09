import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { parseSessionCookie, serializeClearSessionCookie, serializeSessionCookie } from './cookies.js'
import { AuthError, serializeAdminUser } from '../application/auth/service.js'

const OPENAPI = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validators = new Map()
for (const name of ['RegisterRequest', 'LoginRequest', 'PreferencesRequest', 'AdminUserUpdateRequest']) validators.set(name, ajv.compile({ $ref: `#/components/schemas/${name}` }))

function noStore(res) {
  res.set('Cache-Control', 'no-store, private')
}

function validateBody(name, body) {
  const validate = validators.get(name)
  if (validate(body)) return
  throw new AuthError(422, 'validation_error', 'Request body is invalid', { details: validate.errors?.map(({ instancePath, message, keyword }) => ({ field: instancePath || 'body', message, code: `invalid_${keyword}` })) })
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
  res.set('Set-Cookie', serializeSessionCookie(result.sessionToken, result.maxAgeSeconds))
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
  const service = authService ?? { register: unavailable, login: unavailable, currentUser: unavailable, logout: unavailable, updatePreferences: unavailable, listAdminUsers: unavailable, getAdminUser: unavailable, updateUserStatus: unavailable, authenticate: unavailable }

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
    noStore(res)
    res.status(200).json({ data: (result.users ?? []).map(adminUser), meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))

  router.get('/api/v1/admin/users/:userId', asyncRoute(async (req, res) => {
    const auth = await requireAuth(service, req)
    const user = await service.getAdminUser({ auth, userId: req.params.userId })
    noStore(res)
    res.status(200).json({ data: adminUser(user) })
  }))

  router.patch('/api/v1/admin/users/:userId', asyncRoute(async (req, res) => {
    validateBody('AdminUserUpdateRequest', req.body)
    const auth = await requireAuth(service, req)
    const user = await service.updateUserStatus({ auth, userId: req.params.userId, ...req.body, csrfToken: req.get('X-CSRF-Token'), request: req })
    noStore(res)
    res.status(200).json({ data: adminUser(user) })
  }))

  return router
}
