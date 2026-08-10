import { TextDecoder } from 'node:util'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { ARXIV_CONTENT_TYPES, ARXIV_LIMITS, sourcePayloadRejected, sourceUpstreamStatus } from './errors.js'

const XML_PARSER_OPTIONS = Object.freeze({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  allowBooleanAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
})

const SAFE_ENTITY_NAMES = new Set(['amp', 'apos', 'gt', 'lt', 'quot'])
const UNKNOWN_ENTITY_RE = /&([A-Za-z_][A-Za-z0-9_.:-]*|#(?:x[0-9a-f]+|[0-9]+));/gi
const DOCTYPE_RE = /<\s*!DOCTYPE\b/i
const ENTITY_DECLARATION_RE = /<\s*!ENTITY\b/i
const XINCLUDE_RE = /(?:http:\/\/www\.w3\.org\/2001\/XInclude|<\s*(?:[A-Za-z_][A-Za-z0-9_.-]*:)?include\b)/i
const MAX_QUERY_RESULTS = 1_000_000_000

function boundedLimits(overrides = {}) {
  const result = {}
  for (const key of Object.keys(ARXIV_LIMITS)) {
    const value = overrides[key] ?? ARXIV_LIMITS[key]
    const minimum = key === 'requestIntervalMs' ? 0 : 1
    if (!Number.isInteger(value) || value < minimum || value > ARXIV_LIMITS[key]) throw sourcePayloadRejected()
    result[key] = value
  }
  return Object.freeze(result)
}

function responseStatus(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return undefined
  const status = Number(payload.statusCode ?? payload.status)
  return Number.isInteger(status) ? status : undefined
}

function responseBody(payload) {
  const value = payload && typeof payload === 'object' && !Buffer.isBuffer(payload) && !(payload instanceof Uint8Array)
    ? payload.body ?? payload.payload ?? payload.data
    : payload
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw sourcePayloadRejected()
}

function contentType(payload) {
  if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) return undefined
  const value = payload.contentType ?? payload['content-type']
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value).split(';', 1)[0].trim().toLowerCase()
  if (!ARXIV_CONTENT_TYPES.includes(normalized)) throw sourcePayloadRejected()
  return normalized
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw sourcePayloadRejected() }
}

function rejectHostileXml(xml) {
  if (DOCTYPE_RE.test(xml) || ENTITY_DECLARATION_RE.test(xml) || XINCLUDE_RE.test(xml)) throw sourcePayloadRejected()
  for (const match of xml.matchAll(UNKNOWN_ENTITY_RE)) {
    const name = match[1].toLowerCase()
    if (name.startsWith('#') || SAFE_ENTITY_NAMES.has(name)) continue
    throw sourcePayloadRejected()
  }
}

function textValue(value) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map(textValue).join(' ')
  if (typeof value === 'object') return textValue(value['#text'] ?? '')
  return String(value)
}

function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function hasField(value, key) {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key))
}

function attribute(value, key) {
  if (!value || typeof value !== 'object') return undefined
  const result = value[`@_${key}`]
  return result === undefined || result === null ? undefined : String(result)
}

export function normalizeText(value, limits) {
  const text = textValue(value)
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
      const key = entity.toLowerCase()
      if (SAFE_ENTITY_NAMES.has(key)) return { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' }[key]
      const codePoint = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ''
    })
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (Array.from(text).length > limits.maxFieldChars) throw sourcePayloadRejected()
  return text
}

export function normalizeArxivId(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  let id = raw
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/^arxiv:/i, '')
    .split(/[?#]/, 1)[0]
    .replace(/\.pdf$/i, '')
  const versionMatch = id.match(/v(\d+)$/i)
  const version = versionMatch ? Number(versionMatch[1]) : undefined
  if (version !== undefined && version < 1) return undefined
  if (versionMatch) id = id.slice(0, -versionMatch[0].length)
  if (!/^(?:\d{4}\.\d{4,5}|[A-Za-z-]+\/\d{7})$/.test(id)) return undefined
  return { id, ...(version !== undefined ? { version } : {}) }
}

export function canonicalArxivUrl(identifier) {
  if (!identifier?.id) return undefined
  return `https://arxiv.org/abs/${identifier.id}${identifier.version === undefined ? '' : `v${identifier.version}`}`
}

export function parseArxivPage(payload, configuredLimits = {}) {
  const limits = boundedLimits(configuredLimits)
  const status = responseStatus(payload)
  if (status !== undefined && (status < 200 || status >= 300)) throw sourceUpstreamStatus(status)
  const bytes = responseBody(payload)
  if (bytes.length === 0 || bytes.length > limits.maxPayloadBytes) throw sourcePayloadRejected()
  contentType(payload)
  const xml = decodeUtf8(bytes)
  rejectHostileXml(xml)
  let parsed
  try {
    const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false, unpairedTags: [] })
    if (validation !== true) throw sourcePayloadRejected()
    parsed = new XMLParser(XML_PARSER_OPTIONS).parse(xml)
  } catch (error) {
    if (error instanceof Error && error.code === 'source_payload_rejected') throw error
    throw sourcePayloadRejected()
  }
  const feed = parsed?.feed
  if (!feed || typeof feed !== 'object') throw sourcePayloadRejected()
  const entries = asArray(feed.entry)
  if (entries.length > limits.maxEntries) throw sourcePayloadRejected()
  const totalResults = Number.parseInt(textValue(feed.totalResults ?? feed['opensearch:totalResults']), 10)
  if (!Number.isSafeInteger(totalResults) || totalResults < 0 || totalResults > MAX_QUERY_RESULTS) throw sourcePayloadRejected()
  const startIndex = Number.parseInt(textValue(feed.startIndex ?? feed['opensearch:startIndex']), 10)
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw sourcePayloadRejected()
  return Object.freeze({ entries: Object.freeze(entries), totalResults, startIndex, retrievedXmlBytes: bytes.length })
}

export { boundedLimits, hasField, attribute, textValue, asArray }
