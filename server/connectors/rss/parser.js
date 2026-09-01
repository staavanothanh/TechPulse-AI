import { TextDecoder } from 'node:util'
import { Worker } from 'node:worker_threads'
import { RSS_CONTENT_TYPES, RSS_LIMITS, RssConnectorError, sourcePayloadRejected } from './errors.js'
import { MAX_PARSE_WORK_DELAY_MS } from './parse-limits.js'
import { SAFE_ENTITY_NAMES } from './entities.js'

const UNKNOWN_ENTITY_RE = /&([A-Za-z_][A-Za-z0-9_.:-]*|#(?:x[0-9a-f]+|[0-9]+));/gi
const DOCTYPE_RE = /<\s*!DOCTYPE\b/i
const ENTITY_DECLARATION_RE = /<\s*!ENTITY\b/i
const XINCLUDE_NAMESPACE_RE = /http:\/\/www\.w3\.org\/2001\/XInclude/i
const XINCLUDE_TAG_RE = /<\s*(?:[A-Za-z_][A-Za-z0-9_.-]*:)?include\b/i

function boundedLimits(overrides = {}) {
  const result = {}
  for (const key of Object.keys(RSS_LIMITS)) {
    const value = overrides[key] ?? RSS_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > RSS_LIMITS[key]) throw sourcePayloadRejected()
    result[key] = value
  }
  return Object.freeze(result)
}

function normalizedContentType(value) {
  if (value === undefined || value === null || value === '') return undefined
  const contentType = String(value).split(';', 1)[0].trim().toLowerCase()
  if (!RSS_CONTENT_TYPES.includes(contentType)) throw sourcePayloadRejected()
  return contentType
}

function payloadBody(payload) {
  const value = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)
    ? payload.body ?? payload.payload ?? payload.data
    : payload
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw sourcePayloadRejected()
}

function payloadMeta(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return {}
  const contentEncoding = payload.contentEncoding ?? payload['content-encoding']
  if (contentEncoding && String(contentEncoding).toLowerCase() !== 'identity') throw sourcePayloadRejected()
  return {
    contentType: normalizedContentType(payload.contentType ?? payload['content-type']),
    url: typeof payload.url === 'string' ? payload.url : undefined,
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw sourcePayloadRejected()
  }
}

function rejectHostileConstructs(xml) {
  if (DOCTYPE_RE.test(xml) || ENTITY_DECLARATION_RE.test(xml) || XINCLUDE_NAMESPACE_RE.test(xml) || XINCLUDE_TAG_RE.test(xml)) throw sourcePayloadRejected()
  for (const match of xml.matchAll(UNKNOWN_ENTITY_RE)) {
    const name = match[1].toLowerCase()
    if (name.startsWith('#') || SAFE_ENTITY_NAMES.has(name)) continue
    throw sourcePayloadRejected()
  }
}

function boundedWorkerDelay(value) {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0 || value > MAX_PARSE_WORK_DELAY_MS) throw sourcePayloadRejected()
  return value
}

function parseInWorker(xml, limits, workerDelayMs, signal, deadline) {
  const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : new Date(deadline).getTime()
  if (!Number.isFinite(deadlineAt) && deadlineAt !== Number.POSITIVE_INFINITY) return Promise.reject(sourcePayloadRejected())
  const outerRemainingMs = deadlineAt === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadlineAt - Date.now()
  const outerDeadlineLimited = deadlineAt !== Number.POSITIVE_INFINITY && outerRemainingMs <= limits.parseDeadlineMs
  const remainingMs = Math.min(limits.parseDeadlineMs, Math.max(0, outerRemainingMs))
  const deadlineError = Object.assign(new Error('Ingestion execution deadline was exceeded'), { code: 'ingestion_deadline_exceeded', retryable: false })
  if (signal?.aborted) return Promise.reject(signal.reason ?? deadlineError)
  if (remainingMs === 0) return Promise.reject(outerDeadlineLimited ? deadlineError : sourcePayloadRejected())
  let worker
  try {
    worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' })
  } catch {
    return Promise.reject(sourcePayloadRejected())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let abortHandler
    const finish = (handler) => (value) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      if (abortHandler) signal?.removeEventListener('abort', abortHandler)
      void worker.terminate().catch(() => {})
      handler(value)
    }
    const rejectWorker = finish(reject)
    const timer = setTimeout(() => rejectWorker(signal?.aborted ? signal.reason : outerDeadlineLimited ? deadlineError : sourcePayloadRejected()), remainingMs)
    abortHandler = () => rejectWorker(signal.reason ?? deadlineError)
    signal?.addEventListener('abort', abortHandler, { once: true })
    worker.once('message', (message) => {
      if (!message?.ok || !Array.isArray(message.nodes)) {
        rejectWorker(sourcePayloadRejected())
        return
      }
      if (Date.now() >= deadlineAt) {
        rejectWorker(outerDeadlineLimited ? deadlineError : sourcePayloadRejected())
        return
      }
      finish(resolve)(message.nodes)
    })
    worker.once('error', rejectWorker)
    worker.once('exit', rejectWorker)
    try {
      worker.postMessage({ xml, limits, delayMs: workerDelayMs })
    } catch {
      rejectWorker(sourcePayloadRejected())
    }
  })
}

export function parseRssAtom(payload, { parser: providedParser, limits: configuredLimits, workerDelayMs, signal, deadline } = {}) {
  const limits = boundedLimits(configuredLimits)
  // Function-valued parser injection cannot cross the isolation boundary safely.
  if (providedParser !== undefined) throw sourcePayloadRejected()
  const delayMs = boundedWorkerDelay(workerDelayMs)
  const meta = payloadMeta(payload)
  const bytes = payloadBody(payload)
  if (bytes.length === 0 || bytes.length > limits.maxPayloadBytes) throw sourcePayloadRejected()
  const xml = decodeUtf8(bytes)
  rejectHostileConstructs(xml)
  return parseInWorker(xml, limits, delayMs, signal, deadline).then((nodes) => {
    const root = nodes.find((node) => node.localName === 'rss' || node.localName === 'feed')
    if (!root) throw new RssConnectorError('source_payload_rejected')
    return { nodes, root, contentType: meta.contentType, url: meta.url, retrievedXmlBytes: bytes.length, limits }
  })
}

export const parseFeed = parseRssAtom
