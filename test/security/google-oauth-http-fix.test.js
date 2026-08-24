import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app.js'
import { AuthError } from '../../server/application/auth/service.js'

const STATE = `1700000000.${'b'.repeat(16)}.${'c'.repeat(43)}`

function authResult() {
  return {
    user: {
      id: '507f1f77bcf86cd799439010',
      email: 'user@gmail.com',
      role: 'user',
      status: 'active',
      topicPreferences: [],
      createdAt: '2026-08-24T00:00:00.000Z',
    },
    sessionToken: 'opaque-session-token-1234',
    csrfToken: 'c'.repeat(32),
    maxAgeSeconds: 604800,
  }
}

let server
let origin
const authService = {
  generateGoogleAuthUrl: vi.fn(() => ({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`, state: STATE })),
  googleLogin: vi.fn(async () => authResult()),
  authenticate: vi.fn(),
}

beforeAll(async () => {
  const app = createApp({ authService })
  server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener))
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => server?.close())

describe('Google OAuth HTTP boundary', () => {
  it('sets a host-only state cookie when starting OAuth', async () => {
    const response = await fetch(`${origin}/api/v1/auth/google`)
    expect(response.status).toBe(200)
    expect((await response.json()).data.authUrl).toContain(`state=${STATE}`)
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_google_oauth_state=')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=600')
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax')
  })

  it('accepts Google GET redirect, consumes state cookie, preserves session cookie and redirects same-origin', async () => {
    const response = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}`, {
      redirect: 'manual',
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    const cookies = response.headers.get('set-cookie')
    expect(cookies).toContain('__Host-techpulse_session=')
    expect(cookies).toContain('__Host-techpulse_google_oauth_state=;')
    expect(authService.googleLogin).toHaveBeenCalledWith(expect.objectContaining({ code: 'google-code', state: STATE, stateCookie: STATE, request: expect.anything() }))
  })

  it('serializes OAuth state failures as the canonical error envelope and clears the cookie', async () => {
    authService.googleLogin.mockRejectedValueOnce(new AuthError(409, 'oauth_state_replayed', 'OAuth state has already been used'))
    const response = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'oauth_state_replayed', requestId: expect.any(String) }) })
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_google_oauth_state=;')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('preserves rate-limit status and Retry-After from the auth service', async () => {
    authService.googleLogin.mockRejectedValueOnce(new AuthError(429, 'rate_limit_exceeded', 'Too many attempts', { retryAfter: 19 }))
    const response = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('19')
    expect((await response.json()).error.code).toBe('rate_limit_exceeded')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('rejects missing or oversized callback query values before auth service invocation', async () => {
    authService.googleLogin.mockClear()
    const missing = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code`)
    expect(missing.status).toBe(422)
    expect(authService.googleLogin).not.toHaveBeenCalled()

    const oversized = await fetch(`${origin}/api/v1/auth/google/callback?code=${'x'.repeat(2049)}&state=${STATE}`)
    expect(oversized.status).toBe(400)
    expect(authService.googleLogin).not.toHaveBeenCalled()
  })
})
