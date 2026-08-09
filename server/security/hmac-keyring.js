import { createHash, createHmac } from 'node:crypto'

export const HMAC_RETIREMENT_MIN_MS = 30 * 24 * 60 * 60 * 1000

export function validateRetiringKey({ retiringSince, dependentCount, now = new Date() } = {}) {
  if (!(retiringSince instanceof Date) || !Number.isFinite(retiringSince.getTime())) throw new Error('retiring key activation date is required')
  if (!Number.isInteger(dependentCount) || dependentCount < 0) throw new Error('retiring key dependent count is invalid')
  const ageMs = now.getTime() - retiringSince.getTime()
  return { eligible: ageMs >= HMAC_RETIREMENT_MIN_MS && dependentCount === 0, ageMs, dependentCount }
}

export function createHmacKeyring({ currentEnv, retiringEnvs = [], currentVersion = 1, retiringVersions, values = process.env } = {}) {
  const names = [currentEnv, ...retiringEnvs].filter(Boolean)
  if (currentVersion > 1 && retiringEnvs.length > 0 && retiringVersions === undefined) throw new Error('retiring HMAC versions are required after rotation')
  const stableVersions = retiringVersions ?? retiringEnvs.map((_name, index) => currentVersion + index + 1)
  if (!currentEnv || new Set(names).size !== names.length || retiringEnvs.length > 2 || !Number.isSafeInteger(currentVersion) || currentVersion < 1 || stableVersions.length !== retiringEnvs.length || new Set([currentVersion, ...stableVersions]).size !== 1 + stableVersions.length) throw new Error('invalid HMAC keyring')
  const keys = new Map()
  names.forEach((name, index) => {
    const value = values[name]
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) throw new Error(`HMAC key ${name} is not configured`)
    const secret = Buffer.from(value, 'utf8')
    if ([...keys.values()].some((key) => key.secret.equals(secret))) throw new Error('duplicate HMAC key material')
    keys.set(index === 0 ? currentVersion : stableVersions[index - 1], Object.freeze({
      secret,
      fingerprint: createHash('sha256').update(secret).digest('hex'),
    }))
  })
  return Object.freeze({
    currentVersion,
    versions: Object.freeze([...keys.keys()]),
    acceptsVersion(version) { return keys.has(version) },
    fingerprint(version = currentVersion) {
      const key = keys.get(version)
      if (!key) throw new Error('unknown or retired HMAC key version')
      return key.fingerprint
    },
    matchesFingerprint(version, value) {
      return keys.has(version) && value === keys.get(version).fingerprint
    },
    digest(value, version = currentVersion) {
      if (!keys.has(version)) throw new Error('unknown or retired HMAC key version')
      return createHmac('sha256', keys.get(version).secret).update(String(value), 'utf8').digest('hex')
    },
  })
}
