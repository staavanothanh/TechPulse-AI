import { lookup as dnsLookup } from 'node:dns/promises'
import https from 'node:https'
import { isIP } from 'node:net'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

const DEFAULT_LIMITS = Object.freeze({ wireBytes: 1024 * 1024, decodedBytes: 4 * 1024 * 1024, expansionRatio: 20, redirects: 3, timeoutMs: 8000 })
const REDIRECTS = new Set([301, 302, 303, 307, 308])
function normalizedAllowedHosts(values) {
  if (values === undefined) return null
  if (!Array.isArray(values) || values.length === 0) throw new SafeFetchError('source_content_host_blocked', 'Source content host allowlist is invalid')
  const normalized = values.map((value) => String(value ?? '').trim().replace(/\.$/, '').toLowerCase())
  if (normalized.some((value) => !value || isIP(value) !== 0 || !value.includes('.') || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value))) throw new SafeFetchError('source_content_host_blocked', 'Source content host allowlist is invalid')
  return new Set(normalized)
}

function assertAllowedHost(url, allowedHosts) {
  if (url.port) throw new SafeFetchError('source_content_host_blocked', 'Source content URL must use the default HTTPS port')
  if (allowedHosts && !allowedHosts.has(url.hostname.replace(/\.$/, '').toLowerCase())) throw new SafeFetchError('source_content_host_blocked', 'Source content host is outside the reviewed allowlist')
}

export class SafeFetchError extends Error {
  constructor(code, message, { retryable = false, upstreamStatus } = {}) {
    super(message)
    this.name = 'SafeFetchError'
    this.code = code
    this.retryable = retryable
    if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus
  }
}

function ipv4Number(address) {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null
  return parts.reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0)
}

function ipv4String(value) {
  return [24, 16, 8, 0].map((shift) => Number((value >> BigInt(shift)) & 255n)).join('.')
}

function ipv6Value(raw) {
  let address = raw.toLowerCase().split('%', 1)[0]
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    const v4 = ipv4Number(address.slice(lastColon + 1))
    if (v4 === null) return null
    address = `${address.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  if ((address.match(/::/g) ?? []).length > 1) return null
  const [leftText, rightText] = address.split('::')
  const left = leftText ? leftText.split(':') : []
  const right = rightText ? rightText.split(':') : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || !address.includes('::') && missing !== 0) return null
  const groups = [...left, ...Array(address.includes('::') ? missing : 0).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

function inIpv4Range(value, base, bits) {
  const shift = 32 - bits
  return (value >>> shift) === (base >>> shift)
}

function publicIpv4(address) {
  const value = ipv4Number(address)
  if (value === null) return false
  const blocked = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16],
    [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ]
  return !blocked.some(([base, bits]) => inIpv4Range(value, base, bits))
}

function inIpv6Range(value, base, bits) {
  const shift = 128n - BigInt(bits)
  return value >> shift === base >> shift
}

function normalizeAddress(raw) {
  const value = String(raw ?? '').replace(/^\[|\]$/g, '').toLowerCase()
  if (isIP(value) === 4) return { address: value.split('.').map(Number).join('.'), family: 4 }
  if (isIP(value) !== 6) return null
  const numeric = ipv6Value(value)
  if (numeric === null) return null
  if (numeric >> 32n === 0xffffn) return { address: ipv4String(numeric & 0xffffffffn), family: 4 }
  return { address: value, family: 6, numeric }
}

function publicIpv6(numeric) {
  const globalStart = 0x20000000000000000000000000000000n
  const globalEnd = 0x40000000000000000000000000000000n
  if (numeric < globalStart || numeric >= globalEnd) return false
  const blocked = [
    [0x20010000000000000000000000000000n, 23],
    [0x20010db8000000000000000000000000n, 32],
    [0x20020000000000000000000000000000n, 16],
  ]
  return !blocked.some(([base, bits]) => inIpv6Range(numeric, base, bits))
}

export function assertPublicAddressSet(records) {
  if (!Array.isArray(records) || records.length === 0) throw new SafeFetchError('source_dns_empty', 'Source hostname has no usable address', { retryable: true })
  const normalized = records.map((record) => normalizeAddress(record?.address ?? record))
  if (normalized.some((record) => !record || record.family === 4 ? !record || !publicIpv4(record.address) : !publicIpv6(record.numeric))) {
    throw new SafeFetchError('source_address_blocked', 'Source hostname resolved to a non-public address')
  }
  return [...new Map(normalized.map(({ address, family }) => [`${family}:${address}`, { address, family }])).values()]
}

export function canonicalSourceUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw new SafeFetchError('source_url_rejected', 'Source URL is invalid')
  let url
  try { url = new URL(value) } catch { throw new SafeFetchError('source_url_rejected', 'Source URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password) throw new SafeFetchError('source_url_rejected', 'Source URL must use credential-free HTTPS')
  url.hash = ''
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname) throw new SafeFetchError('source_url_rejected', 'Source URL hostname is invalid')
  url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname
  return url
}

function timeoutError() {
  return new SafeFetchError('source_fetch_timeout', 'Source request timed out', { retryable: true })
}
function ingestionDeadlineError() {
  return new SafeFetchError('ingestion_deadline_exceeded', 'Ingestion execution deadline was exceeded', { retryable: false })
}

function abortReason(signal) {
  return signal?.reason ?? new SafeFetchError('source_fetch_aborted', 'Source request was aborted', { retryable: true })
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

async function beforeDeadline(promise, deadlineAt, signal, timeoutFailure = timeoutError()) {
  assertNotAborted(signal)
  const remainingMs = Math.max(0, Number(deadlineAt) - Date.now())
  if (remainingMs === 0) throw timeoutFailure
  let timer
  let abortHandler
  const racers = [
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutFailure), remainingMs) }),
  ]
  if (signal) {
    racers.push(new Promise((_, reject) => {
      abortHandler = () => reject(abortReason(signal))
      signal.addEventListener('abort', abortHandler, { once: true })
    }))
  }
  try {
    return await Promise.race(racers)
  } finally {
    globalThis.clearTimeout(timer)
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

async function resolvePublicAddresses(url, lookup, deadlineAt, signal, timeoutFailure) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(hostname)) return assertPublicAddressSet([{ address: hostname, family: isIP(hostname) }])
  let records
  try { records = await beforeDeadline(lookup(hostname, { all: true, verbatim: true }), deadlineAt, signal, timeoutFailure) } catch (error) {
    if (error instanceof SafeFetchError || signal?.aborted) throw error
    if (Date.now() >= deadlineAt) throw timeoutFailure
    throw new SafeFetchError('source_dns_failed', 'Source hostname could not be resolved', { retryable: true })
  }
  return assertPublicAddressSet(records)
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

export function pinnedRequest({ url, address, family, hostname, servername, deadlineAt, signal, timeoutFailure = timeoutError() }) {
  return new Promise((resolve, reject) => {
    const remainingMs = Math.max(0, Number(deadlineAt) - Date.now())
    if (remainingMs === 0) {
      reject(timeoutFailure)
      return
    }
    let settled = false
    let timer
    let request
    const abort = () => {
      const reason = abortReason(signal)
      request?.destroy?.()
      finish(reject, reason)
    }
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    request = https.request({
      protocol: 'https:', hostname, servername: isIP(servername) ? undefined : servername,
      port: url.port || 443, method: 'GET', path: `${url.pathname}${url.search}`,
      headers: { Host: url.host, Accept: '*/*', 'Accept-Encoding': 'gzip, deflate, br' },
      agent: false,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      },
    }, (response) => finish(resolve, { statusCode: response.statusCode, headers: response.headers, body: response }))
    timer = setTimeout(() => request.destroy(timeoutFailure), remainingMs)
    request.on('error', (error) => finish(reject, error instanceof SafeFetchError ? error : new SafeFetchError('source_fetch_failed', 'Source request failed', { retryable: true })))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else request.end()
  })
}

function responseBody(response) {
  return response?.body ?? response
}

function destroyResponse(response) {
  const body = responseBody(response)
  body?.destroy?.()
}

async function readWireBody(body, limit, deadlineAt, signal, timeoutFailure = timeoutError()) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new SafeFetchError('source_fetch_failed', 'Source response stream is invalid', { retryable: true })
  const chunks = []
  let bytes = 0
  let timer
  let abortHandler
  let preferredError
  const timeout = new Promise((_, reject) => {
    const remainingMs = Math.max(0, Number(deadlineAt) - Date.now())
    timer = setTimeout(() => {
      preferredError = timeoutFailure
      body.destroy?.(preferredError)
      reject(preferredError)
    }, remainingMs)
  })
  const consume = async () => {
    for await (const chunk of body) {
      assertNotAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > limit) {
        preferredError = new SafeFetchError('source_wire_limit', 'Source response exceeded the wire-byte limit')
        body.destroy?.()
        throw preferredError
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks, bytes)
  }
  const racers = [consume(), timeout]
  if (signal) racers.push(new Promise((_, reject) => {
    abortHandler = () => {
      preferredError = abortReason(signal)
      body.destroy?.()
      reject(preferredError)
    }
    signal.addEventListener('abort', abortHandler, { once: true })
  }))
  try {
    return await Promise.race(racers)
  } catch (error) {
    body.destroy?.()
    if (preferredError) throw preferredError
    if (signal?.aborted) throw abortReason(signal)
    if (Date.now() >= deadlineAt) throw timeoutFailure
    if (error instanceof SafeFetchError) throw error
    throw new SafeFetchError('source_fetch_failed', 'Source response stream failed', { retryable: true })
  } finally {
    globalThis.clearTimeout(timer)
    if (abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}

function decodeBody(wire, encoding, decodedLimit) {
  try {
    if (!encoding || encoding === 'identity') return wire
    if (encoding === 'gzip') return gunzipSync(wire, { maxOutputLength: decodedLimit + 1 })
    if (encoding === 'deflate') return inflateSync(wire, { maxOutputLength: decodedLimit + 1 })
    if (encoding === 'br') return brotliDecompressSync(wire, { maxOutputLength: decodedLimit + 1 })
    throw new SafeFetchError('source_encoding_rejected', 'Source response encoding is unsupported')
  } catch (error) {
    if (error instanceof SafeFetchError) throw error
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(error?.message ?? '')) throw new SafeFetchError('source_decoded_limit', 'Source response exceeded the decoded-byte limit')
    throw new SafeFetchError('source_decode_failed', 'Source response could not be decoded')
  }
}

export function createSafeFetch({ lookup = dnsLookup, request = pinnedRequest, limits: configuredLimits = {} } = {}) {
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...configuredLimits })
  if (!Number.isInteger(limits.wireBytes) || !Number.isInteger(limits.decodedBytes) || limits.wireBytes < 1 || limits.decodedBytes < 1 || !Number.isFinite(limits.expansionRatio) || limits.expansionRatio < 1 || !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1) throw new Error('Safe-fetch limits are invalid')
  return async function safeFetch(input, { allowedContentTypes = [], allowedHosts, signal, deadline } = {}) {
    assertNotAborted(signal)
    let url = canonicalSourceUrl(input)
    const hostAllowlist = normalizedAllowedHosts(allowedHosts)
    const callerDeadline = deadline === undefined ? Number.POSITIVE_INFINITY : new Date(deadline).getTime()
    if (!Number.isFinite(callerDeadline) && callerDeadline !== Number.POSITIVE_INFINITY) throw new SafeFetchError('source_fetch_timeout', 'Source request deadline is invalid')
    const localDeadline = Date.now() + limits.timeoutMs
    const deadlineAt = Math.min(localDeadline, callerDeadline)
    const timeoutFailure = callerDeadline <= localDeadline ? ingestionDeadlineError() : timeoutError()
    if (deadlineAt <= Date.now()) throw timeoutFailure
    const allowed = new Set(allowedContentTypes.map((value) => value.toLowerCase()))
    if (allowed.size === 0) throw new Error('Safe-fetch content-type allowlist is required')
    for (let redirect = 0; redirect <= limits.redirects; redirect += 1) {
      assertNotAborted(signal)
      assertAllowedHost(url, hostAllowlist)
      const addresses = await resolvePublicAddresses(url, lookup, deadlineAt, signal, timeoutFailure)
      const selected = addresses[0]
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      if (Date.now() >= deadlineAt) throw timeoutFailure
      const responsePromise = Promise.resolve().then(() => request({ url, address: selected.address, family: selected.family, hostname, servername: hostname, deadlineAt, signal, timeoutFailure }))
      let response
      try {
        response = await beforeDeadline(responsePromise, deadlineAt, signal, timeoutFailure)
        assertNotAborted(signal)
        if (Date.now() >= deadlineAt) {
          destroyResponse(response)
          throw timeoutFailure
        }
      } catch (error) {
        responsePromise.then((lateResponse) => destroyResponse(lateResponse)).catch(() => {})
        if (response) destroyResponse(response)
        if (Date.now() >= deadlineAt) throw timeoutFailure
        throw error
      }
      const statusCode = Number(response?.statusCode)
      if (REDIRECTS.has(statusCode)) {
        destroyResponse(response)
        const location = headerValue(response.headers, 'location')
        if (!location || redirect >= limits.redirects) throw new SafeFetchError('source_redirect_rejected', 'Source redirect limit was exceeded')
        try { url = canonicalSourceUrl(new URL(location, url).href) } catch (error) { throw error instanceof SafeFetchError ? error : new SafeFetchError('source_redirect_rejected', 'Source redirect URL is invalid') }
        continue
      }
      if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
        destroyResponse(response)
        throw new SafeFetchError('source_upstream_status', 'Source returned an unsuccessful status', { retryable: statusCode === 429 || statusCode >= 500, upstreamStatus: statusCode })
      }
      const contentType = String(headerValue(response.headers, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (!allowed.has(contentType)) {
        destroyResponse(response)
        throw new SafeFetchError('source_content_type_rejected', 'Source response content type is not allowed')
      }
      const declaredLength = Number(headerValue(response.headers, 'content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > limits.wireBytes) {
        destroyResponse(response)
        throw new SafeFetchError('source_wire_limit', 'Source response exceeded the wire-byte limit')
      }
      const wire = await readWireBody(responseBody(response), limits.wireBytes, deadlineAt, signal, timeoutFailure)
      assertNotAborted(signal)
      if (Date.now() >= deadlineAt) throw timeoutFailure
      const decoded = decodeBody(wire, String(headerValue(response.headers, 'content-encoding') ?? '').trim().toLowerCase(), limits.decodedBytes)
      if (decoded.length > limits.decodedBytes) throw new SafeFetchError('source_decoded_limit', 'Source response exceeded the decoded-byte limit')
      const ratio = wire.length === 0 ? 0 : decoded.length / wire.length
      if (ratio > limits.expansionRatio) throw new SafeFetchError('source_expansion_limit', 'Source response exceeded the expansion-ratio limit')
      if (Date.now() >= deadlineAt) throw timeoutFailure
      return { url: url.href, statusCode, contentType, resolvedHost: hostname, address: selected.address, body: decoded }
    }
    throw new SafeFetchError('source_redirect_rejected', 'Source redirect limit was exceeded')
  }
}

export const SAFE_FETCH_LIMITS = DEFAULT_LIMITS
