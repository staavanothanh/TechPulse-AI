import { ARXIV_LIMITS, sourceConfigRejected } from './errors.js'
import { asArray, attribute, canonicalArxivUrl, hasField, normalizeArxivId, normalizeText, textValue } from './parser.js'

function asDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function fieldWithLimits(entry, name, limits) {
  if (!hasField(entry, name)) return { present: false }
  return { present: true, value: normalizeText(entry[name], limits) }
}

function safeHttpsUrl(value) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > 2048 || [...raw].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f || character === '<' || character === '>'
  })) return undefined
  let url
  try { url = new URL(raw) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined
  url.hash = ''
  return url.href
}

function safeLicenseUrl(value) {
  const raw = String(value ?? '').trim().replace(/^http:\/\//i, 'https://')
  return safeHttpsUrl(raw)
}

function articleUrl(entry, identifier) {
  const alternate = asArray(entry.link).find((link) => {
    const rel = attribute(link, 'rel')
    const title = attribute(link, 'title')
    return (!rel || rel.toLowerCase() === 'alternate') && (!title || title.toLowerCase() !== 'pdf')
  })
  const linkedUrl = safeHttpsUrl(attribute(alternate, 'href'))
  if (linkedUrl) {
    const hostname = new URL(linkedUrl).hostname.toLowerCase()
    if (hostname === 'arxiv.org' || hostname === 'export.arxiv.org') return linkedUrl
  }
  return canonicalArxivUrl(identifier)
}

function authorFor(entry, limits) {
  const names = asArray(entry.author)
    .map((author) => normalizeText(author?.name ?? author, limits))
    .filter((name) => name !== '')
  if (names.length === 0) return asArray(entry.author).length > 0 ? { present: true, value: '' } : { present: false }
  return { present: true, value: normalizeText(names.join('; '), limits) }
}

function licenseFor(entry, limits) {
  const license = entry.license ?? entry['arxiv:license']
  if (license === undefined) return { status: 'unknown' }
  const text = normalizeText(textValue(license), limits)
  const url = safeLicenseUrl(attribute(license, 'uri'))
  return {
    status: 'declared',
    ...(url ? { url } : {}),
    ...(text ? { text } : {}),
  }
}

function sourceMetadataFor(entry, limits) {
  const metadata = {}
  for (const [key, outputKey] of [['doi', 'doi'], ['journalRef', 'journalRef'], ['comment', 'comment']]) {
    if (hasField(entry, key)) metadata[outputKey] = normalizeText(entry[key], limits)
  }
  return Object.keys(metadata).length > 0 ? Object.freeze(metadata) : undefined
}

export function normalizeArxivEntry(entry, { source, retrievedAt, limits } = {}) {
  if (!entry || typeof entry !== 'object') return undefined
  const fieldLimits = limits ?? ARXIV_LIMITS
  const identifier = normalizeArxivId(textValue(entry.id))
  if (!identifier) return undefined
  const title = fieldWithLimits(entry, 'title', fieldLimits)
  if (!title.present || title.value === '') return undefined
  const published = fieldWithLimits(entry, 'published', fieldLimits)
  const updated = fieldWithLimits(entry, 'updated', fieldLimits)
  const publishedAt = asDate(published.present && published.value ? published.value : updated.present ? updated.value : '')
  if (!publishedAt) return undefined
  const originalUrl = articleUrl(entry, identifier)
  if (!originalUrl) return undefined
  const candidate = {
    connectorType: 'arxiv',
    retrievedAt: new Date(retrievedAt),
    authorityTier: source?.authorityTier ?? 'primary',
    externalId: identifier.id,
    titleOriginal: title.value,
    originalUrl,
    publishedAt,
    sourceLanguage: normalizeText(source?.sourceLanguage ?? source?.connectorConfig?.sourceLanguage ?? 'en', fieldLimits).toLowerCase(),
    licenseMetadata: licenseFor(entry, fieldLimits),
    provenance: {
      connectorType: 'arxiv',
      observedAt: new Date(retrievedAt),
      externalId: identifier.id,
      originalUrl,
    },
  }
  if (identifier.version !== undefined) candidate.externalIdVersion = identifier.version
  const sourceId = source?.id ?? source?.sourceId ?? source?._id
  if (sourceId !== undefined && sourceId !== null) {
    candidate.sourceId = sourceId
    candidate.provenance.sourceId = sourceId
  }
  if (source?.sourceKey !== undefined) candidate.provenance.sourceKey = source.sourceKey
  const authors = authorFor(entry, fieldLimits)
  if (authors.present) candidate.author = authors.value
  if (hasField(entry, 'summary')) candidate.excerptOriginal = normalizeText(entry.summary, fieldLimits)
  const topics = asArray(entry.category)
    .map((category) => normalizeText(attribute(category, 'term') ?? '', fieldLimits))
    .filter((topic) => topic !== '')
  if (topics.length > 0) candidate.topics = Object.freeze([...new Set(topics)])
  const sourceMetadata = sourceMetadataFor(entry, fieldLimits)
  if (sourceMetadata) candidate.sourceMetadata = sourceMetadata
  return Object.freeze(candidate)
}

export function validateArxivSource(source, query) {
  if (source?.connectorType !== undefined && source.connectorType !== 'arxiv') throw sourceConfigRejected()
  if (source?.accessMethod !== undefined && source.accessMethod !== 'api') throw sourceConfigRejected()
  if (source?.authorityTier !== undefined && source.authorityTier !== 'primary') throw sourceConfigRejected()
  if (source?.connectorConfig?.kind !== undefined && source.connectorConfig.kind !== 'arxiv') throw sourceConfigRejected()
  if (typeof query !== 'string' || query.trim() === '' || query.trim().length > 200) throw sourceConfigRejected()
  return query.trim()
}

export { safeHttpsUrl }
