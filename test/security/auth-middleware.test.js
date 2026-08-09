import { describe, expect, it, vi } from 'vitest'
import { AuthError } from '../../server/application/auth/service.js'
import { requireCsrf } from '../../server/http/middleware/csrf.js'
import { requireRole } from '../../server/http/middleware/require-role.js'
import { createSessionMiddleware } from '../../server/http/middleware/session.js'

function responseDouble() {
  return {
    statusCode: undefined,
    payload: undefined,
    getHeader: () => 'request-1',
    status(code) { this.statusCode = code; return this },
    json(payload) { this.payload = payload; return this },
  }
}

describe('reusable auth middleware', () => {
  it('only turns a genuine invalid session into anonymous state and propagates 503', async () => {
    const unavailable = createSessionMiddleware({ authService: { authenticate: vi.fn(async () => { throw new AuthError(503, 'service_unavailable', 'Mongo unavailable') }) } })
    const unavailableNext = vi.fn()
    const unavailableRequest = { get: vi.fn(() => '__Host-techpulse_session=opaque-session-token-1234') }

    await unavailable(unavailableRequest, responseDouble(), unavailableNext)
    expect(unavailableNext).toHaveBeenCalledWith(expect.objectContaining({ status: 503, code: 'service_unavailable' }))

    const expired = createSessionMiddleware({ authService: { authenticate: vi.fn(async () => { throw new AuthError(401, 'unauthorized', 'Expired') }) } })
    const expiredNext = vi.fn()
    const expiredRequest = { get: vi.fn(() => '__Host-techpulse_session=opaque-session-token-1234') }
    await expired(expiredRequest, responseDouble(), expiredNext)
    expect(expiredRequest.auth).toBeNull()
    expect(expiredNext).toHaveBeenCalledWith()
  })

  it('returns 401 without auth, 403 for a wrong role, and preserves CSRF infrastructure failures', async () => {
    const noAuthResponse = responseDouble()
    requireRole('admin')({}, noAuthResponse, vi.fn())
    expect(noAuthResponse.statusCode).toBe(401)
    expect(noAuthResponse.payload.error.code).toBe('unauthorized')

    const wrongRoleResponse = responseDouble()
    requireRole('admin')({ auth: { user: { role: 'user' } } }, wrongRoleResponse, vi.fn())
    expect(wrongRoleResponse.statusCode).toBe(403)

    const noCsrfAuthResponse = responseDouble()
    await requireCsrf({ verifyCsrf: vi.fn() })({}, noCsrfAuthResponse, vi.fn())
    expect(noCsrfAuthResponse.statusCode).toBe(401)

    const csrfNext = vi.fn()
    await requireCsrf({ verifyCsrf: vi.fn(async () => { throw new AuthError(503, 'service_unavailable', 'Mongo unavailable') }) })({
      auth: { user: { id: 'user-1' } }, get: vi.fn(() => 'csrf-token'),
    }, responseDouble(), csrfNext)
    expect(csrfNext).toHaveBeenCalledWith(expect.objectContaining({ status: 503, code: 'service_unavailable' }))
  })
})
