const ORIGIN_PATTERN = /^https:\/\/[^/]+$|^http:\/\/localhost(?::\d+)?$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

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

function keyring(current, retiring, label, maxRetiring = 2) {
  const currentEnv = envName(current, `${label} current key env`)
  const retiringEnvs = csv(retiring).map((item) => envName(item, `${label} retiring key env`))
  if (new Set(retiringEnvs).size !== retiringEnvs.length || retiringEnvs.includes(currentEnv)) {
    throw new Error(`${label} keyring contains duplicate/current retiring env`)
  }
  if (retiringEnvs.length > maxRetiring) throw new Error(`${label} keyring allows at most ${maxRetiring} retiring keys`)
  return { currentEnv, retiringEnvs }
}

function providerDomains(value) {
  const parsed = JSON.parse(value || '[]')
  if (!Array.isArray(parsed)) throw new Error('PROVIDER_ADMISSION_DOMAINS_JSON must be an array')
  const domainIds = new Set()
  const credentialEnvNames = new Map()
  const routeIds = new Set()
  for (const domain of parsed) {
    if (!domain || typeof domain !== 'object') throw new Error('provider admission domain must be an object')
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(domain.admissionDomainId)) throw new Error('invalid admissionDomainId')
    if (domainIds.has(domain.admissionDomainId)) throw new Error('duplicate admissionDomainId')
    domainIds.add(domain.admissionDomainId)
    const credential = envName(domain.credentialEnvName, 'provider credentialEnvName')
    const previous = credentialEnvNames.get(credential)
    if (previous && previous !== domain.admissionDomainId) throw new Error('credential split across admission domains')
    credentialEnvNames.set(credential, domain.admissionDomainId)
    if (!Number.isInteger(domain.maxConcurrency) || domain.maxConcurrency < 1 || domain.maxConcurrency > 8) {
      throw new Error('provider maxConcurrency must be 1..8')
    }
    if (!Array.isArray(domain.routes) || domain.routes.length === 0) throw new Error('provider domain needs routes')
    for (const route of domain.routes) {
      if (!route || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(route.routeId) || route.admissionDomainId !== domain.admissionDomainId) {
        throw new Error('provider route must point to its admission domain')
      }
      if (routeIds.has(route.routeId)) throw new Error('duplicate provider routeId')
      routeIds.add(route.routeId)
      if (!['zdr-verified', 'nonconfidential'].includes(route.capability)) throw new Error('invalid provider capability')
      if (typeof route.model !== 'string' || route.model.trim() === '') throw new Error('provider route model is required')
      if (route.capability === 'zdr-verified' && typeof route.evidenceExpiresAt !== 'string') {
        throw new Error('zdr-verified route needs evidence expiry')
      }
    }
  }
  return parsed
}

export function validateRuntimeConfiguration(input = process.env) {
  const origins = csv(input.PUBLIC_APP_ORIGINS)
  if (origins.length === 0 || origins.some((origin) => !ORIGIN_PATTERN.test(origin))) {
    throw new Error('PUBLIC_APP_ORIGINS must contain exact HTTPS or localhost origins')
  }
  const quotaKeyring = keyring(input.QUOTA_HMAC_CURRENT_KEY_ENV, input.QUOTA_HMAC_RETIRING_KEY_ENVS, 'quota HMAC')
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
    quotaKeyring,
    governanceKeyring,
    checkpointKeyIds,
    providerAdmissionDomains: providerDomains(input.PROVIDER_ADMISSION_DOMAINS_JSON),
    internalMachineSecretEnv: machineSecretEnv,
  }
}

export const RUNTIME_ENV_CONTRACT = Object.freeze([
  'PUBLIC_APP_ORIGINS',
  'QUOTA_HMAC_CURRENT_KEY_ENV',
  'QUOTA_HMAC_RETIRING_KEY_ENVS',
  'GOVERNANCE_SIGNING_CURRENT_KEY_ENV',
  'GOVERNANCE_SIGNING_RETIRING_KEY_ENVS',
  'OFFLINE_CHECKPOINT_KEY_IDS',
  'PROVIDER_ADMISSION_DOMAINS_JSON',
  'INTERNAL_MACHINE_SECRET_ENV',
])
