import { subjectTypeForScope } from './rate-limit-scope.js'

function opaqueSubject(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('Rate-limit subject is invalid')
  return value
}

// Shared Mongo-backed admission for non-auth scopes. It deliberately has no
// HTTP/domain error type so each caller can retain its canonical error shape.
export function createRateLimitAdmission({ repository, keyring, clock = () => new Date() } = {}) {
  if (!repository || !keyring) throw new Error('Rate-limit repository and keyring are required')
  return Object.freeze({
    async reserve({ scope, subject, session } = {}) {
      const subjectType = subjectTypeForScope(scope)
      if (!subjectType) throw new Error('Rate-limit scope is invalid')
      const raw = opaqueSubject(subject)
      const keyHash = keyring.digest(raw)
      const rotationKeyHashes = (keyring.versions ?? [])
        .filter((version) => version !== keyring.currentVersion)
        .map((version) => keyring.digest(raw, version))
      return repository.reserveRateLimit({
        scope, subjectType, keyHash, keyVersion: keyring.currentVersion,
        keyring, rotationKeyHashes, now: clock(),
      }, session ? { session } : {})
    },
  })
}
