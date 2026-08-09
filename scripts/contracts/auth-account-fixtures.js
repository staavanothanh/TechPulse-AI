import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { AuthError } from '../../server/application/auth/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-09T00:00:00.000Z'
const USER = Object.freeze({ id: '507f1f77bcf86cd799439011', email: 'user@example.com', role: 'user', status: 'active', topicPreferences: ['AI'], createdAt: NOW })
const ADMIN = Object.freeze({ _id: '507f1f77bcf86cd799439012', emailDisplay: 'admin@example.com', role: 'admin', status: 'active', topicPreferences: [], createdAt: new Date(NOW), updatedAt: new Date(NOW) })
const TARGET = Object.freeze({ _id: '507f1f77bcf86cd799439013', emailDisplay: 'target@example.com', role: 'user', status: 'active', topicPreferences: ['Robot'], createdAt: new Date(NOW), updatedAt: new Date(NOW) })
const USER_TOKEN = 'user-session-token-fixture-000000000'
const ADMIN_TOKEN = 'admin-session-token-fixture-00000000'
const CSRF_TOKEN = 'c'.repeat(43)
const VALID_CREDENTIAL = ['long', 'enough', 'password'].join('-')

function authForToken(token) {
  if (token === ADMIN_TOKEN) return { token, user: ADMIN, session: { _id: '507f1f77bcf86cd799439099', userSessionVersion: 0 } }
  if (token === USER_TOKEN) return { token, user: { _id: USER.id, ...USER }, session: { _id: '507f1f77bcf86cd799439098', userSessionVersion: 0 } }
  throw new AuthError(401, 'unauthorized', 'Session is invalid')
}

function fixtureService() {
  const authResult = (user = USER) => ({ user, csrfToken: CSRF_TOKEN, sessionToken: USER_TOKEN, maxAgeSeconds: 3600 })
  return {
    async authenticate({ token }) { return authForToken(token) },
    async register() { return authResult() },
    async login({ email }) {
      if (email === 'denied@example.com') throw new AuthError(401, 'unauthorized', 'Email or password is invalid')
      return authResult()
    },
    async logout() {},
    async currentUser({ token }) { return { user: authForToken(token).user.role === 'admin' ? { ...USER, role: 'admin', email: 'admin@example.com' } : USER, csrfToken: CSRF_TOKEN } },
    async updatePreferences({ auth, topicPreferences }) { return { id: String(auth.user._id), email: auth.user.emailDisplay ?? auth.user.email, role: auth.user.role, status: auth.user.status, topicPreferences, createdAt: NOW } },
    async listAdminUsers({ auth }) {
      if (auth.user.role !== 'admin') throw new AuthError(403, 'forbidden', 'Admin role is required')
      return { users: [TARGET], hasNext: false, nextCursor: null }
    },
    async getAdminUser({ auth, userId }) {
      if (auth.user.role !== 'admin') throw new AuthError(403, 'forbidden', 'Admin role is required')
      if (userId === 'unknown') throw new AuthError(404, 'not_found', 'User not found')
      return TARGET
    },
    async updateUserStatus({ auth, userId, status }) {
      if (auth.user.role !== 'admin') throw new AuthError(403, 'forbidden', 'Admin role is required')
      if (userId === 'unknown') throw new AuthError(404, 'not_found', 'User not found')
      if (userId === 'conflict') throw new AuthError(409, 'conflict', 'User status transition conflicts with current state')
      return { ...TARGET, status, updatedAt: new Date(NOW) }
    },
  }
}

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const operation = operations.get(operationId)
    const response = dereference(document, operation?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) {
      if (status === 204 && body === '') return
      throw new Error(`No JSON schema for ${operationId} ${status}`)
    }
    const targetSchema = schema.$ref ? { $ref: `techpulse-openapi${schema.$ref}` } : schema
    const validate = ajv.compile(targetSchema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

export async function runAuthAccountContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const validate = responseValidator(document)
  const server = await start(createApp({ authService: fixtureService() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const userCookie = `__Host-techpulse_session=${USER_TOKEN}`
  const adminCookie = `__Host-techpulse_session=${ADMIN_TOKEN}`
  let cases = 0
  const request = async (operationId, path, init, status) => {
    const response = await globalThis.fetch(`${origin}${path}`, init)
    const body = status === 204 ? await response.text() : await response.json()
    if (response.status !== status) throw new Error(`${operationId} expected ${status}, got ${response.status}`)
    validate(operationId, status, body)
    cases += 1
  }

  try {
    const jsonHeaders = { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }
    await request('registerUser', '/api/v1/auth/register', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'new@example.com', password: VALID_CREDENTIAL }) }, 201)
    await request('registerUser', '/api/v1/auth/register', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'invalid', password: 'short' }) }, 422)
    await request('login', '/api/v1/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'user@example.com', password: VALID_CREDENTIAL }) }, 200)
    await request('login', '/api/v1/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: 'denied@example.com', password: VALID_CREDENTIAL }) }, 401)
    await request('logout', '/api/v1/auth/logout', { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: userCookie, 'X-CSRF-Token': CSRF_TOKEN } }, 204)
    await request('logout', '/api/v1/auth/logout', { method: 'POST', headers: { Origin: 'http://localhost:3000', 'X-CSRF-Token': CSRF_TOKEN } }, 401)
    await request('getCurrentUser', '/api/v1/me', { headers: { Cookie: userCookie } }, 200)
    await request('getCurrentUser', '/api/v1/me', {}, 401)
    await request('updatePreferences', '/api/v1/me/preferences', { method: 'PATCH', headers: { ...jsonHeaders, Cookie: userCookie, 'X-CSRF-Token': CSRF_TOKEN }, body: JSON.stringify({ topicPreferences: ['AI', 'Robot'] }) }, 200)
    await request('updatePreferences', '/api/v1/me/preferences', { method: 'PATCH', headers: { ...jsonHeaders, Cookie: userCookie }, body: JSON.stringify({ topicPreferences: ['AI'] }) }, 403)
    await request('listAdminUsers', '/api/v1/admin/users?limit=20', { headers: { Cookie: adminCookie } }, 200)
    await request('listAdminUsers', '/api/v1/admin/users?limit=20', { headers: { Cookie: userCookie } }, 403)
    await request('getAdminUser', '/api/v1/admin/users/507f1f77bcf86cd799439013', { headers: { Cookie: adminCookie } }, 200)
    await request('getAdminUser', '/api/v1/admin/users/unknown', { headers: { Cookie: adminCookie } }, 404)
    await request('updateUserStatus', '/api/v1/admin/users/507f1f77bcf86cd799439013', { method: 'PATCH', headers: { ...jsonHeaders, Cookie: adminCookie, 'X-CSRF-Token': CSRF_TOKEN }, body: JSON.stringify({ status: 'suspended', reasonCode: 'user_suspended' }) }, 200)
    await request('updateUserStatus', '/api/v1/admin/users/conflict', { method: 'PATCH', headers: { ...jsonHeaders, Cookie: adminCookie, 'X-CSRF-Token': CSRF_TOKEN }, body: JSON.stringify({ status: 'suspended', reasonCode: 'user_suspended' }) }, 409)
  } finally {
    await close(server)
  }
  return { cases }
}
