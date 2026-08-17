const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SESSION_COOKIE_NAME = '__Host-techpulse_session'

function normalizeBaseUrl(value) {
  const baseUrl = new URL(value || 'http://localhost:3000')
  if (!['http:', 'https:'].includes(baseUrl.protocol))
    throw new Error('E2E_BASE_URL must use http or https')
  return baseUrl.toString().replace(/\/$/, '')
}

function cookieFromSetCookie(value) {
  if (typeof value !== 'string') return null
  const pair = value.split(';', 1)[0]
  if (!pair.startsWith(`${SESSION_COOKIE_NAME}=`)) return null
  return pair.endsWith('=') ? null : pair
}

function jsonHeaders(headers, body) {
  const result = new globalThis.Headers(headers)
  result.set('Accept', 'application/json')
  if (body !== undefined && !result.has('Content-Type'))
    result.set('Content-Type', 'application/json')
  return result
}

export class LocalHostClient {
  constructor({
    baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000',
    origin = process.env.E2E_ORIGIN,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.origin = origin || new URL(this.baseUrl).origin
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.cookie = null
  }

  async request(path, { method = 'GET', headers, body, csrfToken } = {}) {
    const upperMethod = method.toUpperCase()
    const requestHeaders = jsonHeaders(headers, body)
    if (this.cookie) requestHeaders.set('Cookie', this.cookie)
    if (MUTATING_METHODS.has(upperMethod)) requestHeaders.set('Origin', this.origin)
    if (csrfToken) requestHeaders.set('X-CSRF-Token', csrfToken)
    const requestBody = body === undefined || typeof body === 'string' ? body : JSON.stringify(body)
    const controller = new globalThis.AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response
    try {
      response = await this.fetchImpl(new URL(path, `${this.baseUrl}/`), {
        method: upperMethod,
        headers: requestHeaders,
        body: requestBody,
        signal: controller.signal,
      })
    } catch (error) {
      const suffix = error?.name === 'AbortError' ? ` after ${this.timeoutMs}ms` : ''
      throw new Error(`Local-host E2E request failed: ${upperMethod} ${path}${suffix}`, {
        cause: error,
      })
    } finally {
      globalThis.clearTimeout(timeout)
    }
    const newCookie = cookieFromSetCookie(response.headers.get('set-cookie'))
    if (response.headers.has('set-cookie')) this.cookie = newCookie
    const contentType = response.headers.get('content-type') || ''
    const payload =
      response.status === 204
        ? null
        : contentType.includes('json')
          ? await response.json()
          : await response.text()
    return { response, payload }
  }

  login(credentials) {
    return this.request('/api/v1/auth/login', { method: 'POST', body: credentials })
  }

  currentUser() {
    return this.request('/api/v1/me')
  }

  logout(csrfToken) {
    return this.request('/api/v1/auth/logout', { method: 'POST', csrfToken })
  }
}

export function localHostCredentials(prefix) {
  const email = process.env[`E2E_${prefix}_EMAIL`]
  const password = process.env[`E2E_${prefix}_PASSWORD`]
  if (!email || !password)
    throw new Error(
      `Set E2E_${prefix}_EMAIL and E2E_${prefix}_PASSWORD before enabling local-host E2E tests`,
    )
  return { email, password }
}

export function assertSafeResponse(value, path = '$') {
  const forbidden = new Set([
    'passwordHash',
    'sessionToken',
    'providerPayload',
    'rawHtml',
    'fullText',
    'sourceMediaBinary',
  ])
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeResponse(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key))
      throw new Error(`Sensitive field ${key} leaked in local-host E2E response at ${path}`)
    assertSafeResponse(child, `${path}.${key}`)
  }
}

export function assertListEnvelope(payload, label) {
  if (
    !payload ||
    !Array.isArray(payload.data) ||
    !payload.meta ||
    typeof payload.meta.hasNext !== 'boolean'
  ) {
    throw new Error(`${label} did not return the canonical list envelope`)
  }
  assertSafeResponse(payload)
}
