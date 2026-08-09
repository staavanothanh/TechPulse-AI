import { describe, expect, it } from 'vitest'
import { createClientIpAdapter } from '../../server/http/middleware/client-ip.js'
import { hashPassword, verifyPassword } from '../../server/security/password.js'
import { createCsrfToken, hashCsrfToken, verifyCsrfToken } from '../../server/security/session-token.js'
import { isScopeSubjectPairValid } from '../../server/security/rate-limit-scope.js'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'

describe('Step 2 security primitives', () => {
  it('hashes passwords with a non-reversible scrypt record', async () => {
    const encoded = await hashPassword('correct horse battery staple')
    expect(encoded).not.toContain('correct horse')
    expect(encoded.split('$')).toHaveLength(5)
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', encoded)).resolves.toBe(false)
  })

  it('creates and verifies CSRF secrets without storing the clear token', () => {
    const token = createCsrfToken()
    const digest = hashCsrfToken(token)
    expect(token).not.toBe(digest)
    expect(verifyCsrfToken(token, digest)).toBe(true)
    expect(verifyCsrfToken('wrong-token', digest)).toBe(false)
  })

  it('uses only one canonical platform IP and rejects forwarded chains', () => {
    const production = createClientIpAdapter({ mode: 'production' })
    expect(production.getClientIp({ headers: { 'x-forwarded-for': '203.0.113.10' } })).toBe('203.0.113.10')
    expect(production.getClientIp({ headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.4' } })).toBeNull()
    expect(production.getClientIp({ headers: { 'x-forwarded-for': 'ff02::1' } })).toBeNull()
    expect(production.getClientIp({ headers: { 'x-forwarded-for': '2001:0db8:0:0:0:0:0:1' } })).toBe('2001:db8::1')

    const local = createClientIpAdapter({ mode: 'local' })
    expect(local.getClientIp({ socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1')
    expect(() => createClientIpAdapter({ mode: 'production', allowCallerHeader: true })).toThrow(/caller forwarding/)
  })

  it('keeps rate-limit scope and subject ownership closed', () => {
    expect(isScopeSubjectPairValid('login', 'ip')).toBe(true)
    expect(isScopeSubjectPairValid('register', 'ip')).toBe(true)
    expect(isScopeSubjectPairValid('answer-minute', 'user')).toBe(true)
    expect(isScopeSubjectPairValid('login', 'user')).toBe(false)
    expect(isScopeSubjectPairValid('admin-trigger', 'source')).toBe(false)
  })

  it('binds each HMAC version to an immutable material fingerprint', () => {
    const keyring = createHmacKeyring({ currentEnv: 'CURRENT', retiringEnvs: ['OLD'], currentVersion: 10, retiringVersions: [8], values: { CURRENT: 'c'.repeat(32), OLD: 'o'.repeat(32) } })
    expect(keyring.matchesFingerprint(10, keyring.fingerprint(10))).toBe(true)
    expect(keyring.matchesFingerprint(10, keyring.fingerprint(8))).toBe(false)
    expect(keyring.fingerprint(10)).toHaveLength(64)
  })
})
