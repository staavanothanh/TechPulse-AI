import { validateRuntimeConfiguration } from '../config/runtime.js'
import { createClientIpAdapter } from '../http/middleware/client-ip.js'
import { createAuthService } from '../application/auth/service.js'
import { createHmacKeyring } from '../security/hmac-keyring.js'
import { reconcileQuotaHmacLifecycle } from '../security/hmac-lifecycle.js'
import { MongoAuthRepository } from '../repositories/mongo/auth-repository.js'
import { getMongoContext } from '../repositories/mongo/connection.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from '../../scripts/migrations/auth-core.js'
import { SOURCE_AUDIT_VALIDATOR } from '../../scripts/migrations/sources.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/durable-jobs.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/indexing-jobs.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from '../../scripts/migrations/governance-audit.js'
import {
  GOOGLE_OAUTH_AUDIT_VALIDATOR,
  GOOGLE_OAUTH_COLLECTIONS,
  GOOGLE_OAUTH_INDEXES,
} from '../../scripts/migrations/google-oauth.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } from '../../scripts/migrations/source-policy-reconciliation.js'
import { TOPIC_TAXONOMY_USERS_VALIDATOR } from '../../scripts/migrations/topic-taxonomy-v1.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function isGoogleOAuthConfigured(runtime) {
  return Object.values(runtime?.googleOAuth ?? {}).some(Boolean)
}

export async function assertAuthCoreReady(context) {
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const name of Object.keys(AUTH_CORE_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    const acceptedValidators = name === 'users'
      ? [AUTH_CORE_COLLECTIONS[name].validator, GOOGLE_OAUTH_COLLECTIONS.users.validator, TOPIC_TAXONOMY_USERS_VALIDATOR]
      : name === 'adminAuditLogs'
        ? [AUTH_CORE_COLLECTIONS[name].validator, SOURCE_AUDIT_VALIDATOR, DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR]
        : [AUTH_CORE_COLLECTIONS[name].validator]
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !collection.options?.validator || !acceptedValidators.some((validator) => stableJson(collection.options.validator) === stableJson(validator))) {
      throw new Error('auth-core validator is not ready')
    }
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    for (const expected of AUTH_CORE_INDEXES[name]) {
      const actual = actualByName.get(expected.name)
      if (!exactMongoIndex(actual, expected)) throw new Error('auth-core indexes are not ready')
    }
  }
}

export async function assertGoogleOAuthReady(context) {
  await assertAuthCoreReady(context)
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const [name, definition] of Object.entries(GOOGLE_OAUTH_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || ![definition.validator, ...(name === 'users' ? [TOPIC_TAXONOMY_USERS_VALIDATOR] : []), ...(name === 'adminAuditLogs' ? [SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR] : [])].some((validator) => stableJson(collection.options?.validator) === stableJson(validator))) throw new Error('google-oauth validator is not ready')
  }
  const usersIndexes = new Map((await context.db.collection('users').indexes()).map((index) => [index.name, index]))
  for (const expected of GOOGLE_OAUTH_INDEXES.users) if (!exactMongoIndex(usersIndexes.get(expected.name), expected)) throw new Error('google-oauth indexes are not ready')
  return undefined
}

export async function createConfiguredAuthService({ environment = process.env, rateLimitAdmission, verifySchema = assertAuthCoreReady, verifyOAuthSchema = assertGoogleOAuthReady } = {}) {
  const runtime = validateRuntimeConfiguration(environment)
  const context = await getMongoContext(runtime, environment)
  const repository = new MongoAuthRepository(context)
  await verifySchema(context)
  // Google OAuth is an optional capability. Keep password/session auth
  // available until the four Google env names, migration, and attestation are
  // explicitly configured for this deployment.
  if (isGoogleOAuthConfigured(runtime)) await verifyOAuthSchema(context)
  const quotaKeyring = createHmacKeyring({
    currentEnv: runtime.quotaKeyring.currentEnv,
    retiringEnvs: runtime.quotaKeyring.retiringEnvs,
    currentVersion: runtime.quotaKeyring.currentVersion,
    retiringVersions: runtime.quotaKeyring.retiringVersions,
    values: environment,
  })
  const governanceKeyring = createHmacKeyring({
    currentEnv: runtime.governanceKeyring.currentEnv,
    retiringEnvs: runtime.governanceKeyring.retiringEnvs,
    currentVersion: runtime.governanceKeyring.currentVersion,
    retiringVersions: runtime.governanceKeyring.retiringVersions,
    values: environment,
  })
  await reconcileQuotaHmacLifecycle({ repository, keyring: quotaKeyring })
  const unknownRateLimitVersions = await repository.countUnknownRateLimitKeyVersions(quotaKeyring.versions)
  if (unknownRateLimitVersions > 0) throw new Error('quota HMAC retirement gate failed: dependent rate-limit records remain')
  const rateLimitFingerprintMismatches = await repository.countRateLimitFingerprintMismatches(quotaKeyring)
  if (rateLimitFingerprintMismatches > 0) throw new Error('rate-limit key fingerprint continuity check failed')
  const unknownIpHmacVersions = await repository.countUnknownIpHmacKeyVersions(quotaKeyring.versions)
  if (unknownIpHmacVersions > 0) throw new Error('quota HMAC retirement gate failed: dependent IP HMAC records remain')
  const mode = environment.VERCEL === '1' || environment.VERCEL === 'true' ? 'production' : environment.NODE_ENV === 'test' ? 'test' : 'local'
  return {
    authService: createAuthService({ repository, runtime, environment, quotaKeyring, rateLimitAdmission, clientIpAdapter: createClientIpAdapter({ mode }) }),
    authRepository: repository,
    quotaKeyring,
    governanceKeyring,
    context,
    runtime,
  }
}
