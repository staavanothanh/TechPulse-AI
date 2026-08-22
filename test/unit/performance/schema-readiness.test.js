import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createConfiguredContentServices } from '../../../server/bootstrap/content.js'
import { createConfiguredRuntimeFactories } from '../../../server/bootstrap/lazy-runtime.js'
import {
  assertReleaseVerifiedSchema,
  createReleaseVerifiedSchemaVerifier,
  issueReleaseVerifiedSchemaAttestation,
  RUNTIME_SCHEMA_ATTESTATIONS_ENV,
  RUNTIME_SCHEMA_GENERATIONS,
  schemaGenerationForVerificationTarget,
  SCHEMA_ATTESTATION_PRIVATE_KEY_ENV,
  SCHEMA_ATTESTATION_PUBLIC_KEY_ENV,
} from '../../../server/bootstrap/schema-readiness.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PRIVATE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
const PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const NOW = new Date('2026-08-22T09:00:00.000Z')
const BASE_ENVIRONMENT = Object.freeze({
  MONGODB_URI_ENV: 'MONGODB_URI',
  MONGODB_URI: 'mongodb+srv://runtime-user:runtime-password@cluster.example.test/?retryWrites=true',
  MONGODB_DATABASE: 'techpulse_app',
  SCHEMA_ATTESTATION_COMMIT: 'a'.repeat(40),
  [SCHEMA_ATTESTATION_PUBLIC_KEY_ENV]: PUBLIC_KEY,
  [SCHEMA_ATTESTATION_PRIVATE_KEY_ENV]: 'TEST_SCHEMA_ATTESTATION_PRIVATE_KEY',
  TEST_SCHEMA_ATTESTATION_PRIVATE_KEY: PRIVATE_KEY,
})

function signedEnvironment(
  scopes = Object.keys(RUNTIME_SCHEMA_GENERATIONS),
  overrides = {},
  now = NOW,
) {
  const environment = { ...BASE_ENVIRONMENT, ...overrides }
  const attestations = Object.fromEntries(
    scopes.map((scope) => [scope, issueReleaseVerifiedSchemaAttestation(scope, environment, now)]),
  )
  return {
    ...environment,
    [RUNTIME_SCHEMA_ATTESTATIONS_ENV]: JSON.stringify(attestations),
  }
}

function replaceAttestation(environment, scope, transform) {
  const attestations = JSON.parse(environment[RUNTIME_SCHEMA_ATTESTATIONS_ENV])
  return {
    ...environment,
    [RUNTIME_SCHEMA_ATTESTATIONS_ENV]: JSON.stringify({
      ...attestations,
      [scope]: transform(attestations[scope]),
    }),
  }
}

describe('release-verified runtime schema readiness', () => {
  it('accepts a release signature for every runtime scope', async () => {
    const environment = signedEnvironment()

    for (const [scope, generation] of Object.entries(RUNTIME_SCHEMA_GENERATIONS)) {
      const expected = {
        scope,
        generation,
        verifiedAt: NOW.toISOString(),
        commit: 'a'.repeat(40),
      }
      expect(assertReleaseVerifiedSchema(scope, environment, NOW)).toEqual(expected)
      await expect(createReleaseVerifiedSchemaVerifier(scope, environment)()).resolves.toEqual(
        expected,
      )
      expect(schemaGenerationForVerificationTarget(scope)).toBe(generation)
    }
  })

  it('does not include the MongoDB URI, credentials, or private key in the envelope', () => {
    const envelope = signedEnvironment(['articles'])[RUNTIME_SCHEMA_ATTESTATIONS_ENV]

    expect(envelope).not.toContain('runtime-user')
    expect(envelope).not.toContain('runtime-password')
    expect(envelope).not.toContain(PRIVATE_KEY)
    expect(envelope).not.toContain('mongodb+srv')
  })

  it('fails closed for every missing runtime scope', () => {
    for (const scope of Object.keys(RUNTIME_SCHEMA_GENERATIONS)) {
      const includedScopes = Object.keys(RUNTIME_SCHEMA_GENERATIONS).filter(
        (candidate) => candidate !== scope,
      )
      expect(() =>
        assertReleaseVerifiedSchema(scope, signedEnvironment(includedScopes), NOW),
      ).toThrow(/attestation/i)
    }
  })

  it.each([
    {},
    { ...BASE_ENVIRONMENT, [RUNTIME_SCHEMA_ATTESTATIONS_ENV]: '{}' },
    { ...BASE_ENVIRONMENT, [RUNTIME_SCHEMA_ATTESTATIONS_ENV]: '{invalid' },
  ])('fails closed when the release cache is absent or malformed', (environment) => {
    expect(() => assertReleaseVerifiedSchema('articles', environment, NOW)).toThrow(/attestation/i)
  })

  it('rejects tampered payloads and signatures', () => {
    const environment = signedEnvironment(['articles'])
    const tamperedPayload = replaceAttestation(environment, 'articles', (attestation) => ({
      ...attestation,
      payload: { ...attestation.payload, generation: 'articles-unverified' },
    }))
    const tamperedSignature = replaceAttestation(environment, 'articles', (attestation) => ({
      ...attestation,
      signature: `${attestation.signature[0] === 'A' ? 'B' : 'A'}${attestation.signature.slice(1)}`,
    }))

    expect(() => assertReleaseVerifiedSchema('articles', tamperedPayload, NOW)).toThrow(
      /attestation/i,
    )
    expect(() => assertReleaseVerifiedSchema('articles', tamperedSignature, NOW)).toThrow(
      /signature/i,
    )
  })

  it.each([
    ['deployment commit', { SCHEMA_ATTESTATION_COMMIT: 'b'.repeat(40) }],
    ['MongoDB cluster', { MONGODB_URI: 'mongodb+srv://user:password@other.example.test/' }],
    ['MongoDB database', { MONGODB_DATABASE: 'other_app' }],
  ])('rejects an envelope copied to another %s', (_label, overrides) => {
    const environment = signedEnvironment(['articles'])
    expect(() =>
      assertReleaseVerifiedSchema('articles', { ...environment, ...overrides }, NOW),
    ).toThrow(/attestation/i)
  })

  it('rejects the wrong public key and a future verification time', () => {
    const environment = signedEnvironment(['articles'])
    const otherKey = generateKeyPairSync('ed25519')
      .publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64')
    const futureEnvironment = signedEnvironment(
      ['articles'],
      {},
      new Date(NOW.getTime() + 10 * 60 * 1000),
    )

    expect(() =>
      assertReleaseVerifiedSchema(
        'articles',
        { ...environment, [SCHEMA_ATTESTATION_PUBLIC_KEY_ENV]: otherKey },
        NOW,
      ),
    ).toThrow(/signature/i)
    expect(() => assertReleaseVerifiedSchema('articles', futureEnvironment, NOW)).toThrow(
      /attestation/i,
    )
  })

  it('does not accept an unregistered readiness scope', () => {
    expect(() => assertReleaseVerifiedSchema('unknown', signedEnvironment(), NOW)).toThrow(
      /unsupported/i,
    )
    expect(schemaGenerationForVerificationTarget('unknown')).toBeNull()
  })

  it('constructs content without collection/index metadata calls when verification is injected', async () => {
    const verifySchema = vi.fn(async () => undefined)
    const listCollections = vi.fn(() => {
      throw new Error('must not run')
    })
    const indexes = vi.fn(async () => {
      throw new Error('must not run')
    })
    const context = {
      client: {},
      db: {
        listCollections,
        collection(name) {
          if (name === 'sources') return { find: () => ({ toArray: async () => [] }) }
          return { indexes }
        },
      },
    }

    const configured = await createConfiguredContentServices({ context, verifySchema })
    expect(configured.articleService.list).toBeTypeOf('function')
    expect(verifySchema).toHaveBeenCalledExactlyOnceWith(context)
    expect(listCollections).not.toHaveBeenCalled()
    expect(indexes).not.toHaveBeenCalled()
  })

  it.each([
    ['auth-core', 'common', []],
    ['articles', 'content', [{ common: {} }]],
    ['sources', 'sources', [{ common: {} }]],
    ['durable-jobs', 'jobs', [{ common: {} }]],
    ['governance', 'jobs', [{ common: {} }]],
    ['indexing-jobs', 'indexing', [{ common: {}, jobs: {} }]],
    ['provider-routing-v2', 'indexing', [{ common: {}, jobs: {} }]],
    ['chat-sessions', 'qa', [{ common: {}, jobs: {}, indexing: {} }]],
    ['provider-routing-v2', 'qa', [{ common: {}, jobs: {}, indexing: {} }]],
    ['governance', 'governance', [{ common: {} }]],
  ])(
    'fails the %s dependency before starting the %s runtime factory',
    async (missingScope, factoryName, args) => {
      const includedScopes = Object.keys(RUNTIME_SCHEMA_GENERATIONS).filter(
        (candidate) => candidate !== missingScope,
      )
      const factories = createConfiguredRuntimeFactories({
        environment: signedEnvironment(includedScopes, {}, new Date()),
      })

      await expect(factories[factoryName](...(args ?? []))).rejects.toThrow(/attestation/i)
    },
  )
})
