import { beforeAll, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { AuthError } from '../../server/application/auth/service.js'

const openApi = loadOpenApi()
const validator = new Ajv({ strict: false })
addFormats(validator)
for (const [name, schema] of Object.entries(openApi.components.schemas)) validator.addSchema(schema, `#/components/schemas/${name}`)
const validateAuthResponse = validator.compile({ $ref: '#/components/schemas/AuthResponse' })
const validateErrorResponse = validator.compile({ $ref: '#/components/schemas/ErrorResponse' })

let server
let origin

const authService = {
  register: vi.fn(async () => ({
    user: { id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: [], createdAt: '2026-08-09T00:00:00.000Z' },
    csrfToken: 'c'.repeat(32),
    sessionToken: 'opaque-session-token-1234',
    maxAgeSeconds: 604800,
  })),
  login: vi.fn(async () => ({
    user: { id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: [], createdAt: '2026-08-09T00:00:00.000Z' },
    csrfToken: 'c'.repeat(32),
    sessionToken: 'opaque-session-token-1234',
    maxAgeSeconds: 604800,
  })),
  currentUser: vi.fn(async () => ({
    user: { id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: [], createdAt: '2026-08-09T00:00:00.000Z' },
    csrfToken: 'c'.repeat(32),
  })),
  authenticate: vi.fn(async () => ({
    user: { id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: [], createdAt: '2026-08-09T00:00:00.000Z' },
    session: { csrfSecretHash: 'c'.repeat(64), _id: 'session-1', userSessionVersion: 0 },
  })),
  logout: vi.fn(async () => undefined),
  updatePreferences: vi.fn(async () => ({
    id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: ['AI'], createdAt: '2026-08-09T00:00:00.000Z',
  })),
  changePassword: vi.fn(async () => ({
    user: { id: 'user-1', email: 'new@example.com', role: 'user', status: 'active', topicPreferences: [], hasPassword: true, createdAt: '2026-08-09T00:00:00.000Z' },
    csrfToken: 'c'.repeat(32),
    sessionToken: 'rotated-session-token-1234',
    maxAgeSeconds: 604800,
  })),
  listAdminUsers: vi.fn(async () => ({ users: [{ id: '507f1f77bcf86cd799439010', email: 'admin@example.com', role: 'admin', status: 'active', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' }], hasNext: false, nextCursor: null })),
}

beforeAll(async () => {
  const instance = createApp({ authService })
  server = await new Promise((resolve) => {
    const listener = instance.listen(0, () => resolve(listener))
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

describe('Step 2 auth HTTP boundary', () => {
  it('rejects role injection at registration before calling the service', async () => {
    const response = await fetch(`${origin}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'long-enough-password', role: 'admin' }),
    })
    expect(response.status).toBe(422)
    expect(authService.register).not.toHaveBeenCalled()
  })

  it('serializes register/login cookie and cache headers from the service result', async () => {
    const response = await fetch(`${origin}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', password: 'long-enough-password' }),
    })
    const payload = await response.json()
    expect(response.status).toBe(201)
    expect(payload.data.csrfToken).toHaveLength(32)
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_session=')
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(validateAuthResponse(payload)).toBe(true)
  })

  it('clears the exact session cookie on logout without requiring an empty JSON body', async () => {
    const response = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', Cookie: '__Host-techpulse_session=opaque-session-token-1234', 'X-CSRF-Token': 'c'.repeat(32) },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_session=;')
    expect(response.headers.get('cache-control')).toBe('no-store, private')
  })
  it('rejects logout without a session cookie before invoking the service', async () => {
    authService.logout.mockClear()
    const response = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'X-CSRF-Token': 'c'.repeat(32) },
    })

    expect(response.status).toBe(401)
    expect(authService.logout).not.toHaveBeenCalled()
  })


  it('serializes unauthenticated current-user errors with the OpenAPI envelope', async () => {
    const response = await fetch(`${origin}/api/v1/me`)
    const payload = await response.json()
    expect(response.status).toBe(401)
    expect(validateErrorResponse(payload)).toBe(true)
    expect(payload.error.code).toBe('unauthorized')
  })

  it('validates the full admin user response contract at the router boundary', async () => {
    authService.listAdminUsers.mockResolvedValueOnce({ users: [{ id: '507f1f77bcf86cd799439010', email: 'admin@example.com', role: 'admin', status: 'private-status', createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' }], hasNext: false, nextCursor: null })
    const response = await fetch(`${origin}/api/v1/admin/users`, { headers: { Cookie: '__Host-techpulse_session=opaque-session-token-1234' } })
    expect(response.status).toBe(500)
    expect((await response.json()).error.code).toBe('internal_error')
  })

  it('re-issues a session cookie when the password change succeeds', async () => {
    const response = await fetch(`${origin}/api/v1/me/password`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', Cookie: '__Host-techpulse_session=opaque-session-token-1234', 'X-CSRF-Token': 'c'.repeat(32) },
      body: JSON.stringify({ currentPassword: 'long-enough-password', newPassword: 'brand-new-password' }),
    })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_session=')
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(validateAuthResponse(payload)).toBe(true)
    expect(authService.changePassword).toHaveBeenCalled()
  })
  it('preserves canonical password-change throttling and Retry-After responses', async () => {
    authService.changePassword.mockRejectedValueOnce(new AuthError(429, 'rate_limit_exceeded', 'Too many attempts', { retryAfter: 17 }))
    const response = await fetch(`${origin}/api/v1/me/password`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', Cookie: '__Host-techpulse_session=opaque-session-token-1234', 'X-CSRF-Token': 'c'.repeat(32) },
      body: JSON.stringify({ currentPassword: 'not-echoed', newPassword: 'not-echoed-too' }),
    })
    const payload = await response.json()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('17')
    expect(payload.error).toMatchObject({ code: 'rate_limit_exceeded', message: 'Too many attempts' })
    expect(JSON.stringify(payload)).not.toContain('not-echoed')
  })

  it('rejects a password change without a session before calling the service', async () => {
    authService.changePassword.mockClear()
    const response = await fetch(`${origin}/api/v1/me/password`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json', 'X-CSRF-Token': 'c'.repeat(32) },
      body: JSON.stringify({ newPassword: 'brand-new-password' }),
    })
    expect(response.status).toBe(401)
    expect(authService.changePassword).not.toHaveBeenCalled()
  })
})
