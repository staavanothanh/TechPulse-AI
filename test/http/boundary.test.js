import { describe, expect, it } from 'vitest'
import { INGRESS_LIMITS, isExactOriginAllowed, validateRequestTarget } from '../../server/http/ingress.js'
import { serializeClearSessionCookie, serializeSessionCookie } from '../../server/http/cookies.js'
import { createRequestId } from '../../server/http/request-id.js'

describe('browser and ingress boundary', () => {
  it('normalizes and matches exact configured origins only', () => {
    expect(isExactOriginAllowed('http://LOCALHOST:3000', ['http://localhost:3000'])).toBe(true)
    expect(isExactOriginAllowed('http://localhost.evil.test:3000', ['http://localhost:3000'])).toBe(false)
    expect(isExactOriginAllowed('https://techpulse.example/other', ['https://techpulse.example'])).toBe(false)
  })

  it('serializes the canonical host-only session tuple and clear tuple', () => {
    expect(serializeSessionCookie('opaque-session-token', 3600)).toBe(
      '__Host-techpulse_session=opaque-session-token; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax',
    )
    expect(serializeClearSessionCookie()).toContain(
      '__Host-techpulse_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax',
    )
    expect(() => serializeSessionCookie('short', 3600)).toThrow(/invalid session token/)
    expect(() => serializeSessionCookie('opaque-session-token', 0)).toThrow(/invalid session max age/)
  })

  it('enforces target and request-id bounds', () => {
    expect(INGRESS_LIMITS.maxTargetBytes).toBe(8192)
    expect(INGRESS_LIMITS.maxJsonBytes).toBe(65536)
    expect(validateRequestTarget('/api/v1/health')).toBe(true)
    expect(validateRequestTarget(`/api/v1/health?x=${'a'.repeat(9000)}`)).toBe(false)
    expect(createRequestId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(validateRequestTarget(undefined)).toBe(false)
    expect(isExactOriginAllowed(undefined, ['http://localhost:3000'])).toBe(false)
  })
})
