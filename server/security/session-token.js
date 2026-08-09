import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('invalid session token')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function createCsrfToken() {
  return randomBytes(32).toString('base64url')
}

// The browser receives this token only in an authenticated response. Deriving it
// from the opaque HttpOnly session secret keeps concurrent `/me` bootstraps and
// React StrictMode from revoking another tab's still-valid CSRF token.
export function csrfTokenForSession(sessionToken) {
  if (typeof sessionToken !== 'string' || sessionToken.length < 16) throw new Error('invalid session token')
  return createHash('sha256').update(`csrf:${sessionToken}`, 'utf8').digest('base64url')
}

export function hashCsrfToken(token) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('invalid csrf token')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function verifyCsrfToken(token, digest) {
  if (typeof token !== 'string' || typeof digest !== 'string') return false
  try {
    const received = Buffer.from(hashCsrfToken(token), 'hex')
    const expected = Buffer.from(digest, 'hex')
    return received.length === expected.length && timingSafeEqual(received, expected)
  } catch {
    return false
  }
}
