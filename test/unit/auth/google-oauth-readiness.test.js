import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertAuthCoreReady, assertGoogleOAuthReady, isGoogleOAuthConfigured } from '../../../server/bootstrap/auth.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from '../../../scripts/migrations/auth-core.js'
import {
  GOOGLE_OAUTH_AUDIT_VALIDATOR,
  GOOGLE_OAUTH_COLLECTIONS,
  GOOGLE_OAUTH_INDEXES,
} from '../../../scripts/migrations/google-oauth.js'
import {
  PASSWORD_CHANGE_AUDIT_VALIDATOR,
  PASSWORD_CHANGE_RATE_LIMIT_VALIDATOR,
  PASSWORD_CHANGE_SESSIONS_VALIDATOR,
  PASSWORD_CHANGE_USERS_VALIDATOR,
} from '../../../scripts/migrations/password-change.js'
import { TOPIC_TAXONOMY_USERS_VALIDATOR } from '../../../scripts/migrations/topic-taxonomy-v1.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } from '../../../scripts/migrations/source-policy-reconciliation.js'
import {
  assertReleaseVerifiedSchema,
  issueReleaseVerifiedSchemaAttestation,
  RUNTIME_SCHEMA_ATTESTATIONS_ENV,
  RUNTIME_SCHEMA_GENERATIONS,
  SCHEMA_ATTESTATION_PRIVATE_KEY_ENV,
  SCHEMA_ATTESTATION_PUBLIC_KEY_ENV,
  schemaGenerationForVerificationTarget,
} from '../../../server/bootstrap/schema-readiness.js'

function readyContext({
  userValidator = GOOGLE_OAUTH_COLLECTIONS.users.validator,
  auditValidator = GOOGLE_OAUTH_AUDIT_VALIDATOR,
  rateLimitValidator = AUTH_CORE_COLLECTIONS.rateLimitBuckets.validator,
  sessionsValidator = AUTH_CORE_COLLECTIONS.sessions.validator,
} = {}) {
  const definitions = Object.entries(AUTH_CORE_COLLECTIONS).map(([name, definition]) => [
    name,
    name === 'users'
      ? { validator: userValidator }
      : name === 'adminAuditLogs'
        ? { validator: auditValidator }
        : name === 'rateLimitBuckets'
          ? { validator: rateLimitValidator }
          : name === 'sessions'
            ? { validator: sessionsValidator }
            : definition,
  ])
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
  it('accepts the terminal source-policy audit validator for OAuth readiness', async () => {
    const context = readyContext({ auditValidator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR })
    await expect(assertAuthCoreReady(context)).resolves.toBeUndefined()
    await expect(assertGoogleOAuthReady(context)).resolves.toBeUndefined()
  })

  it('accepts the final password-change validators across auth and OAuth readiness', async () => {
    const context = readyContext({
      userValidator: PASSWORD_CHANGE_USERS_VALIDATOR,
      auditValidator: PASSWORD_CHANGE_AUDIT_VALIDATOR,
      rateLimitValidator: PASSWORD_CHANGE_RATE_LIMIT_VALIDATOR,
      sessionsValidator: PASSWORD_CHANGE_SESSIONS_VALIDATOR,
    })
    await expect(assertAuthCoreReady(context)).resolves.toBeUndefined()
    await expect(assertGoogleOAuthReady(context)).resolves.toBeUndefined()
  })

  it('generates and verifies a signed password-change attestation with its registered generation', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const privateKeyEnv = 'ATTESTATION_PRIVATE_KEY'
    const now = new Date('2026-09-08T00:00:00.000Z')
    const environment = {
      MONGODB_DATABASE: 'techpulse',
      MONGODB_URI_ENV: 'MONGODB_URI',
      MONGODB_URI: 'mongodb://attestation-user:attestation-password@cluster.example.test/techpulse',
      VERCEL_GIT_COMMIT_SHA: 'A'.repeat(40),
      [SCHEMA_ATTESTATION_PRIVATE_KEY_ENV]: privateKeyEnv,
      [privateKeyEnv]: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      [SCHEMA_ATTESTATION_PUBLIC_KEY_ENV]: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    }
    const generated = issueReleaseVerifiedSchemaAttestation('password-change', environment, now)
    const signedEnvironment = { ...environment, [RUNTIME_SCHEMA_ATTESTATIONS_ENV]: JSON.stringify({ 'password-change': generated }) }

    expect(RUNTIME_SCHEMA_GENERATIONS['password-change']).toBe('password-change-v1')
    expect(schemaGenerationForVerificationTarget('password-change')).toBe('password-change-v1')
    expect(generated.payload).toMatchObject({ scope: 'password-change', generation: 'password-change-v1' })
    expect(assertReleaseVerifiedSchema('password-change', signedEnvironment, now)).toMatchObject({ scope: 'password-change', generation: 'password-change-v1' })
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
