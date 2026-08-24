import { describe, expect, it, vi } from 'vitest'
import { createGoogleOAuthService, GoogleOAuthError, GMAIL_DOMAIN } from '../../server/application/auth/google-oauth.js'

const OAUTH_VALUES = {
  CLIENT_ID_ENV: 'test-client-id',
  CLIENT_SECRET_ENV: 'test-client-secret',
  REDIRECT_URI_ENV: 'https://example.com/api/v1/auth/google/callback',
  STATE_SECRET_ENV: 's'.repeat(32),
}

function configuredService(options = {}) {
  return createGoogleOAuthService({
    clientIdEnv: 'CLIENT_ID_ENV',
    clientSecretEnv: 'CLIENT_SECRET_ENV',
    redirectUriEnv: 'REDIRECT_URI_ENV',
    stateSecretEnv: 'STATE_SECRET_ENV',
    values: OAUTH_VALUES,
    ...options,
  })
}

describe('Google OAuth service', () => {
  it('throws when client ID is not configured', () => {
    const service = createGoogleOAuthService({ clientIdEnv: 'MISSING_ENV', values: {} })
    expect(() => service.generateAuthUrl({ })).toThrow(GoogleOAuthError)
    expect(() => service.generateAuthUrl({ })).toThrow(/not configured/)
  })

  it('throws when client secret is not configured', () => {
    const service = createGoogleOAuthService({ clientIdEnv: 'CLIENT_ID_ENV', clientSecretEnv: 'MISSING_ENV', values: { CLIENT_ID_ENV: 'client-id' } })
    expect(() => service.generateAuthUrl({ })).toThrow(GoogleOAuthError)
  })

  it('throws when redirect URI is not configured', () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'MISSING_ENV',
      values: { CLIENT_ID_ENV: 'client-id', CLIENT_SECRET_ENV: 'client-secret' },
    })
    expect(() => service.generateAuthUrl({ })).toThrow(GoogleOAuthError)
  })

  it('generates valid Google OAuth URL', () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/api/v1/auth/google/callback',
      },
    })
    const url = service.generateAuthUrl({ state: 'csrf-state-123' })
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth?')
    expect(url).toContain('client_id=test-client-id')
    expect(url).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fapi%2Fv1%2Fauth%2Fgoogle%2Fcallback')
    expect(url).toContain('response_type=code')
    expect(url).toContain('scope=openid+email+profile')
    expect(url).toContain('state=csrf-state-123')
    expect(url).not.toContain('access_type=offline')
    expect(url).not.toContain('prompt=consent')
  })

  it('reports configuration status correctly', () => {
    const service = createGoogleOAuthService({ clientIdEnv: 'MISSING_ENV', values: {} })
    expect(service.isConfigured()).toBe(false)

    const configured = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })
    expect(configured.isConfigured()).toBe(false)

    const fullyConfigured = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      stateSecretEnv: 'STATE_SECRET_ENV',
      values: { ...OAUTH_VALUES, REDIRECT_URI_ENV: 'https://example.com/callback' },
    })
    expect(fullyConfigured.isConfigured()).toBe(true)
  })

  it('rejects non-Gmail addresses', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        email: 'user@yahoo.com',
        verified_email: true,
        name: 'Test User',
        sub: '123456789',
      }),
    })

    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'non_gmail_address' })
  })

  it('rejects unverified email addresses', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        email: 'user@gmail.com',
        verified_email: false,
        name: 'Test User',
        sub: '123456789',
      }),
    })

    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'unverified_email' })
  })

  it('successfully verifies a valid Gmail user', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        email: 'User@Gmail.com',
        verified_email: true,
        name: 'Test User',
        picture: 'https://example.com/photo.jpg',
        sub: '123456789',
      }),
    })

    const result = await service.verifyGoogleUser('valid-code')
    expect(result).toEqual({
      email: 'user@gmail.com',
      emailVerified: true,
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      sub: '123456789',
    })
  })

  it('handles token exchange failure', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
    })

    await expect(service.verifyGoogleUser('invalid-code')).rejects.toMatchObject({ code: 'invalid_oauth_code' })
  })

  it('handles user info fetch failure', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    }).mockResolvedValueOnce({
      ok: false,
      status: 401,
    })

    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'invalid_access_token' })
  })

  it('rejects when email is not provided by Google', async () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      values: {
        CLIENT_ID_ENV: 'test-client-id',
        CLIENT_SECRET_ENV: 'test-client-secret',
        REDIRECT_URI_ENV: 'https://example.com/callback',
      },
    })

    global.fetch = vi.fn()
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'test-access-token' }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        verified_email: true,
        name: 'Test User',
        sub: '123456789',
      }),
    })

    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'invalid_user_info' })
  })
})

describe('GMAIL_DOMAIN constant', () => {
  it('equals gmail.com', () => {
    expect(GMAIL_DOMAIN).toBe('gmail.com')
  })
})

describe('Google OAuth state and provider boundaries', () => {
  it('generates a signed state and rejects tampering and expiry', () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const service = configuredService({ now: () => now })
    const state = service.createState()

    expect(state.split('.')).toHaveLength(3)
    expect(service.verifyState(state)).toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }))
    expect(() => service.verifyState(`${state.slice(0, -1)}x`)).toThrowError(GoogleOAuthError)

    const expired = configuredService({ now: () => new Date(now.getTime() + 11 * 60 * 1000) })
    expect(() => expired.verifyState(state)).toThrowError(expect.objectContaining({ code: 'oauth_state_expired', status: 403 }))
  })

  it('requires the internal state secret instead of accepting caller-provided state', () => {
    const service = createGoogleOAuthService({
      clientIdEnv: 'CLIENT_ID_ENV',
      clientSecretEnv: 'CLIENT_SECRET_ENV',
      redirectUriEnv: 'REDIRECT_URI_ENV',
      stateSecretEnv: 'STATE_SECRET_ENV',
      values: { ...OAUTH_VALUES, STATE_SECRET_ENV: undefined },
    })
    expect(() => service.createState()).toThrow(/state secret/i)
  })

  it('requires a bounded subject and Google verified_email field', async () => {
    const service = configuredService({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'token' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'user@gmail.com', verified: true, id: 'legacy-id' }) }),
    })
    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'invalid_user_info' })

    const v2 = configuredService({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'token' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'user@gmail.com', verified_email: true, id: 'google-v2-id' }) }),
    })
    await expect(v2.verifyGoogleUser('valid-code')).resolves.toMatchObject({ sub: 'google-v2-id', emailVerified: true })

    const oversized = configuredService({
      fetchImpl: vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'token' }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ email: 'user@gmail.com', verified_email: true, sub: 's'.repeat(300) }) }),
    })
    await expect(oversized.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'invalid_user_info' })
  })

  it('aborts an upstream request at the configured timeout and maps it safely', async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }))
    const service = configuredService({ fetchImpl, timeoutMs: 5 })

    await expect(service.verifyGoogleUser('valid-code')).rejects.toMatchObject({ code: 'oauth_provider_timeout', status: 502 })
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.objectContaining({ aborted: expect.any(Boolean) }) }))
  })
})
