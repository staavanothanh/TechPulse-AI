import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  generateGoogleAuthUrl: vi.fn(async () => ({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`, state: STATE })),
  verifyGoogleState: vi.fn(async () => undefined),
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

beforeEach(() => {
  authService.verifyGoogleState.mockReset().mockResolvedValue(undefined)
  authService.googleLogin.mockReset().mockResolvedValue(authResult())
})

afterAll(() => server?.close())

describe('Google OAuth HTTP boundary', () => {
  it('awaits the lazy auth service and sets a host-only state cookie when starting OAuth', async () => {
    const response = await fetch(`${origin}/api/v1/auth/google`)
    expect(response.status).toBe(200)
    expect((await response.json()).data.authUrl).toContain(`state=${STATE}`)
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_google_oauth_state=')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=600')
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax')
  })

  it('accepts Google GET redirect, consumes state cookie, preserves session cookie and redirects same-origin', async () => {
    const response = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}&scope=openid%20email%20profile&authuser=0&hd=example.com&prompt=consent&iss=https%3A%2F%2Faccounts.google.com`, {
      redirect: 'manual',
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    const cookies = response.headers.get('set-cookie')
    expect(cookies).toContain('__Host-techpulse_session=')
    expect(cookies).toContain('__Host-techpulse_google_oauth_state=;')
    const [loginInput] = authService.googleLogin.mock.lastCall
    expect(loginInput).toEqual(expect.objectContaining({ code: 'google-code', state: STATE, stateCookie: STATE, request: expect.anything() }))
    expect(loginInput).not.toHaveProperty('scope')
    expect(loginInput).not.toHaveProperty('authuser')
  })

  it('returns a safe error when the user denies Google authorization', async () => {
    authService.googleLogin.mockClear()
    authService.verifyGoogleState.mockClear()
    const response = await fetch(`${origin}/api/v1/auth/google/callback?error=access_denied&error_description=User%20denied%20access&error_uri=https%3A%2F%2Fsupport.google.com%2F&state=${STATE}`, {
      redirect: 'manual',
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: expect.objectContaining({ code: 'forbidden', message: 'Google OAuth authorization was denied', requestId: expect.any(String) }) })
    expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_google_oauth_state=;')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(authService.verifyGoogleState).toHaveBeenCalledWith(expect.objectContaining({ state: STATE, stateCookie: STATE, request: expect.anything() }))
    expect(authService.googleLogin).not.toHaveBeenCalled()
  })

  it('rejects an OAuth error when the browser-bound state is invalid', async () => {
    authService.verifyGoogleState.mockRejectedValueOnce(new AuthError(403, 'oauth_state_invalid', 'OAuth state is invalid'))
    const response = await fetch(`${origin}/api/v1/auth/google/callback?error=access_denied&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('oauth_state_invalid')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(authService.googleLogin).not.toHaveBeenCalled()
  })

  it('does not consume the state cookie when a success callback fails state validation', async () => {
    authService.googleLogin.mockClear()
    authService.verifyGoogleState.mockRejectedValueOnce(new AuthError(403, 'oauth_state_invalid', 'OAuth state is invalid'))
    const response = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}`, {
      redirect: 'manual',
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('oauth_state_invalid')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(authService.googleLogin).not.toHaveBeenCalled()
  })

  it('rejects a callback error URI that is not an absolute URI', async () => {
    authService.verifyGoogleState.mockClear()
    const response = await fetch(`${origin}/api/v1/auth/google/callback?error=access_denied&error_uri=not-a-uri&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('bad_request')
    expect(authService.verifyGoogleState).not.toHaveBeenCalled()
  })

  it('rejects ambiguous or incomplete authorization responses after state validation', async () => {
    const both = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&error=access_denied&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(both.status).toBe(400)

    const neither = await fetch(`${origin}/api/v1/auth/google/callback?state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(neither.status).toBe(422)
    expect(authService.googleLogin).not.toHaveBeenCalled()
  })

  it('rejects provider error metadata when the provider did not send an error code', async () => {
    authService.verifyGoogleState.mockClear()
    const response = await fetch(`${origin}/api/v1/auth/google/callback?error_description=unexpected&state=${STATE}`, {
      headers: { Cookie: `__Host-techpulse_google_oauth_state=${STATE}` },
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('bad_request')
    expect(authService.verifyGoogleState).not.toHaveBeenCalled()
    expect(authService.googleLogin).not.toHaveBeenCalled()
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

    const oversizedError = await fetch(`${origin}/api/v1/auth/google/callback?error=access_denied&error_description=${'x'.repeat(1025)}&state=${STATE}`)
    expect(oversizedError.status).toBe(400)
    expect(authService.googleLogin).not.toHaveBeenCalled()

    const duplicateState = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}&state=${STATE}`)
    expect(duplicateState.status).toBe(400)
    expect(authService.googleLogin).not.toHaveBeenCalled()

    const unknown = await fetch(`${origin}/api/v1/auth/google/callback?code=google-code&state=${STATE}&unexpected=value`)
    expect(unknown.status).toBe(400)
    expect(unknown.headers.get('cache-control')).toBe('no-store, private')
    expect(authService.googleLogin).not.toHaveBeenCalled()

    const oversizedTarget = await fetch(`${origin}/api/v1/auth/google/callback?error=access_denied&error_description=${'x'.repeat(8200)}&state=${STATE}`)
    expect(oversizedTarget.status).toBe(413)
    expect(oversizedTarget.headers.get('cache-control')).toBe('no-store, private')
  })
})
