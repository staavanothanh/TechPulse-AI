import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

export const RUNTIME_SCHEMA_ATTESTATIONS_ENV = 'RUNTIME_SCHEMA_ATTESTATIONS_JSON'
export const SCHEMA_ATTESTATION_PUBLIC_KEY_ENV = 'SCHEMA_ATTESTATION_PUBLIC_KEY'
export const SCHEMA_ATTESTATION_PRIVATE_KEY_ENV = 'SCHEMA_ATTESTATION_PRIVATE_KEY_ENV'

export const RUNTIME_SCHEMA_GENERATIONS = Object.freeze({
  'auth-core': 'auth-core-v1',
  sources: 'sources-v1',
  'durable-jobs': 'durable-jobs-v1',
  articles: 'articles-provider-routing-v2-v1',
  'indexing-jobs': 'indexing-jobs-drain-performance-v1',
  'provider-routing-v2': 'provider-routing-v2-v1',
  'chat-sessions': 'chat-sessions-provider-routing-v2-v1',
  'qa-evidence-fence': 'qa-evidence-fence-v1',
  governance: 'governance-provider-routing-v2-v1',
})

const PAYLOAD_KEYS = Object.freeze([
  'clusterBinding',
  'commit',
  'database',
  'generation',
  'scope',
  'verifiedAt',
  'version',
])
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length < 32) throw new Error(`${label} is invalid`)
  return decoded
}

function deploymentCommit(environment) {
  const commit = environment.VERCEL_GIT_COMMIT_SHA ?? environment.SCHEMA_ATTESTATION_COMMIT
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error('Schema attestation deployment commit is invalid')
  }
  return commit.toLowerCase()
}

function mongoAuthority(uri) {
  if (typeof uri !== 'string') throw new Error('Schema attestation database identity is invalid')
  const schemeEnd = uri.indexOf('://')
  if (schemeEnd < 1) throw new Error('Schema attestation database identity is invalid')
  const pathStart = uri.indexOf('/', schemeEnd + 3)
  const authorityWithCredentials = uri.slice(
    schemeEnd + 3,
    pathStart === -1 ? uri.length : pathStart,
  )
  const credentialEnd = authorityWithCredentials.lastIndexOf('@')
  const authority = authorityWithCredentials
    .slice(credentialEnd + 1)
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',')
  if (!authority) throw new Error('Schema attestation database identity is invalid')
  return authority
}

function databaseIdentity(environment) {
  const database = environment.MONGODB_DATABASE
  const uriEnvironmentName = environment.MONGODB_URI_ENV
  if (typeof database !== 'string' || !database.trim()) {
    throw new Error('Schema attestation database identity is invalid')
  }
  if (typeof uriEnvironmentName !== 'string' || !ENV_NAME_PATTERN.test(uriEnvironmentName)) {
    throw new Error('Schema attestation database identity is invalid')
  }
  const authority = mongoAuthority(environment[uriEnvironmentName])
  const clusterBinding = createHash('sha256')
    .update(`mongodb:${authority}|database:${database}`)
    .digest('hex')
  return Object.freeze({ database, clusterBinding })
}

function expectedPayload(scope, verifiedAt, environment) {
  const generation = schemaGenerationForVerificationTarget(scope)
  if (!generation) throw new Error(`Unsupported runtime schema scope: ${scope}`)
  const { database, clusterBinding } = databaseIdentity(environment)
  return Object.freeze({
    version: 1,
    scope,
    generation,
    verifiedAt,
    commit: deploymentCommit(environment),
    database,
    clusterBinding,
  })
}

function assertExactPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Runtime schema attestation payload is invalid')
  }
  const keys = Object.keys(payload).sort()
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== PAYLOAD_KEYS[index])
  ) {
    throw new Error('Runtime schema attestation payload is invalid')
  }
}

function readAttestation(scope, environment) {
  const encoded = environment[RUNTIME_SCHEMA_ATTESTATIONS_ENV]
  if (typeof encoded !== 'string' || !encoded.trim()) {
    throw new Error(`Runtime schema attestation is missing for ${scope}`)
  }
  let attestations
  try {
    attestations = JSON.parse(encoded)
  } catch {
    throw new Error('Runtime schema attestations are invalid')
  }
  const attestation = attestations?.[scope]
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
    throw new Error(`Runtime schema attestation is missing for ${scope}`)
  }
  if (
    Object.keys(attestation).length !== 2 ||
    !Object.hasOwn(attestation, 'payload') ||
    !Object.hasOwn(attestation, 'signature')
  ) {
    throw new Error(`Runtime schema attestation is invalid for ${scope}`)
  }
  return attestation
}

export function schemaGenerationForVerificationTarget(target) {
  return RUNTIME_SCHEMA_GENERATIONS[target] ?? null
}

export function issueReleaseVerifiedSchemaAttestation(
  scope,
  environment = process.env,
  now = new Date(),
) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Schema attestation verification time is invalid')
  }
  const privateKeyEnvironmentName = environment[SCHEMA_ATTESTATION_PRIVATE_KEY_ENV]
  if (
    typeof privateKeyEnvironmentName !== 'string' ||
    !ENV_NAME_PATTERN.test(privateKeyEnvironmentName)
  ) {
    throw new Error('Schema attestation private key environment is invalid')
  }
  const privateKey = createPrivateKey({
    key: decodeBase64(environment[privateKeyEnvironmentName], 'Schema attestation private key'),
    format: 'der',
    type: 'pkcs8',
  })
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Schema attestation private key is invalid')
  }
  const payload = expectedPayload(scope, now.toISOString(), environment)
  const signature = sign(null, Buffer.from(stableJson(payload)), privateKey).toString('base64url')
  return Object.freeze({ payload, signature })
}

export function assertReleaseVerifiedSchema(scope, environment = process.env, now = new Date()) {
  const generation = schemaGenerationForVerificationTarget(scope)
  if (!generation) throw new Error(`Unsupported runtime schema scope: ${scope}`)
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Schema attestation verification time is invalid')
  }

  const attestation = readAttestation(scope, environment)
  assertExactPayload(attestation.payload)
  const verifiedAt = new Date(attestation.payload.verifiedAt)
  if (
    Number.isNaN(verifiedAt.getTime()) ||
    verifiedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error(`Runtime schema attestation is invalid for ${scope}`)
  }
  const expected = expectedPayload(scope, verifiedAt.toISOString(), environment)
  if (stableJson(attestation.payload) !== stableJson(expected)) {
    throw new Error(`Runtime schema attestation is invalid for ${scope}`)
  }
  if (typeof attestation.signature !== 'string' || !BASE64URL_PATTERN.test(attestation.signature)) {
    throw new Error(`Runtime schema attestation signature is invalid for ${scope}`)
  }
  const signature = Buffer.from(attestation.signature, 'base64url')
  if (signature.length !== 64) {
    throw new Error(`Runtime schema attestation signature is invalid for ${scope}`)
  }
  const publicKey = createPublicKey({
    key: decodeBase64(
      environment[SCHEMA_ATTESTATION_PUBLIC_KEY_ENV],
      'Schema attestation public key',
    ),
    format: 'der',
    type: 'spki',
  })
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Schema attestation public key is invalid')
  }
  if (!verify(null, Buffer.from(stableJson(attestation.payload)), publicKey, signature)) {
    throw new Error(`Runtime schema attestation signature is invalid for ${scope}`)
  }
  return Object.freeze({
    scope,
    generation,
    verifiedAt: verifiedAt.toISOString(),
    commit: expected.commit,
  })
}

export function createReleaseVerifiedSchemaVerifier(scope, environment = process.env) {
  const attestation = assertReleaseVerifiedSchema(scope, environment)
  return async () => attestation
}
