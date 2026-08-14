import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app.js'

const token = 'account-delete-session-token'
const userId = '507f1f77bcf86cd799439010'

describe('account deletion HTTP boundary', () => {
  it('accepts one deletion request, validates the public response, and clears the session cookie', async () => {
    const authService = {
      authenticate: vi.fn(async () => ({ user: { id: userId, role: 'user', status: 'active' }, session: { id: '507f1f77bcf86cd799439011', userSessionVersion: 4, csrfSecretHash: 'hash' } })),
      verifyCsrf: vi.fn(async () => true),
    }
    const accountDeletionService = {
      request: vi.fn(async () => ({
        id: '507f1f77bcf86cd799439012', status: 'queued', priority: 50, attempt: 1,
        availableAt: '2026-08-13T00:00:00.000Z', completion: { sessionsRevoked: true, sessionsDeleted: false, savedArticlesDeleted: false, chatSessionsDeleted: false, answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false },
        error: null, requestedAt: '2026-08-13T00:00:00.000Z', startedAt: null, completedAt: null,
      })),
    }
    const app = createApp({ authService, accountDeletionService, allowedOrigins: 'http://localhost:3000' })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/me/deletion-requests`, {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${token}`, 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'delete-request-key-1' },
      })
      expect(response.status).toBe(202)
      expect(response.headers.get('set-cookie')).toContain('__Host-techpulse_session=;')
      expect((await response.json()).data).toMatchObject({ id: '507f1f77bcf86cd799439012', status: 'queued', completion: { sessionsRevoked: true } })
      expect(accountDeletionService.request).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'delete-request-key-1', auth: expect.any(Object), request: expect.any(Object) }))
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })
})
