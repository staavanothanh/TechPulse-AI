import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { deletionCompletion, canCompleteDeletion, safeAccountDeletion, createAccountDeletionService } from '../../../server/application/account-deletion/service.js'

describe('Step 11 account deletion workflow', () => {
  it('starts with only session revocation complete and preserves flags on retry', () => {
    expect(deletionCompletion({ sessionsRevoked: true })).toEqual({
      sessionsRevoked: true, sessionsDeleted: false, savedArticlesDeleted: false, chatSessionsDeleted: false,
      answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false,
    })
    expect(safeAccountDeletion({ completion: { sessionsDeleted: true }, status: 'failed', error: { code: 'x', message: 'x', retryable: true, occurredAt: new Date() } }).completion.sessionsDeleted).toBe(true)
  })

  it('does not expose arbitrary persisted cleanup diagnostics', () => {
    const result = safeAccountDeletion({ _id: '507f1f77bcf86cd799439010', status: 'failed', priority: 50, attempt: 1, availableAt: new Date(), completion: {}, error: { code: 'cleanup_incomplete', message: 'https://private.example/?token=secret', retryable: true, occurredAt: new Date() }, requestedAt: new Date(), startedAt: null, completedAt: null })
    expect(result.error).toMatchObject({ code: 'cleanup_incomplete', message: 'Account deletion cleanup did not complete' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('private.example')
  })

  it('cannot become completed until all seven flags are true and error is null', () => {
    const incomplete = deletionCompletion({ sessionsRevoked: true, sessionsDeleted: true })
    expect(canCompleteDeletion({ completion: incomplete, error: null })).toBe(false)
    expect(canCompleteDeletion({ completion: Object.fromEntries(Object.keys(incomplete).map((key) => [key, true])), error: { code: 'x' } })).toBe(false)
    expect(canCompleteDeletion({ completion: Object.fromEntries(Object.keys(incomplete).map((key) => [key, true])), error: null })).toBe(true)
  })

  it('fences creation to active user/session and rejects idempotency hash mismatch', async () => {
    const repository = {
      withTransaction: async (work) => work('tx'),
      findByUserId: async () => ({ _id: 'workflow', idempotencyKey: 'same-key', requestHash: 'old-hash' }),
    }
    const service = createAccountDeletionService({ repository })
    await expect(service.request({ auth: { user: { _id: 'user', status: 'active' }, session: { _id: 'session', userSessionVersion: 4 } }, idempotencyKey: 'same-key', request: { requestHash: 'new-hash' } })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('derives a stable request hash when the HTTP layer does not provide one', async () => {
    const repository = {
      withTransaction: async (work) => work('tx'),
      assertActiveSessionForUser: async () => true,
      findByUserId: async () => null,
      markUserDeletionPending: async () => true,
      create: vi.fn(async (input) => ({ _id: 'workflow', status: 'queued', priority: 50, attempt: 1, availableAt: new Date(), completion: input.completion, error: null, requestedAt: new Date(), startedAt: null, completedAt: null })),
      insertAudit: vi.fn(async () => ({})),
    }
    const service = createAccountDeletionService({ repository })
    const auth = { user: { _id: '507f1f77bcf86cd799439010', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 4 } }

    await service.request({ auth, idempotencyKey: 'delete-request-key-1', request: { requestId: 'request-1' } })

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ requestHash: createHash('sha256').update(['account-deletion', 'delete-request-key-1', '507f1f77bcf86cd799439010'].join('\0')).digest('hex') }), expect.anything())
  })

  it('requires a live admin fence and reserves admin retry admission', async () => {
    const repository = {
      assertActiveSessionForUser: async () => false,
      findById: async () => ({ _id: 'workflow', status: 'failed' }),
    }
    const rateLimitAdmission = { reserve: vi.fn() }
    const service = createAccountDeletionService({ repository, rateLimitAdmission })
    await expect(service.retry({ auth: { user: { _id: 'admin', id: 'admin', role: 'admin', status: 'active' }, session: { _id: 'session', userSessionVersion: 1 } }, deletionRequestId: '507f1f77bcf86cd799439011', reasonCode: 'account_deletion_retry_requested', idempotencyKey: 'retry-key' })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(rateLimitAdmission.reserve).not.toHaveBeenCalled()
  })

  it('requires the exact authenticated session fence before creating a workflow', async () => {
    const repository = {
      withTransaction: async (work) => work('tx'),
      assertActiveSessionForUser: vi.fn(async () => false),
      findByUserId: vi.fn(),
      create: vi.fn(),
      insertAudit: vi.fn(),
    }
    const service = createAccountDeletionService({ repository })

    await expect(service.request({ auth: { user: { _id: '507f1f77bcf86cd799439010', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 7 } }, idempotencyKey: 'delete-fenced-key', request: { requestId: 'request-fenced' } })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect(repository.assertActiveSessionForUser).toHaveBeenCalledWith({ sessionId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439010', sessionVersion: 7 }, { session: 'tx' })
    expect(repository.findByUserId).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('fails closed before mutation when the durable audit writer is unavailable', async () => {
    const repository = {
      withTransaction: async (work) => work('tx'),
      assertActiveSessionForUser: vi.fn(async () => true),
      findByUserId: vi.fn(async () => null),
      markUserDeletionPending: vi.fn(async () => true),
      create: vi.fn(),
    }
    const service = createAccountDeletionService({ repository })
    const auth = { user: { _id: '507f1f77bcf86cd799439010', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 4 } }

    await expect(service.request({ auth, idempotencyKey: 'delete-audit-required', request: { requestId: 'request-audit-required' } })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(repository.markUserDeletionPending).not.toHaveBeenCalled()
    expect(repository.create).not.toHaveBeenCalled()
  })

  it('rejects a denied admin retry admission without touching the workflow', async () => {
    const repository = {
      assertActiveSessionForUser: vi.fn(async () => true),
      withTransaction: vi.fn(async (work) => work('retry-tx')),
      retry: vi.fn(),
    }
    const service = createAccountDeletionService({ repository, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 41 })) } })

    await expect(service.retry({ auth: { user: { _id: '507f1f77bcf86cd799439010', id: '507f1f77bcf86cd799439010', role: 'admin', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 1 } }, deletionRequestId: '507f1f77bcf86cd799439012', reasonCode: 'account_deletion_retry_requested', idempotencyKey: 'retry-key-denied' })).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryAfter: 41 })
    expect(repository.withTransaction).toHaveBeenCalledTimes(1)
    expect(repository.retry).not.toHaveBeenCalled()
  })

  it('fails closed when admin retry admission is not configured', async () => {
    const repository = { withTransaction: vi.fn(async (work) => work('retry-tx')), assertActiveSessionForUser: vi.fn(async () => true), retry: vi.fn() }
    const service = createAccountDeletionService({ repository })
    const auth = { user: { _id: '507f1f77bcf86cd799439010', role: 'admin', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 1 } }
    await expect(service.retry({ auth, deletionRequestId: '507f1f77bcf86cd799439012', reasonCode: 'account_deletion_retry_requested', idempotencyKey: 'retry-no-admission' })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(repository.retry).not.toHaveBeenCalled()
  })

  it('rechecks exact admin session and reserves admission inside the retry transaction', async () => {
    const repository = {
      withTransaction: vi.fn(async (work) => work('retry-tx')),
      assertActiveSessionForUser: vi.fn(async (_fence, options) => options.session === 'retry-tx'),
      retry: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439012', status: 'queued', priority: 50, attempt: 2, availableAt: new Date(), completion: deletionCompletion(), error: null, requestedAt: new Date(), startedAt: null, completedAt: null })),
    }
    const rateLimitAdmission = { reserve: vi.fn(async ({ session }) => ({ allowed: session === 'retry-tx' })) }
    const service = createAccountDeletionService({ repository, rateLimitAdmission })

    await service.retry({ auth: { user: { _id: '507f1f77bcf86cd799439010', id: '507f1f77bcf86cd799439010', role: 'admin', status: 'active' }, session: { _id: '507f1f77bcf86cd799439011', userSessionVersion: 6 } }, deletionRequestId: '507f1f77bcf86cd799439012', reasonCode: 'account_deletion_retry_requested', idempotencyKey: 'retry-fenced-key' })

    expect(repository.assertActiveSessionForUser).toHaveBeenCalledWith({ sessionId: '507f1f77bcf86cd799439011', userId: '507f1f77bcf86cd799439010', sessionVersion: 6, role: 'admin' }, { session: 'retry-tx' })
    expect(rateLimitAdmission.reserve).toHaveBeenCalledWith(expect.objectContaining({ session: 'retry-tx' }))
    expect(repository.retry).toHaveBeenCalledWith(expect.objectContaining({ session: 'retry-tx' }))
  })
})
