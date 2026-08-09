import { beforeAll, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'

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

  it('serializes unauthenticated current-user errors with the OpenAPI envelope', async () => {
    const response = await fetch(`${origin}/api/v1/me`)
    const payload = await response.json()
    expect(response.status).toBe(401)
    expect(validateErrorResponse(payload)).toBe(true)
    expect(payload.error.code).toBe('unauthorized')
  })
})
