import { createHash } from 'node:crypto'

export class JobError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options)
    this.name = 'JobError'
    this.status = status
    this.code = code
    this.retryAfter = options.retryAfter
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function canonicalRequestHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function actorScopeForAdmin(auth) {
  const userId = String(auth?.user?.id ?? '')
  const sessionId = String(auth?.session?._id ?? auth?.session?.id ?? '')
  const version = auth?.session?.userSessionVersion
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !Number.isInteger(version) || version < 0) {
    throw new JobError(401, 'unauthorized', 'Authenticated admin session is required')
  }
  return `admin:${userId}:session:${sessionId}:v${version}`
}

export function resolveIdempotentJob(existing, requestHash) {
  if (!existing) return null
  if (existing.requestHash !== requestHash) throw new JobError(409, 'idempotency_mismatch', 'Idempotency key is already bound to a different request')
  return existing
}
