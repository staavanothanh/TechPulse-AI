import { evaluateContentPolicy } from '../policy/content-policy.js'
import { evaluateMediaPolicy } from '../policy/media-policy.js'
import { ArticleError, invalidCandidate, sourcePolicyBlocked } from './errors.js'
import { calculateDedupeKey, canonicalUrlHash } from './identity.js'
import { classifyTopics, classifyTopicIds } from './topic-classifier.js'
import { TOPIC_TAXONOMY_VERSION } from '../../../shared/topic-catalog.js'

const URL_MAX_CHARS = 2048
const TITLE_MAX_CHARS = 2000
const FIELD_MAX_CHARS = 20_000
const TOPIC_MAX_CHARS = 100
const TRACKING_PARAMETER = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i
const ENTITY_VALUES = Object.freeze({ amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' })

function text(value, maximum = FIELD_MAX_CHARS) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
      const key = entity.toLowerCase()
      if (Object.prototype.hasOwnProperty.call(ENTITY_VALUES, key)) return ENTITY_VALUES[key]
      const point = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
    })
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (Array.from(normalized).length > maximum) throw invalidCandidate()
  return normalized
}

function dateValue(value, fallback) {
  const date = value === undefined ? new Date(fallback) : value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw invalidCandidate()
  return date
}

export function canonicalizeHttpsUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > URL_MAX_CHARS || [...raw].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f || character === '<' || character === '>')) throw invalidCandidate()
  let parsed
  try { parsed = new URL(raw) } catch { throw invalidCandidate() }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) throw invalidCandidate()
  parsed.hash = ''
  const retained = [...parsed.searchParams.entries()].filter(([key]) => !TRACKING_PARAMETER.test(key)).sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
  parsed.search = ''
  for (const [key, item] of retained) parsed.searchParams.append(key, item)
  return parsed.href
}

export function normalizeLanguage(value) {
  const language = text(value, 50).replace(/_/g, '-').toLowerCase()
  if (!language) return 'und'
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) return 'und'
  return language
}

export function normalizeTopics(values) {
  const input = (Array.isArray(values) ? values : values === undefined || values === null ? [] : [values]).slice(0, 100)
  const topics = input.map((value) => text(value, TOPIC_MAX_CHARS).toLowerCase()).filter(Boolean)
  return Object.freeze([...new Set(topics)].sort((left, right) => left.localeCompare(right)).slice(0, 50))
}

function sourceIdFor(source) {
  const id = source?.id ?? source?.sourceId ?? source?._id
  if (id === undefined || id === null || String(id).trim() === '') throw invalidCandidate()
  return String(id)
}

function provenanceFor(candidate, sourceId, originalUrl, publishedAt, retrievedAt) {
  const incoming = Array.isArray(candidate.provenance) ? candidate.provenance : candidate.provenance ? [candidate.provenance] : []
  const values = [...incoming.slice(0, 20), { sourceId, originalUrl, externalId: candidate.externalId, observedAt: retrievedAt ?? publishedAt }]
  const seen = new Set()
  return Object.freeze(values.map((entry) => {
    const item = {
      sourceId: String(entry.sourceId ?? sourceId),
      originalUrl: canonicalizeHttpsUrl(entry.originalUrl ?? originalUrl),
      observedAt: dateValue(entry.observedAt, retrievedAt),
    }
    if (entry.externalId !== undefined && entry.externalId !== null && String(entry.externalId).trim()) item.externalId = text(entry.externalId, 500)
    const key = item.externalId ? `${item.sourceId}|${item.externalId}` : `${item.sourceId}|${item.originalUrl}`
    if (seen.has(key)) return undefined
    seen.add(key)
    return Object.freeze(item)
  }).filter(Boolean).slice(0, 20))
}

function mediaFor(candidate, source, fallbackPageUrl) {
  if (!candidate?.mediaCandidate) return { leadMedia: null, leadMediaStatus: 'none' }
  const media = candidate.mediaCandidate
  try {
    const result = evaluateMediaPolicy(source, {
      ...media,
      altText: media.altText ?? media.alt,
      credit: media.credit,
      sourcePageUrl: media.sourcePageUrl ?? fallbackPageUrl ?? candidate.originalUrl,
    })
    if (!result.allowed) return { leadMedia: null, leadMediaStatus: 'none' }
    return {
      leadMedia: Object.freeze({ type: result.type, displayMode: result.displayMode, url: result.url, sourcePageUrl: result.sourcePageUrl, altText: result.altText ?? null, credit: result.credit ?? null, attribution: result.attribution, mediaEvidenceStatus: 'not-analyzed', sourcePolicyVersion: result.policyVersion }),
      leadMediaStatus: 'available',
    }
  } catch { return { leadMedia: null, leadMediaStatus: 'none' } }
}

export function normalizeCandidateToArticle(candidate, { source, now = new Date() } = {}) {
  if (!candidate || typeof candidate !== 'object' || !source || source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus) || source.technicalCheck?.status !== 'passed') throw sourcePolicyBlocked()
  const authorityAllowed = source.connectorType === 'hacker-news' ? source.authorityTier === 'community-signal' : source.connectorType === 'arxiv' ? source.authorityTier === 'primary' : ['primary', 'editorial'].includes(source.authorityTier)
  if (!['rss', 'arxiv', 'hacker-news'].includes(source.connectorType) || !authorityAllowed) throw sourcePolicyBlocked()
  const sourceId = sourceIdFor(source)
  if (candidate.sourceId !== undefined && String(candidate.sourceId) !== sourceId) throw invalidCandidate()
  if (candidate.connectorType !== undefined && candidate.connectorType !== source.connectorType) throw invalidCandidate()
  if (candidate.authorityTier !== undefined && candidate.authorityTier !== source.authorityTier) throw invalidCandidate()
  if (!Number.isInteger(source.policyVersion) || source.policyVersion < 1) throw sourcePolicyBlocked()
  const metadataGate = evaluateContentPolicy(source, 'metadata')
  if (!metadataGate.allowed) throw sourcePolicyBlocked()
  const originalUrl = canonicalizeHttpsUrl(candidate.originalUrl)
  const titleOriginal = text(candidate.titleOriginal, TITLE_MAX_CHARS)
  if (!titleOriginal) throw invalidCandidate()
  const publishedAt = dateValue(candidate.publishedAt)
  const retrievedAt = dateValue(candidate.retrievedAt, now)
  const sourceLanguage = normalizeLanguage(candidate.sourceLanguage ?? source.sourceLanguage)
  const excerptGate = evaluateContentPolicy(source, 'excerpt')
  const excerptOriginal = excerptGate.allowed && source.storageScope?.excerpt && candidate.excerptOriginal !== undefined ? text(candidate.excerptOriginal) : undefined
  const topics = classifyTopics({ values: normalizeTopics(candidate.topics), titleOriginal, excerptOriginal })
  const topicIds = classifyTopicIds({ values: normalizeTopics(candidate.topics), titleOriginal, excerptOriginal })
  const topicTaxonomyVersion = TOPIC_TAXONOMY_VERSION
  const author = candidate.author === undefined ? undefined : text(candidate.author, 500)
  const canonicalHash = canonicalUrlHash(originalUrl)
  const externalId = candidate.externalId === undefined || candidate.externalId === null ? undefined : text(candidate.externalId, 500)
  const provenance = provenanceFor(candidate, sourceId, originalUrl, publishedAt, retrievedAt)
  const media = mediaFor(candidate, source, originalUrl)
  const contentScope = excerptOriginal !== undefined ? 'excerpt' : 'metadata'
  const searchTextNormalized = text([titleOriginal, author, ...topics, excerptOriginal].filter(Boolean).join(' ')).toLowerCase()
  const article = {
    sourceId,
    connectorType: source.connectorType,
    ...(externalId ? { externalId } : {}),
    sourceType: source.sourceKey ?? source.connectorType,
    authorityTier: source.authorityTier,
    evidenceEligible: source.authorityTier !== 'community-signal',
    status: 'published',
    titleOriginal,
    titleVi: null,
    originalUrl,
    canonicalUrl: originalUrl,
    canonicalUrlHash: canonicalHash,
    ...(author ? { author } : {}),
    publishedAt,
    retrievedAt,
    sourceLanguage,
    topics,
    topicIds,
    topicTaxonomyVersion,
    ...(excerptOriginal !== undefined ? { excerptOriginal } : {}),
    searchTextNormalized,
    ...media,
    summaryVi: null,
    summaryStatus: 'pending',
    summaryParagraphsVi: null,
    summaryDetailStatus: 'pending',
    summaryBasis: null,
    summaryModel: null,
    summaryInputHash: null,
    summarySourcePolicyVersion: null,
    summaryGeneratedAt: null,
    summaryError: null,
    contentScope,
    rightsSnapshot: { sourcePolicyVersion: source.policyVersion, licenseStatus: source.licenseStatus, llmInputScope: source.llmInputScope, capturedAt: retrievedAt },
    embeddingStatus: 'pending',
    embedding: null,
    embeddingModel: null,
    embeddingDimensions: null,
    embeddingInputHash: null,
    embeddingVersion: null,
    embeddingSourcePolicyVersion: null,
    embeddedAt: null,
    embeddingError: null,
    provenance,
    dedupeKey: calculateDedupeKey({ sourceId, externalId, canonicalUrlHash: canonicalHash }),
    createdAt: retrievedAt,
    updatedAt: retrievedAt,
  }
  return Object.freeze(article)
}

export { ArticleError, text as sanitizeText }
