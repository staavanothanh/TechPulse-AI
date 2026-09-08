import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthService } from '../../server/application/auth/service.js'
import { verifyPassword } from '../../server/security/password.js'

const ENVIRONMENT = {
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_REDIRECT_URI: 'https://example.com/api/v1/auth/google/callback',
  GOOGLE_OAUTH_STATE_SECRET: 's'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
}

const RUNTIME = {
  googleOAuth: {
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    redirectUriEnv: 'GOOGLE_REDIRECT_URI',
    stateSecretEnv: 'GOOGLE_OAUTH_STATE_SECRET',
  },
  internalMachineSecretEnv: 'CRON_SECRET',
}

function quotaKeyring() {
  return { currentVersion: 1, versions: [1], digest: () => 'a'.repeat(64) }
}

function request() {
  return { testClientIp: '203.0.113.10', serverRequestId: 'oauth-request-1', get: vi.fn(() => 'TechPulseTest/1.0') }
}

function googleFetch({ email = 'user@gmail.com', sub = 'google-sub-1', verified_email = true } = {}) {
  return vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'google-access-token' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ email, sub, verified_email, name: 'User' }) })
}

function repository(overrides = {}) {
  return {
    reserveRateLimit: vi.fn(async () => ({ allowed: true })),
    withTransaction: vi.fn(async (work) => work('mongo-session')),
    createSession: vi.fn(async () => undefined),
    insertAudit: vi.fn(async () => undefined),
    findUserByGoogleSub: vi.fn(async () => null),
    findUserByEmail: vi.fn(async () => null),
    createUser: vi.fn(async (input) => ({
      _id: '507f1f77bcf86cd799439011',
      ...input,
      createdAt: new Date('2026-08-24T00:00:00.000Z'),
    })),
    ...overrides,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Google OAuth auth service integration boundary', () => {
  it('passes runtime environment values and generates server-owned state', () => {
    const service = createAuthService({
      repository: repository(),
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      quotaKeyring: quotaKeyring(),
      clientIpAdapter: { getClientIp: (req) => req.testClientIp },
    })

    const result = service.generateGoogleAuthUrl()
    expect(result.authUrl).toContain('client_id=google-client-id')
    expect(result.state).toBe(new URL(result.authUrl).searchParams.get('state'))
  })

  it('looks up a stored Google subject before email and does not silently relink identities', async () => {
    const user = {
      _id: '507f1f77bcf86cd799439011',
      emailNormalized: 'user@gmail.com',
      emailDisplay: 'user@gmail.com',
      role: 'user',
      status: 'active',
      topicPreferences: [],
      sessionVersion: 0,
      createdAt: new Date('2026-08-24T00:00:00.000Z'),
    }
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => user), findUserByEmail: vi.fn() })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).resolves.toEqual(expect.objectContaining({ user: expect.objectContaining({ email: 'user@gmail.com' }) }))
    expect(repo.findUserByGoogleSub).toHaveBeenCalledWith('google-sub-1')
    expect(repo.findUserByEmail).not.toHaveBeenCalled()
  })


  it('rejects Google login for a user whose account is pending deletion with a suspended message', async () => {
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439011', emailNormalized: 'user@gmail.com', emailDisplay: 'user@gmail.com', role: 'user', status: 'deletion-pending', topicPreferences: [], sessionVersion: 1, createdAt: new Date() })) })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'This account has been suspended' })
    expect(repo.createUser).not.toHaveBeenCalled()
  })

  it('rejects Google login for a user whose account was deleted with a suspended message', async () => {
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439011', emailNormalized: null, status: 'deleted', sessionVersion: 1, createdAt: new Date() })) })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'This account has been suspended' })
    expect(repo.createUser).not.toHaveBeenCalled()
  })

  it('rejects Google login for a suspended account with a dedicated message', async () => {
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439011', emailNormalized: 'user@gmail.com', emailDisplay: 'user@gmail.com', role: 'user', status: 'suspended', topicPreferences: [], sessionVersion: 0, createdAt: new Date() })) })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'This account has been suspended' })
    expect(repo.createUser).not.toHaveBeenCalled()
  })

  it('does not spend the login quota on a callback without the browser-bound state', async () => {
    const repo = repository()
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    await expect(service.googleLogin({ code: 'google-code', state: 'invalid', stateCookie: null, request: request() })).rejects.toMatchObject({ status: 403, code: 'oauth_state_invalid' })
    expect(repo.reserveRateLimit).not.toHaveBeenCalled()
  })

  it('validates a denied OAuth callback without spending quota or calling Google', async () => {
    const repo = repository()
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()

    await expect(service.verifyGoogleState({ state, stateCookie: state })).resolves.toBeUndefined()
    expect(repo.reserveRateLimit).not.toHaveBeenCalled()
  })

  it('persists a dummy scrypt password and the Google subject for a new account', async () => {
    const repo = repository()
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp } })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })
    expect(repo.createUser).toHaveBeenCalledWith(expect.objectContaining({ googleSub: 'google-sub-1', passwordHash: expect.stringMatching(/^scrypt\$/) }), { session: 'mongo-session' })
    const passwordHash = repo.createUser.mock.calls[0][0].passwordHash
    await expect(verifyPassword('techpulse-dummy-password-only-for-timing', passwordHash)).resolves.toBe(false)
  })
  it('maps Mongo validation failures to 503 and emits only sanitized Google callback telemetry', async () => {
    const sentinel = 'mongodb://oauth-user:oauth-secret@private.example.test/?token=oauth-token'
    const repositoryError = Object.assign(new Error(sentinel), { name: 'MongoServerError', code: 121 })
    const logger = { error: vi.fn() }
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => { throw repositoryError }) })
    const service = createAuthService({
      repository: repo,
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      quotaKeyring: quotaKeyring(),
      clientIpAdapter: { getClientIp: (req) => req.testClientIp },
      logger,
    })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())
    const callbackRequest = {
      ...request(),
      requestId: 'oauth-request-1',
      serverRequestId: 'server-request-2',
      get: vi.fn((header) => header.toLowerCase() === 'x-vercel-id' ? 'iad1::deployment-123' : undefined),
    }

    await expect(service.googleLogin({ code: 'google-code-secret', state, stateCookie: state, request: callbackRequest })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })

    expect(logger.error).toHaveBeenCalledTimes(1)
    const event = logger.error.mock.calls[0][0]
    expect(event).toMatchObject({
      stage: 'google-oauth.callback',
      operation: 'findUserByGoogleSub',
      collection: 'users',
      requestId: 'oauth-request-1',
      serverRequestId: 'server-request-2',
      vercelId: 'iad1::deployment-123',
      name: 'MongoServerError',
      code: 121,
    })
    expect(event).not.toHaveProperty('message')
    expect(event).not.toHaveProperty('stack')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(sentinel)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('google-code-secret')
  })

  it('omits unsafe request and Vercel identifiers from repository telemetry', async () => {
    const repositoryError = Object.assign(new Error('private mongo diagnostic'), { name: 'MongoServerError', code: 121 })
    const logger = { error: vi.fn() }
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => { throw repositoryError }) })
    const service = createAuthService({
      repository: repo,
      runtime: RUNTIME,
      environment: ENVIRONMENT,
      quotaKeyring: quotaKeyring(),
      clientIpAdapter: { getClientIp: (req) => req.testClientIp },
      logger,
    })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())
    const callbackRequest = {
      ...request(),
      requestId: 'request id with secret',
      serverRequestId: 'server/request/secret',
      get: vi.fn(() => 'https://vercel.example/secret'),
    }

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: callbackRequest })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })

    const event = logger.error.mock.calls[0][0]
    expect(event).not.toHaveProperty('requestId')
    expect(event).not.toHaveProperty('serverRequestId')
    expect(event).not.toHaveProperty('vercelId')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret')
  })

  it('preserves the canonical 503 when the injected telemetry logger throws', async () => {
    const repositoryError = Object.assign(new Error('private mongo diagnostic'), { name: 'MongoServerError', code: 121 })
    const logger = { error: vi.fn(() => { throw new Error('logger failed') }) }
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => { throw repositoryError }) })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp }, logger })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
  })

  it('consumes a rejecting injected telemetry logger without replacing the canonical 503', async () => {
    let thenCalls = 0
    const loggerResult = {
      then(_resolve, reject) {
        thenCalls += 1
        queueMicrotask(() => reject(new Error('logger rejected')))
      },
    }
    const logger = { error: vi.fn(() => loggerResult) }
    const repositoryError = Object.assign(new Error('private mongo diagnostic'), { name: 'MongoServerError', code: 121 })
    const repo = repository({ findUserByGoogleSub: vi.fn(async () => { throw repositoryError }) })
    const service = createAuthService({ repository: repo, runtime: RUNTIME, environment: ENVIRONMENT, quotaKeyring: quotaKeyring(), clientIpAdapter: { getClientIp: (req) => req.testClientIp }, logger })
    const { state } = service.generateGoogleAuthUrl()
    vi.stubGlobal('fetch', googleFetch())

    await expect(service.googleLogin({ code: 'google-code', state, stateCookie: state, request: request() })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    await Promise.resolve()
    await Promise.resolve()
    expect(thenCalls).toBe(1)
  })

})
