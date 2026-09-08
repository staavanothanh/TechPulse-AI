import { describe, expect, it, vi } from 'vitest'

describe('Google OAuth lazy runtime attestation', () => {
  it('does not evaluate the optional OAuth attestation when env names are absent', async () => {
    vi.resetModules()
    const requestedScopes = []
    vi.doMock('../../../server/bootstrap/auth.js', () => ({
      createConfiguredAuthService: vi.fn(async () => ({ authRepository: {}, quotaKeyring: {} })),
    }))
    vi.doMock('../../../server/security/rate-limit-admission.js', () => ({
      createRateLimitAdmission: vi.fn(() => ({})),
    }))
    vi.doMock('../../../server/bootstrap/schema-readiness.js', () => ({
      createReleaseVerifiedSchemaVerifier: vi.fn((scope) => {
        requestedScopes.push(scope)
        return async () => undefined
      }),
    }))

    const { createConfiguredRuntimeFactories } = await import('../../../server/bootstrap/lazy-runtime.js')
    const factories = createConfiguredRuntimeFactories({ environment: {} })
    await factories.common()

    expect(requestedScopes).toEqual(['auth-core', 'password-change', 'topic-taxonomy-v1'])
  })

  it('evaluates the OAuth attestation only after any Google env name enables the feature', async () => {
    vi.resetModules()
    const requestedScopes = []
    vi.doMock('../../../server/bootstrap/auth.js', () => ({
      createConfiguredAuthService: vi.fn(async () => ({ authRepository: {}, quotaKeyring: {} })),
    }))
    vi.doMock('../../../server/security/rate-limit-admission.js', () => ({
      createRateLimitAdmission: vi.fn(() => ({})),
    }))
    vi.doMock('../../../server/bootstrap/schema-readiness.js', () => ({
      createReleaseVerifiedSchemaVerifier: vi.fn((scope) => {
        requestedScopes.push(scope)
        return async () => undefined
      }),
    }))

    const { createConfiguredRuntimeFactories } = await import('../../../server/bootstrap/lazy-runtime.js')
    const factories = createConfiguredRuntimeFactories({ environment: { GOOGLE_OAUTH_CLIENT_ID_ENV: 'GOOGLE_CLIENT_ID' } })
    await factories.common()

    expect(requestedScopes).toEqual(['auth-core', 'password-change', 'topic-taxonomy-v1', 'google-oauth'])
  })

  it('does not load common auth when the password-change attestation is absent', async () => {
    vi.resetModules()
    const requestedScopes = []
    const createConfiguredAuthService = vi.fn(async ({ verifySchema }) => {
      await verifySchema({})
      return { authRepository: {}, quotaKeyring: {} }
    })
    vi.doMock('../../../server/bootstrap/auth.js', () => ({ createConfiguredAuthService }))
    vi.doMock('../../../server/security/rate-limit-admission.js', () => ({
      createRateLimitAdmission: vi.fn(() => ({})),
    }))
    vi.doMock('../../../server/bootstrap/schema-readiness.js', () => ({
      createReleaseVerifiedSchemaVerifier: vi.fn((scope) => {
        requestedScopes.push(scope)
        return async () => {
          if (scope === 'password-change') throw new Error('password-change attestation is missing')
        }
      }),
    }))

    const { createConfiguredRuntimeFactories } = await import('../../../server/bootstrap/lazy-runtime.js')
    const factories = createConfiguredRuntimeFactories({ environment: {} })

    await expect(factories.common()).rejects.toThrow('password-change attestation is missing')
    expect(requestedScopes).toEqual(['auth-core', 'password-change', 'topic-taxonomy-v1'])
  })
})
