import { HACKER_NEWS_LIMITS, sourceConfigRejected, sourcePayloadRejected } from './errors.js'

function normalizedText(value, maxFieldChars) {
  const text = String(value ?? '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
      const key = entity.toLowerCase()
      if (key === 'amp') return '&'
      if (key === 'apos') return "'"
      if (key === 'gt') return '>'
      if (key === 'lt') return '<'
      if (key === 'quot') return '"'
      const codePoint = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ''
    })
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if ([...text].length > maxFieldChars) throw sourcePayloadRejected()
  return text
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

function itemUrl(id) {
  return `https://news.ycombinator.com/item?id=${encodeURIComponent(String(id))}`
}

export function normalizeHackerNewsItem(item, { source, retrievedAt, maxFieldChars } = {}) {
  if (!item || typeof item !== 'object' || item.deleted === true || item.dead === true || item.type !== 'story') return undefined
  const fieldLimit = maxFieldChars ?? HACKER_NEWS_LIMITS.maxFieldChars
  const id = Number(item.id)
  const timestamp = Number(item.time)
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(timestamp) || timestamp < 0) return undefined
  const title = normalizedText(item.title, fieldLimit)
  if (!title) return undefined
  const originalUrl = safeHttpsUrl(item.url) ?? itemUrl(id)
  const candidate = {
    connectorType: 'hacker-news',
    retrievedAt: new Date(retrievedAt),
    authorityTier: 'community-signal',
    communitySignal: true,
    externalId: String(id),
    titleOriginal: title,
    originalUrl,
    publishedAt: new Date(timestamp * 1000),
    sourceLanguage: normalizedText(source?.sourceLanguage ?? 'en', fieldLimit).toLowerCase(),
    provenance: {
      connectorType: 'hacker-news',
      observedAt: new Date(retrievedAt),
      externalId: String(id),
      originalUrl,
    },
  }
  const sourceId = source?.id ?? source?.sourceId ?? source?._id
  if (sourceId !== undefined && sourceId !== null) {
    candidate.sourceId = sourceId
    candidate.provenance.sourceId = sourceId
  }
  if (source?.sourceKey !== undefined) candidate.provenance.sourceKey = source.sourceKey
  if (item.by !== undefined) candidate.author = normalizedText(item.by, fieldLimit)
  if (item.text !== undefined) {
    const excerpt = normalizedText(item.text, fieldLimit)
    candidate.excerptOriginal = excerpt
  }
  if (Number.isSafeInteger(Number(item.score))) candidate.communityScore = Number(item.score)
  if (Number.isSafeInteger(Number(item.descendants))) candidate.commentCount = Number(item.descendants)
  return Object.freeze(candidate)
}

export function validateHackerNewsSource(source, stream) {
  if (source?.connectorType !== undefined && source.connectorType !== 'hacker-news') throw sourceConfigRejected()
  if (source?.accessMethod !== undefined && source.accessMethod !== 'api') throw sourceConfigRejected()
  if (source?.authorityTier !== undefined && source.authorityTier !== 'community-signal') throw sourceConfigRejected()
  if (source?.connectorConfig?.kind !== undefined && source.connectorConfig.kind !== 'hacker-news') throw sourceConfigRejected()
  if (!['topstories', 'newstories', 'beststories'].includes(stream)) throw sourceConfigRejected()
  return stream
}

export { itemUrl, safeHttpsUrl }
