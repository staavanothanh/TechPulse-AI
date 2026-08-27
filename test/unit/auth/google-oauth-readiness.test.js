import { describe, expect, it } from 'vitest'
import { assertAuthCoreReady, assertGoogleOAuthReady, isGoogleOAuthConfigured } from '../../../server/bootstrap/auth.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from '../../../scripts/migrations/auth-core.js'
import {
  GOOGLE_OAUTH_AUDIT_VALIDATOR,
  GOOGLE_OAUTH_COLLECTIONS,
  GOOGLE_OAUTH_INDEXES,
} from '../../../scripts/migrations/google-oauth.js'
import { TOPIC_TAXONOMY_USERS_VALIDATOR } from '../../../scripts/migrations/topic-taxonomy-v1.js'

function readyContext({ userValidator = GOOGLE_OAUTH_COLLECTIONS.users.validator } = {}) {
  const definitions = Object.entries(AUTH_CORE_COLLECTIONS).map(([name, definition]) => [name, name === 'users' ? { validator: userValidator } : name === 'adminAuditLogs' ? { validator: GOOGLE_OAUTH_AUDIT_VALIDATOR } : definition])
  const indexes = Object.fromEntries(Object.entries(AUTH_CORE_INDEXES).map(([name, values]) => [name, [...values, ...(name === 'users' ? GOOGLE_OAUTH_INDEXES.users : [])]]))
  const collections = definitions.map(([name, definition]) => ({ name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } }))
  return {
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({ indexes: async () => indexes[name].map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) }),
    },
  }
}

describe('Google OAuth readiness boundary', () => {
  it('accepts auth-core only after the OAuth successor validator and index are present', async () => {
    await expect(assertAuthCoreReady(readyContext())).resolves.toBeUndefined()
    await expect(assertGoogleOAuthReady(readyContext())).resolves.toBeUndefined()
  })
  it('accepts the taxonomy successor users validator for both auth and OAuth readiness', async () => {
    const context = readyContext({ userValidator: TOPIC_TAXONOMY_USERS_VALIDATOR })
    await expect(assertAuthCoreReady(context)).resolves.toBeUndefined()
    await expect(assertGoogleOAuthReady(context)).resolves.toBeUndefined()
  })

  it('keeps OAuth schema readiness optional when Google env names are absent', () => {
    const runtime = {
      googleOAuth: { clientIdEnv: null, clientSecretEnv: null, redirectUriEnv: null, stateSecretEnv: null },
    }
    expect(isGoogleOAuthConfigured(runtime)).toBe(false)
  })

  it('requires OAuth schema readiness once any Google env name is configured', () => {
    const runtime = {
      googleOAuth: { clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET', redirectUriEnv: 'GOOGLE_REDIRECT_URI', stateSecretEnv: 'GOOGLE_OAUTH_STATE_SECRET' },
    }
    expect(isGoogleOAuthConfigured(runtime)).toBe(true)
  })
})
