import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

export class SourceValidationError extends Error {
  constructor(message, details) {
    super(message)
    this.name = 'SourceValidationError'
    this.status = 422
    this.code = 'validation_failed'
    if (details) this.details = details
  }
}

const CONNECTORS = Object.freeze({
  rss: Object.freeze({ access: new Set(['rss', 'atom']), authority: new Set(['primary', 'editorial']), kind: 'rss' }),
  arxiv: Object.freeze({ access: new Set(['api']), authority: new Set(['primary']), kind: 'arxiv' }),
  'hacker-news': Object.freeze({ access: new Set(['api']), authority: new Set(['community-signal']), kind: 'hacker-news' }),
})
const STORAGE_FIELDS = Object.freeze(['metadata', 'excerpt', 'summary', 'embedding'])
const PRIVATE_SUFFIXES = Object.freeze(['.internal', '.local', '.localhost', '.localdomain', '.home', '.lan'])

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceValidationError(`${label} must be an object`)
  return value
}

function requireNonEmptyString(value, label, maximum = 4000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > maximum) throw new SourceValidationError(`${label} is invalid`)
  return value.trim()
}

function validateBatchSize(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new SourceValidationError('connector batchSize is invalid')
}

export function normalizeReviewedHostname(value) {
  const input = requireNonEmptyString(value, 'reviewed host', 253)
  if (/[:/@*\s]/.test(input)) throw new SourceValidationError('reviewed host is invalid')
  const ascii = domainToASCII(input.replace(/\.$/, '')).toLowerCase()
  if (!ascii || ascii.length > 253 || isIP(ascii) !== 0 || !ascii.includes('.')) throw new SourceValidationError('reviewed host must be a public DNS hostname')
  if (ascii === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => ascii.endsWith(suffix))) throw new SourceValidationError('reviewed host must be public')
  const labels = ascii.split('.')
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new SourceValidationError('reviewed host is not canonical')
  return ascii
}

export function validateHttpsUrl(value, label = 'URL') {
  if (value === null || value === undefined) return value
  if (typeof value !== 'string' || value.length > 2048) throw new SourceValidationError(`${label} is invalid`)
  let parsed
  try { parsed = new URL(value) } catch { throw new SourceValidationError(`${label} is invalid`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new SourceValidationError(`${label} must be HTTPS without credentials`)
  normalizeReviewedHostname(parsed.hostname)
  return parsed.toString()
}

export function validateConnectorUnit(input) {
  const value = requireObject(input, 'connector')
  const rule = CONNECTORS[value.connectorType]
  const config = requireObject(value.connectorConfig, 'connectorConfig')
  if (!rule || !rule.access.has(value.accessMethod) || !rule.authority.has(value.authorityTier) || config.kind !== rule.kind) throw new SourceValidationError('connector access or authority mismatch')
  validateBatchSize(config.batchSize)
  if (rule.kind === 'rss') validateHttpsUrl(config.feedUrl, 'feedUrl')
  if (rule.kind === 'arxiv') requireNonEmptyString(config.arxivQuery, 'arxivQuery', 200)
  if (rule.kind === 'hacker-news' && !['topstories', 'newstories', 'beststories'].includes(config.hackerNewsStream)) throw new SourceValidationError('connector stream is invalid')
  return input
}

export function normalizeSourceDefinition(input) {
  const value = requireObject(input, 'source')
  const sourceKey = requireNonEmptyString(value.sourceKey, 'sourceKey', 120)
  if (!/^[a-z0-9][a-z0-9:-]{2,119}$/.test(sourceKey)) throw new SourceValidationError('sourceKey is invalid')
  return {
    name: requireNonEmptyString(value.name, 'name', 120),
    sourceKey,
    publisherName: requireNonEmptyString(value.publisherName, 'publisherName', 160),
    domain: normalizeReviewedHostname(value.domain),
  }
}

export function normalizeMediaPolicy(value = {}) {
  const media = requireObject(value, 'mediaPolicy')
  if (!['none', 'remote-preview'].includes(media.imageMode) || !['none', 'link-only'].includes(media.videoMode)) throw new SourceValidationError('media mode is invalid')
  if (!Array.isArray(media.allowedHosts) || media.allowedHosts.length > 20) throw new SourceValidationError('media allowedHosts is invalid')
  const allowedHosts = media.allowedHosts.map(normalizeReviewedHostname)
  if (new Set(allowedHosts).size !== allowedHosts.length) throw new SourceValidationError('media allowedHosts must be unique')
  if (typeof media.attributionRequired !== 'boolean') throw new SourceValidationError('media attributionRequired is invalid')
  if (media.evidenceNote !== null && media.evidenceNote !== undefined && (typeof media.evidenceNote !== 'string' || media.evidenceNote.length > 4000)) throw new SourceValidationError('media evidenceNote is invalid')
  return { imageMode: media.imageMode, videoMode: media.videoMode, allowedHosts, attributionRequired: media.attributionRequired, evidenceNote: media.evidenceNote ?? null }
}

export function validatePolicyCompatibility(value) {
  const policy = requireObject(value, 'source policy')
  const scope = requireObject(policy.storageScope, 'storageScope')
  for (const field of STORAGE_FIELDS) if (typeof scope[field] !== 'boolean') throw new SourceValidationError(`storageScope.${field} is invalid`)
  const mediaPolicy = normalizeMediaPolicy(policy.mediaPolicy)
  if (!['permitted', 'metadata-only', 'review-needed', 'blocked'].includes(policy.licenseStatus)) throw new SourceValidationError('licenseStatus is invalid')
  if (!['none', 'metadata', 'excerpt', 'fulltext-temporary'].includes(policy.llmInputScope)) throw new SourceValidationError('llmInputScope is invalid')
  if (['review-needed', 'blocked'].includes(policy.licenseStatus)) {
    if (policy.llmInputScope !== 'none' || STORAGE_FIELDS.some((field) => scope[field])) throw new SourceValidationError(`${policy.licenseStatus} policy must be fail closed`)
  }
  if (policy.licenseStatus === 'blocked' && (mediaPolicy.imageMode !== 'none' || mediaPolicy.videoMode !== 'none' || mediaPolicy.allowedHosts.length > 0)) throw new SourceValidationError('blocked policy must disable media')
  if (policy.licenseStatus === 'metadata-only') {
    if (!['none', 'metadata'].includes(policy.llmInputScope) || !scope.metadata) throw new SourceValidationError('metadata-only policy has invalid input or metadata scope')
    if (scope.excerpt) throw new SourceValidationError('metadata-only policy cannot store excerpt')
  }
  if (policy.llmInputScope === 'none' && (scope.summary || scope.embedding)) throw new SourceValidationError('summary and embedding require an LLM input scope')
  if (policy.attributionRequired === true) requireNonEmptyString(policy.attributionText, 'attributionText', 500)
  return { ...policy, storageScope: { ...scope }, mediaPolicy }
}

export function validatePolicyReviewEvidence(review) {
  if (!['permitted', 'metadata-only', 'blocked'].includes(review.licenseStatus)) throw new SourceValidationError('review decision is invalid')
  const evidenceNote = requireNonEmptyString(review.evidenceNote, 'evidenceNote', 4000)
  const termsUrl = validateHttpsUrl(review.termsUrl, 'termsUrl')
  const licenseUrl = validateHttpsUrl(review.licenseUrl, 'licenseUrl')
  const normalized = validatePolicyCompatibility(review)
  return { ...normalized, attributionText: normalized.attributionText?.trim() || null, termsUrl: termsUrl ?? null, licenseUrl: licenseUrl ?? null, evidenceNote }
}

export const SOURCE_STORAGE_FIELDS = STORAGE_FIELDS
