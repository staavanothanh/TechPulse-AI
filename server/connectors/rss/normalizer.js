import { RSS_LIMITS, sourceConfigRejected, sourcePayloadRejected } from './errors.js'

const URL_MAX_CHARS = 2_048
const STANDARD_ENTITY_VALUES = Object.freeze({ amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' })

function asDate(value) {
  if (value instanceof Date) return new Date(value)
  const date = new Date(value)
  return date
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|amp|apos|gt|lt|quot);/gi, (match, entity) => {
    const key = entity.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(STANDARD_ENTITY_VALUES, key)) return STANDARD_ENTITY_VALUES[key]
    const codePoint = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10)
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return ''
    try { return String.fromCodePoint(codePoint) } catch { return '' }
  })
}

function plainText(value) {
  return decodeEntities(String(value ?? ''))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizedText(value, limits) {
  const result = plainText(value)
  if (Array.from(result).length > limits.maxFieldChars) throw sourcePayloadRejected()
  return result
}

function nodeText(node) {
  return [node?.text ?? '', ...(node?.children ?? []).map(nodeText)].join(' ')
}

function matchesNodeName(child, wanted) {
  const exact = child.name.toLowerCase()
  if (wanted.has(exact)) return true
  if (!wanted.has(child.localName)) return false
  if (!exact.includes(':')) return true
  const prefix = exact.split(':', 1)[0]
  return ['atom', 'dc', 'dcterms', 'rss', 'xml'].includes(prefix)
}

function field(node, names, limits) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()))
  const found = node?.children?.find((child) => matchesNodeName(child, wanted))
  return found ? { present: true, value: normalizedText(nodeText(found), limits) } : { present: false }
}

function nestedField(node, parentNames, childNames, limits) {
  const wantedParents = new Set(parentNames.map((name) => String(name).toLowerCase()))
  const parent = node?.children?.find((child) => matchesNodeName(child, wantedParents))
  if (!parent) return { present: false }
  const nested = field(parent, childNames, limits)
  return nested.present ? nested : { present: true, value: normalizedText(nodeText(parent), limits) }
}

function attribute(node, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()))
  for (const [key, value] of Object.entries(node?.attributes ?? {})) {
    const normalized = key.replace(/^@_/, '').toLowerCase()
    const local = normalized.split(':').pop()
    if (wanted.has(normalized) || wanted.has(local)) return { present: true, value: String(value ?? '') }
  }
  return { present: false }
}

function children(node, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()))
  return (node?.children ?? []).filter((child) => matchesNodeName(child, wanted))
}

function prefixedField(node, prefix, names, limits) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()))
  const found = (node?.children ?? []).find((child) => child.name.toLowerCase().startsWith(prefix + ':') && wanted.has(child.localName))
  return found ? { present: true, value: normalizedText(nodeText(found), limits) } : { present: false }
}

function safeHttpsUrl(value, baseUrl) {
  const raw = String(value ?? '').trim()
  if (!raw || raw.length > URL_MAX_CHARS || [...raw].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f || character === '<' || character === '>'
  })) return undefined
  let url
  try { url = new URL(raw, baseUrl) } catch { return undefined }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined
  url.hash = ''
  return url.href
}

function feedUrlFor(source, parsedUrl) {
  const configured = source?.connectorConfig?.feedUrl ?? parsedUrl
  const feedUrl = safeHttpsUrl(configured)
  if (!feedUrl) throw sourceConfigRejected()
  return feedUrl
}

function putField(target, key, value) {
  if (value.present) target[key] = value.value
}

function languageFor(item, context, limits) {
  const itemLanguage = field(item, ['language', 'dc:language'], limits)
  if (itemLanguage.present) return itemLanguage
  const itemAttribute = attribute(item, ['xml:lang', 'lang'])
  if (itemAttribute.present) return { present: true, value: normalizedText(itemAttribute.value, limits).toLowerCase() }
  return context.language
}

function authorFor(item, limits) {
  const author = nestedField(item, ['author'], ['name'], limits)
  if (author.present) return author
  const directAuthor = field(item, ['author'], limits)
  if (directAuthor.present) return directAuthor
  return field(item, ['creator', 'dc:creator'], limits)
}

function dateFor(item, feedType, limits) {
  const candidateFields = feedType === 'atom' ? ['published', 'updated'] : ['pubdate', 'published', 'date', 'dc:date']
  const selected = candidateFields.map((name) => field(item, [name], limits)).find((value) => value.present)
  if (!selected) return { present: false }
  if (selected.value === '') return { present: true, value: null }
  const parsed = asDate(selected.value)
  return { present: true, value: validDate(parsed) ? parsed : null }
}

function articleLinkFor(item, feedType, feedUrl, limits) {
  if (feedType === 'atom') {
    const links = children(item, ['link'])
    const alternate = links.find((link) => {
      const rel = attribute(link, ['rel'])
      return !rel.present || rel.value.toLowerCase() === 'alternate'
    })
    if (!alternate) return { present: false }
    const href = attribute(alternate, ['href'])
    return { present: true, value: safeHttpsUrl(href.present ? href.value : nodeText(alternate), feedUrl) }
  }
  const link = field(item, ['link'], limits)
  return link.present ? { present: true, value: safeHttpsUrl(link.value, feedUrl) } : { present: false }
}

function mediaType(node) {
  const medium = attribute(node, ['medium'])
  if (medium.present && ['image', 'video'].includes(medium.value.toLowerCase())) return medium.value.toLowerCase()
  const mime = attribute(node, ['type'])
  if (mime.present && /^(image|video)\//i.test(mime.value)) return mime.value.split('/', 1)[0].toLowerCase()
  return undefined
}

function mediaCandidateFor(item, feedUrl, feedType, limits) {
  const mediaNodes = (item?.children ?? []).filter((node) => {
    const name = node.name.toLowerCase()
    return name.startsWith('media:') && ['content', 'thumbnail'].includes(node.localName)
  })
  const enclosures = children(item, ['enclosure'])
  const atomEnclosures = feedType === 'atom'
    ? children(item, ['link']).filter((node) => attribute(node, ['rel']).value?.toLowerCase() === 'enclosure')
    : []
  for (const node of [...mediaNodes, ...enclosures, ...atomEnclosures]) {
    const url = attribute(node, ['url', 'href'])
    const mediaUrl = safeHttpsUrl(url.present ? url.value : nodeText(node), feedUrl)
    const type = mediaType(node)
    if (!mediaUrl || !type) continue
    const candidate = { url: mediaUrl, type }
    const alt = prefixedField(node, 'media', ['description', 'title'], limits)
    const attrAlt = attribute(node, ['alt'])
    const credit = prefixedField(node, 'media', ['credit'], limits)
    const attrCredit = attribute(node, ['credit'])
    if (alt.present) candidate.alt = alt.value
    else if (attrAlt.present) candidate.alt = normalizedText(attrAlt.value, limits)
    if (credit.present) candidate.credit = credit.value
    else if (attrCredit.present) candidate.credit = normalizedText(attrCredit.value, limits)
    return candidate
  }
  return undefined
}

function externalIdFor(item, feedType, limits) {
  const id = field(item, feedType === 'atom' ? ['id'] : ['guid', 'id'], limits)
  return id
}

function itemNodes(root, feedType) {
  if (feedType === 'atom') return children(root, ['entry'])
  const channel = children(root, ['channel'])[0]
  return children(channel ?? root, ['item'])
}

function rootContext(root, feedType, limits) {
  const rootLanguage = attribute(root, ['xml:lang', 'lang'])
  const channel = feedType === 'rss' ? children(root, ['channel'])[0] : root
  const channelLanguage = field(channel, ['language', 'dc:language'], limits)
  if (channelLanguage.present) return channelLanguage
  if (rootLanguage.present) return { present: true, value: normalizedText(rootLanguage.value, limits).toLowerCase() }
  return { present: false }
}

function normalizeItem(item, { source, feedUrl, feedType, retrievedAt, language, limits }) {
  const candidate = {
    connectorType: 'rss',
    retrievedAt: new Date(retrievedAt),
  }
  const sourceId = source?.id ?? source?.sourceId ?? source?._id
  if (sourceId !== undefined && sourceId !== null) candidate.sourceId = sourceId
  if (source?.authorityTier !== undefined) candidate.authorityTier = source.authorityTier
  putField(candidate, 'externalId', externalIdFor(item, feedType, limits))
  putField(candidate, 'titleOriginal', field(item, ['title'], limits))
  const originalUrl = articleLinkFor(item, feedType, feedUrl, limits)
  if (originalUrl.present && originalUrl.value) candidate.originalUrl = originalUrl.value
  putField(candidate, 'author', authorFor(item, limits))
  putField(candidate, 'publishedAt', dateFor(item, feedType, limits))
  putField(candidate, 'sourceLanguage', languageFor(item, { language }, limits))
  putField(candidate, 'excerptOriginal', field(item, feedType === 'atom' ? ['summary'] : ['description'], limits))
  const mediaCandidate = mediaCandidateFor(item, feedUrl, feedType, limits)
  if (mediaCandidate) candidate.mediaCandidate = mediaCandidate
  const provenance = {
    connectorType: 'rss',
    feedUrl,
    observedAt: new Date(retrievedAt),
  }
  if (sourceId !== undefined && sourceId !== null) provenance.sourceId = sourceId
  if (source?.sourceKey !== undefined) provenance.sourceKey = source.sourceKey
  if (Object.prototype.hasOwnProperty.call(candidate, 'externalId')) provenance.externalId = candidate.externalId
  if (Object.prototype.hasOwnProperty.call(candidate, 'originalUrl')) provenance.originalUrl = candidate.originalUrl
  candidate.provenance = provenance
  return Object.freeze(candidate)
}

export function normalizeRssAtom({ parsed, source, retrievedAt } = {}) {
  if (!parsed?.root || !validDate(asDate(retrievedAt))) throw sourceConfigRejected()
  const feedType = parsed.root.localName === 'feed' ? 'atom' : parsed.root.localName === 'rss' ? 'rss' : undefined
  if (!feedType) throw sourceConfigRejected()
  const feedUrl = feedUrlFor(source, parsed.url)
  const limits = parsed.limits ?? RSS_LIMITS
  const candidates = itemNodes(parsed.root, feedType).map((item) => normalizeItem(item, {
    source,
    feedUrl,
    feedType,
    retrievedAt: asDate(retrievedAt),
    language: rootContext(parsed.root, feedType, limits),
    limits,
  }))
  return Object.freeze({ feedType, candidates: Object.freeze(candidates), retrievedAt: asDate(retrievedAt), feedUrl })
}

export const normalizeFeed = normalizeRssAtom
