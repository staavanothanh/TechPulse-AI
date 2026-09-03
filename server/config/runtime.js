import { validateProviderConfiguration } from '../ai/provider-registry.js'

const ORIGIN_PATTERN = /^https:\/\/[^/]+$|^http:\/\/localhost(?::\d+)?$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/
const RESERVED_MONGO_DATABASES = new Set(['admin', 'config', 'local'])

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value.trim()
}

function envName(value, name) {
  const result = requiredString(value, name)
  if (!ENV_NAME_PATTERN.test(result)) throw new Error(`${name} must be an environment variable name`)
  return result
}

function optionalEnvName(value, name) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null
  return envName(value, name)
}

function csv(value) {
  if (value === undefined || value === '') return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function keyring(current, retiring, label, maxRetiring = 2, currentVersionInput, retiringVersionsInput) {
  const currentEnv = envName(current, `${label} current key env`)
  const retiringEnvs = csv(retiring).map((item) => envName(item, `${label} retiring key env`))
  if (new Set(retiringEnvs).size !== retiringEnvs.length || retiringEnvs.includes(currentEnv)) {
    throw new Error(`${label} keyring contains duplicate/current retiring env`)
  }
  if (retiringEnvs.length > maxRetiring) throw new Error(`${label} keyring allows at most ${maxRetiring} retiring keys`)
  const currentVersion = currentVersionInput === undefined ? 1 : Number(currentVersionInput)
  if (currentVersion > 1 && retiringEnvs.length > 0 && retiringVersionsInput === undefined) throw new Error(`${label} retiring versions are required after rotation`)
  const retiringVersions = retiringVersionsInput === undefined
    ? retiringEnvs.map((_name, index) => currentVersion + index + 1)
    : csv(retiringVersionsInput).map((value) => Number(value))
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1 || retiringVersions.length !== retiringEnvs.length || retiringVersions.some((version) => !Number.isSafeInteger(version) || version < 1) || new Set([currentVersion, ...retiringVersions]).size !== 1 + retiringVersions.length) {
    throw new Error(`${label} keyring versions are invalid`)
  }
  const versionToEnv = new Map([[currentVersion, currentEnv], ...retiringVersions.map((version, index) => [version, retiringEnvs[index]])])
  const versions = Object.freeze([...versionToEnv.keys()])
  return {
    currentEnv,
    retiringEnvs,
    currentVersion,
    retiringVersions: Object.freeze(retiringVersions),
    versions: Object.freeze(versions),
    acceptsVersion(version) {
      return versionToEnv.has(version)
    },
    envForVersion(version) {
      return versionToEnv.get(version)
    },
  }
}

function mongoConfiguration(input) {
  const uriEnv = envName(input.MONGODB_URI_ENV, 'MongoDB URI env')
  const database = requiredString(input.MONGODB_DATABASE, 'MongoDB database name')
  if (!DATABASE_NAME_PATTERN.test(database) || database.includes('..') || RESERVED_MONGO_DATABASES.has(database.toLowerCase())) {
    throw new Error('MongoDB database name must be safe')
  }
  return Object.freeze({ uriEnv, database })
}

function maintenanceMongoConfiguration(input) {
  const uriEnv = optionalEnvName(input.MONGODB_MAINTENANCE_URI_ENV, 'MongoDB maintenance URI env')
  if (!uriEnv) return null
  if (uriEnv === input.MONGODB_URI_ENV) throw new Error('MongoDB maintenance URI env must be separate from runtime URI env')
  const database = requiredString(input.MONGODB_DATABASE, 'MongoDB database name')
  return Object.freeze({ uriEnv, database })
}

export function validateMongoConfiguration(input = process.env) {
  return mongoConfiguration(input)
}

function providerConfiguration(value, input) {
  const parsed = JSON.parse(value || '[]')
  const credentialEnvNames = Object.entries(input)
    .filter(([, secret]) => typeof secret === 'string' && secret.length > 0)
    .map(([name]) => name)
  return validateProviderConfiguration(parsed, { credentialEnvNames })
}
const MIN_MACHINE_SECRET_BYTES = 32
const PLACEHOLDER_MACHINE_SECRET = /^(?:<[^>]+>|change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ]?secret)$/i

function assertMachineSecret(environment, envName) {
  const value = environment?.[envName]
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') < MIN_MACHINE_SECRET_BYTES || PLACEHOLDER_MACHINE_SECRET.test(value.trim())) {
    throw new Error('Internal machine secret must be at least 32 bytes and must not be a placeholder')
  }
  return envName
}


export function validateRuntimeConfiguration(input = process.env) {
  const origins = csv(input.PUBLIC_APP_ORIGINS)
  if (origins.length === 0 || origins.some((origin) => !ORIGIN_PATTERN.test(origin))) {
    throw new Error('PUBLIC_APP_ORIGINS must contain exact HTTPS or localhost origins')
  }
  const quotaKeyring = keyring(input.QUOTA_HMAC_CURRENT_KEY_ENV, input.QUOTA_HMAC_RETIRING_KEY_ENVS, 'quota HMAC', 2, input.QUOTA_HMAC_CURRENT_KEY_VERSION, input.QUOTA_HMAC_RETIRING_KEY_VERSIONS)
  if (quotaKeyring.retiringVersions.some((version) => version >= quotaKeyring.currentVersion)) throw new Error('quota HMAC retiring versions must be monotonic predecessors')
  const governanceKeyring = keyring(
    input.GOVERNANCE_SIGNING_CURRENT_KEY_ENV,
    input.GOVERNANCE_SIGNING_RETIRING_KEY_ENVS,
    'governance signing',
    1,
  )
  const checkpointKeyIds = csv(input.OFFLINE_CHECKPOINT_KEY_IDS)
  if (checkpointKeyIds.length === 0 || checkpointKeyIds.length > 3 || checkpointKeyIds.some((id) => !KEY_ID_PATTERN.test(id))) {
    throw new Error('OFFLINE_CHECKPOINT_KEY_IDS must contain safe key IDs')
  }
  const machineSecretEnv = assertMachineSecret(input, envName(input.INTERNAL_MACHINE_SECRET_ENV, 'internal machine secret env'))
  const googleOAuth = {
    clientIdEnv: optionalEnvName(input.GOOGLE_OAUTH_CLIENT_ID_ENV, 'Google OAuth client ID env'),
    clientSecretEnv: optionalEnvName(input.GOOGLE_OAUTH_CLIENT_SECRET_ENV, 'Google OAuth client secret env'),
    redirectUriEnv: optionalEnvName(input.GOOGLE_OAUTH_REDIRECT_URI_ENV, 'Google OAuth redirect URI env'),
    stateSecretEnv: optionalEnvName(input.GOOGLE_OAUTH_STATE_SECRET_ENV, 'Google OAuth state secret env'),
  }
  const googleOAuthConfigured = Object.values(googleOAuth).some(Boolean)
  if (googleOAuthConfigured && Object.values(googleOAuth).some((value) => !value)) throw new Error('Google OAuth environment names must be configured together')
  if (googleOAuthConfigured) {
    const redirectValue = requiredString(input[googleOAuth.redirectUriEnv], 'Google OAuth redirect URI')
    let redirect
    try { redirect = new URL(redirectValue) } catch { throw new Error('Google OAuth redirect URI is invalid') }
    if (!['https:', 'http:'].includes(redirect.protocol) || (redirect.protocol === 'http:' && redirect.hostname !== 'localhost') || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/api/v1/auth/google/callback' || !origins.includes(redirect.origin)) {
      throw new Error('Google OAuth redirect URI must match a configured public origin')
    }
  }
  return {
    origins,
    mongo: mongoConfiguration(input),
    maintenanceMongo: maintenanceMongoConfiguration(input),
    quotaKeyring,
    governanceKeyring,
    checkpointKeyIds,
    providerRegistry: providerConfiguration(input.PROVIDER_ADMISSION_DOMAINS_JSON, input),
    internalMachineSecretEnv: machineSecretEnv,
    googleOAuth,
  }
}

export const RUNTIME_ENV_CONTRACT = Object.freeze([
  'PUBLIC_APP_ORIGINS',
  'MONGODB_URI_ENV',
  'MONGODB_MAINTENANCE_URI_ENV',
  'MONGODB_DATABASE',
  'QUOTA_HMAC_CURRENT_KEY_ENV',
  'QUOTA_HMAC_RETIRING_KEY_ENVS',
  'QUOTA_HMAC_CURRENT_KEY_VERSION',
  'QUOTA_HMAC_RETIRING_KEY_VERSIONS',
  'GOVERNANCE_SIGNING_CURRENT_KEY_ENV',
  'GOVERNANCE_SIGNING_RETIRING_KEY_ENVS',
  'OFFLINE_CHECKPOINT_KEY_IDS',
  'PROVIDER_ADMISSION_DOMAINS_JSON',
  'INTERNAL_MACHINE_SECRET_ENV',
  'RUNTIME_SCHEMA_ATTESTATIONS_JSON',
  'SCHEMA_ATTESTATION_PUBLIC_KEY',
  'SCHEMA_ATTESTATION_COMMIT',
  'GOOGLE_OAUTH_CLIENT_ID_ENV',
  'GOOGLE_OAUTH_CLIENT_SECRET_ENV',
  'GOOGLE_OAUTH_REDIRECT_URI_ENV',
  'GOOGLE_OAUTH_STATE_SECRET_ENV',
])
