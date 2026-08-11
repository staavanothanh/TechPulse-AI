import { createHash } from 'node:crypto'

export function canonicalUrlHash(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function calculateDedupeKey({ sourceId, externalId, canonicalUrlHash: hash } = {}) {
  if (externalId !== undefined && externalId !== null && String(externalId).trim()) return `source:${String(sourceId)}:external:${encodeURIComponent(String(externalId).trim())}`
  if (hash) return `url:${hash}`
  throw new Error('Article dedupe identity is required')
}

export function articleIdentityKeys(article) {
  const keys = []
  if (article?.sourceId !== undefined && article?.externalId) keys.push(`source:${String(article.sourceId)}:external:${encodeURIComponent(String(article.externalId))}`)
  if (article?.canonicalUrlHash) keys.push(`url:${article.canonicalUrlHash}`)
  return Object.freeze(keys)
}
