import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'

const FLAGS = Object.freeze(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'])
const DAY_MS = 24 * 60 * 60 * 1000

export class AccountDeletionError extends Error {
  constructor(status, code, message, options = {}) { super(message); this.name = 'AccountDeletionError'; this.status = status; this.code = code; this.retryAfter = options.retryAfter }
}

export function deletionCompletion(value = {}) { return Object.fromEntries(FLAGS.map((flag) => [flag, value[flag] === true])) }
export function canCompleteDeletion({ completion, error } = {}) { return FLAGS.every((flag) => completion?.[flag] === true) && error == null }

function id(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new AccountDeletionError(400, 'bad_request', 'Deletion identifier is invalid')
}

function iso(value, nullable = false) {
  if (value == null && nullable) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function safeAccountDeletion(document) {
  if (!document) return null
  const safeError = document.error ? {
    code: document.error.code === 'cleanup_incomplete' ? 'cleanup_incomplete' : 'operation_failed',
    message: document.error.code === 'cleanup_incomplete' ? 'Account deletion cleanup did not complete' : 'Account deletion operation did not complete',
    retryable: Boolean(document.error.retryable),
    occurredAt: iso(document.error.occurredAt),
  } : null
  return {
    id: String(document._id ?? document.id), status: document.status, priority: document.priority, attempt: document.attempt,
    availableAt: iso(document.availableAt), completion: deletionCompletion(document.completion), error: safeError,
    requestedAt: iso(document.requestedAt), startedAt: iso(document.startedAt, true), completedAt: iso(document.completedAt, true),
  }
}

function requireAdmin(auth) { if (!auth?.user) throw new AccountDeletionError(401, 'unauthorized', 'Authentication is required'); if (auth.user.role !== 'admin' || auth.user.status !== 'active') throw new AccountDeletionError(403, 'forbidden', 'Administrator role is required'); return auth.user }
function requireUser(auth) { if (!auth?.user || auth.user.status !== 'active') throw new AccountDeletionError(401, 'unauthorized', 'Authentication is required'); return auth.user }
function key(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new AccountDeletionError(400, 'bad_request', 'Idempotency-Key is invalid'); return value }
function canonicalRequestHash(idempotencyKey, userId) {
  return createHash('sha256').update(['account-deletion', idempotencyKey, String(userId)].join('\0')).digest('hex')
}
function requestHashFor({ request, idempotencyKey, userId } = {}) {
  return /^[a-f0-9]{64}$/.test(request?.requestHash ?? '') ? request.requestHash : canonicalRequestHash(idempotencyKey, userId)
}
function retryRequestHash({ request, idempotencyKey, deletionRequestId } = {}) {
  return /^[a-f0-9]{64}$/.test(request?.requestHash ?? '') ? request.requestHash : createHash('sha256').update(['account-deletion-retry', idempotencyKey, String(deletionRequestId)].join('\0')).digest('hex')
}
function assertAdmission(admission) {
  if (admission?.allowed === false) throw new AccountDeletionError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: admission.retryAfterSeconds })
  return admission
}

export function createAccountDeletionService({ repository, rateLimitAdmission, clock = () => new Date() } = {}) {
  if (!repository) throw new Error('Account deletion repository is required')
  const withTransaction = (work) => typeof repository.withTransaction === 'function' ? repository.withTransaction(work) : work(undefined)
  return Object.freeze({
    async request({ auth, idempotencyKey, request } = {}) {
      const user = requireUser(auth); const idempotency = key(idempotencyKey); const now = clock()
      const result = await withTransaction(async (session) => {
        if (repository.assertActiveSessionForUser && !await repository.assertActiveSessionForUser({ sessionId: auth.session?._id, userId: user._id, sessionVersion: auth.session?.userSessionVersion }, { session })) throw new AccountDeletionError(401, 'unauthorized', 'Session is no longer active')
        const computedHash = requestHashFor({ request, idempotencyKey: idempotency, userId: user._id })
        const existing = await repository.findByUserId(user._id, { session })
        if (existing) {
          if (existing.requestHash !== computedHash || existing.idempotencyKey !== idempotency) throw new AccountDeletionError(409, 'conflict', 'Idempotency key was reused for a different request')
          return existing
        }
        if (typeof repository.insertAudit !== 'function') throw new AccountDeletionError(503, 'service_unavailable', 'Account deletion audit is unavailable')
        const changed = await repository.markUserDeletionPending(user._id, { session, now, expectedSessionVersion: auth.session?.userSessionVersion })
        if (!changed) throw new AccountDeletionError(409, 'conflict', 'Account deletion state changed')
        const created = await repository.create({ userId: user._id, actorScope: `user:${user._id}`, idempotencyKey: idempotency, requestHash: computedHash, now, completion: deletionCompletion({ sessionsRevoked: true }) }, { session })
        await repository.revokeSessions?.(user._id, { session })
        await repository.insertAudit({ action: 'account_deletion_requested', targetId: created._id, actor: user, request: { ...(request ?? {}), requestId: request?.requestId ?? `account-deletion:${idempotency}` }, session, now, result: 'succeeded' })
        return created
      })
      return safeAccountDeletion(result)
    },
    async list({ auth, query } = {}) { requireAdmin(auth); return repository.list(query).then((result) => ({ ...result, data: (result.data ?? []).map(safeAccountDeletion) })) },
    async get({ auth, deletionRequestId } = {}) { requireAdmin(auth); const result = await repository.findById(id(deletionRequestId)); if (!result) throw new AccountDeletionError(404, 'not_found', 'Deletion workflow not found'); return safeAccountDeletion(result) },
    async retry({ auth, deletionRequestId, reasonCode, idempotencyKey, request } = {}) {
      const actor = requireAdmin(auth); if (reasonCode !== 'account_deletion_retry_requested') throw new AccountDeletionError(422, 'validation_error', 'reasonCode is invalid'); const idempotency = key(idempotencyKey)
      const retryHash = retryRequestHash({ request, idempotencyKey: idempotency, deletionRequestId })
      const retryInput = { deletionRequestId: id(deletionRequestId), idempotencyKey: idempotency, actor, request: { ...(request ?? {}), requestHash: retryHash }, requestHash: retryHash, now: clock() }
      const result = await withTransaction(async (session) => {
        if (!repository.assertActiveSessionForUser || !await repository.assertActiveSessionForUser({ sessionId: auth.session?._id, userId: actor._id, sessionVersion: auth.session?.userSessionVersion, role: 'admin' }, { session })) throw new AccountDeletionError(401, 'unauthorized', 'Session is no longer active')
        if (!rateLimitAdmission?.reserve) throw new AccountDeletionError(503, 'service_unavailable', 'Admin admission is unavailable')
        let admission
        try { admission = await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(actor._id ?? actor.id), session }) } catch { throw new AccountDeletionError(503, 'service_unavailable', 'Admin admission is unavailable') }
        assertAdmission(admission)
        return repository.retry({ ...retryInput, session })
      })
      if (!result) throw new AccountDeletionError(404, 'not_found', 'Deletion workflow not found'); return safeAccountDeletion(result)
    },
  })
}

export { FLAGS, DAY_MS }
