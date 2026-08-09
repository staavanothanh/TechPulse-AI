const COOKIE_NAME = '__Host-techpulse_session'
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/

function assertToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new Error('invalid session token')
}

export function serializeSessionCookie(token, maxAgeSeconds) {
  assertToken(token)
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw new Error('invalid session max age')
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`
}

export function serializeClearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`
}

export function parseSessionCookie(header) {
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const [name, ...valueParts] = part.trim().split('=')
    if (name !== COOKIE_NAME) continue
    const value = valueParts.join('=')
    try {
      const decoded = decodeURIComponent(value)
      return TOKEN_PATTERN.test(decoded) ? decoded : null
    } catch {
      return null
    }
  }
  return null
}

export { COOKIE_NAME }
