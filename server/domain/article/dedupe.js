import { articleIdentityKeys } from './identity.js'

function titleFingerprint(value) {
  return String(value ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function tokenSet(value) {
  return new Set(titleFingerprint(value).split(' ').filter(Boolean))
}

function nearTitle(left, right) {
  const a = tokenSet(left)
  const b = tokenSet(right)
  if (a.size === 0 || b.size === 0) return false
  const intersection = [...a].filter((token) => b.has(token)).length
  return intersection / Math.max(a.size, b.size) >= 0.75
}

function provenanceKey(value) {
  return value.externalId ? `${value.sourceId}|${value.externalId}` : `${value.sourceId}|${value.originalUrl}`
}

export function mergeProvenance(...collections) {
  const merged = new Map()
  for (const collection of collections.flat()) {
    if (!collection) continue
    const item = { sourceId: String(collection.sourceId), originalUrl: String(collection.originalUrl), observedAt: new Date(collection.observedAt), ...(collection.externalId ? { externalId: String(collection.externalId) } : {}) }
    if (Number.isNaN(item.observedAt.getTime())) continue
    merged.set(provenanceKey(item), item)
  }
  return Object.freeze([...merged.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.originalUrl.localeCompare(right.originalUrl) || left.observedAt - right.observedAt).slice(0, 20))
}

export function assessDedupe(left, right) {
  const leftKeys = new Set(articleIdentityKeys(left))
  const duplicate = articleIdentityKeys(right).some((key) => leftKeys.has(key)) || left.canonicalUrlHash && left.canonicalUrlHash === right.canonicalUrlHash
  if (duplicate) return { decision: 'duplicate', dedupeKey: left.dedupeKey, reason: 'stable-identity' }
  if (nearTitle(left.titleOriginal, right.titleOriginal)) return { decision: 'review-needed', dedupeKey: left.dedupeKey, reason: 'near-title-different-url' }
  return { decision: 'new', dedupeKey: right.dedupeKey, reason: 'no-stable-match' }
}

export function mergeArticleRecords(canonical, incoming) {
  const decision = assessDedupe(canonical, incoming)
  const provenance = mergeProvenance(canonical.provenance, incoming.provenance)
  const topics = Object.freeze([...new Set([...(canonical.topics ?? []), ...(incoming.topics ?? [])])].sort())
  const merged = {
    ...canonical,
    ...(decision.decision === 'review-needed' ? { status: 'review-needed' } : {}),
    topics,
    provenance,
    ...(canonical.author ? {} : incoming.author ? { author: incoming.author } : {}),
    ...(canonical.excerptOriginal ? {} : incoming.excerptOriginal ? { excerptOriginal: incoming.excerptOriginal } : {}),
    updatedAt: new Date(Math.max(new Date(canonical.updatedAt).getTime(), new Date(incoming.updatedAt).getTime())),
  }
  for (const forbidden of ['raw', 'rawHtml', 'html', 'body', 'content', 'fullText', 'translatedFullText', 'mediaBinary', 'binary', 'imageBinary', 'videoBinary', 'audioBinary', 'base64', 'gridFsId', 'providerPayload']) delete merged[forbidden]
  return Object.freeze(merged)
}

export { titleFingerprint }
