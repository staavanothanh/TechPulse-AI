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

export function validateMongoConfiguration(input = process.env) {
  return mongoConfiguration(input)
}

function providerDomains(value) {
  const parsed = JSON.parse(value || '[]')
  if (!Array.isArray(parsed)) throw new Error('PROVIDER_ADMISSION_DOMAINS_JSON must be an array')
  return validateProviderConfiguration(parsed)
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
  const machineSecretEnv = envName(input.INTERNAL_MACHINE_SECRET_ENV, 'internal machine secret env')
  return {
    origins,
    mongo: mongoConfiguration(input),
    quotaKeyring,
    governanceKeyring,
    checkpointKeyIds,
    providerAdmissionDomains: providerDomains(input.PROVIDER_ADMISSION_DOMAINS_JSON),
    internalMachineSecretEnv: machineSecretEnv,
  }
}

export const RUNTIME_ENV_CONTRACT = Object.freeze([
  'PUBLIC_APP_ORIGINS',
  'MONGODB_URI_ENV',
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
])
