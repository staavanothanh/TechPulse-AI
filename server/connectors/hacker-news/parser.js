import { TextDecoder } from 'node:util'
import { HACKER_NEWS_LIMITS, sourcePayloadRejected, sourceUpstreamStatus } from './errors.js'

function responseStatus(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array || Array.isArray(payload)) return undefined
  const status = Number(payload.statusCode ?? payload.status)
  return Number.isInteger(status) ? status : undefined
}

function responseBody(payload) {
  if (payload === null || payload === undefined) return payload
  if (typeof payload === 'string') return payload
  if (Buffer.isBuffer(payload)) return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  if (payload instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: true }).decode(payload)
  if (typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'body')) return responseBody(payload.body)
  return payload
}

export function parseJsonPayload(payload, { allowNull = false, maxBytes = HACKER_NEWS_LIMITS.maxStreamBytes } = {}) {
  const status = responseStatus(payload)
  if (status !== undefined && (status < 200 || status >= 300)) throw sourceUpstreamStatus(status)
  let body
  try { body = responseBody(payload) } catch { throw sourcePayloadRejected() }
  if (body === null && allowNull) return null
  if (body === undefined) throw sourcePayloadRejected()
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > maxBytes) throw sourcePayloadRejected()
    try { body = JSON.parse(body) } catch { throw sourcePayloadRejected() }
  }
  if (body && typeof body === 'object') {
    try {
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxBytes) throw sourcePayloadRejected()
    } catch (error) {
      if (error?.code === 'source_payload_rejected') throw error
      throw sourcePayloadRejected()
    }
  }
  return body
}

export function parseIdList(payload, limits = HACKER_NEWS_LIMITS) {
  const maxStreamIds = Math.min(limits.maxStreamIds ?? HACKER_NEWS_LIMITS.maxStreamIds, HACKER_NEWS_LIMITS.maxStreamIds)
  const maxStreamBytes = Math.min(limits.maxStreamBytes ?? HACKER_NEWS_LIMITS.maxStreamBytes, HACKER_NEWS_LIMITS.maxStreamBytes)
  const value = parseJsonPayload(payload, { maxBytes: maxStreamBytes })
  if (!Array.isArray(value) || value.length > maxStreamIds) throw sourcePayloadRejected()
  return value.map((id) => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw sourcePayloadRejected()
    return id
  })
}

export function parseItem(payload, limits = HACKER_NEWS_LIMITS) {
  const maxStreamBytes = Math.min(limits.maxStreamBytes ?? HACKER_NEWS_LIMITS.maxStreamBytes, HACKER_NEWS_LIMITS.maxStreamBytes)
  return parseJsonPayload(payload, { allowNull: true, maxBytes: maxStreamBytes })
}

export { responseStatus, responseBody }
