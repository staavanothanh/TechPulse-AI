import { ObjectId } from 'mongodb'

export const REMOVED_ARTICLE_TOMBSTONE_FIELDS = Object.freeze([
  '_id',
  'sourceId',
  'connectorType',
  'externalId',
  'externalIdVersion',
  'canonicalUrlHash',
  'status',
  'evidenceEligible',
  'removalPolicyVersion',
  'removedAt',
  'createdAt',
  'updatedAt',
])

const OPTIONAL_STRING_FIELDS = Object.freeze(['externalId', 'externalIdVersion'])

function objectId(value) {
  return value instanceof ObjectId ? value : typeof value === 'string' && ObjectId.isValid(value) ? new ObjectId(value) : null
}

function validDate(value) { return value instanceof Date && !Number.isNaN(value.getTime()) }

function timestamp(value, fallback) {
  const result = value instanceof Date ? new Date(value) : new Date(value ?? fallback)
  if (!validDate(result)) throw new Error('Removed article timestamp is invalid')
  return result
}

export function buildRemovedArticleTombstone(article, { id, now } = {}) {
  const articleId = objectId(article?._id ?? id)
  const sourceId = objectId(article?.sourceId)
  if (!articleId || !sourceId) throw new Error('Removed article identity is invalid')
  const removalPolicyVersion = article?.removalPolicyVersion ?? article?.rightsSnapshot?.sourcePolicyVersion
  if (!Number.isInteger(removalPolicyVersion) || removalPolicyVersion < 1) throw new Error('Removed article policy fence is invalid')
  const result = {
    _id: articleId,
    sourceId,
    connectorType: article.connectorType,
    canonicalUrlHash: article.canonicalUrlHash,
    status: 'removed',
    evidenceEligible: false,
    removalPolicyVersion,
    removedAt: timestamp(article.removedAt, now ?? article.updatedAt),
    createdAt: timestamp(article.createdAt, now ?? article.removedAt),
    updatedAt: timestamp(now ?? article.updatedAt, article.removedAt),
  }
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (typeof article[field] === 'string' && article[field].length > 0) result[field] = article[field]
  }
  if (!['rss', 'arxiv', 'hacker-news'].includes(result.connectorType)) throw new Error('Removed article connector type is invalid')
  if (typeof result.canonicalUrlHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.canonicalUrlHash)) throw new Error('Removed article ingestion identity is invalid')
  return result
}

export function serializeRemovedArticleTombstone(document) {
  if (!document || document.status !== 'removed') return null
  const result = {
    id: document._id?.toHexString?.() ?? String(document.id ?? ''),
    sourceId: document.sourceId?.toHexString?.() ?? String(document.sourceId ?? ''),
    ...(document.connectorType ? { connectorType: document.connectorType } : {}),
    ...(typeof document.externalId === 'string' ? { externalId: document.externalId } : {}),
    ...(typeof document.externalIdVersion === 'string' ? { externalIdVersion: document.externalIdVersion } : {}),
    canonicalUrlHash: document.canonicalUrlHash,
    status: 'removed',
    evidenceEligible: false,
    ...(Number.isInteger(document.removalPolicyVersion) ? { removalPolicyVersion: document.removalPolicyVersion } : {}),
    ...(document.removedAt ? { removedAt: timestamp(document.removedAt).toISOString() } : {}),
    ...(document.createdAt ? { createdAt: timestamp(document.createdAt).toISOString() } : {}),
    ...(document.updatedAt ? { updatedAt: timestamp(document.updatedAt).toISOString() } : {}),
  }
  return result
}

export function validateRemovedArticleTombstone(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  const allowed = new Set(REMOVED_ARTICLE_TOMBSTONE_FIELDS)
  for (const field of Object.keys(document)) if (!allowed.has(field)) errors.push(`${field} is not allowed on a removed article tombstone`)
  if (!(document._id instanceof ObjectId)) errors.push('_id must be an ObjectId')
  if (!(document.sourceId instanceof ObjectId)) errors.push('sourceId must be an ObjectId')
  if (!['rss', 'arxiv', 'hacker-news'].includes(document.connectorType)) errors.push('connectorType is invalid')
  if (typeof document.canonicalUrlHash !== 'string' || !/^[a-f0-9]{64}$/.test(document.canonicalUrlHash)) errors.push('canonicalUrlHash is invalid')
  if (document.status !== 'removed') errors.push('status must be removed')
  if (document.evidenceEligible !== false) errors.push('evidenceEligible must be false')
  if (!Number.isInteger(document.removalPolicyVersion) || document.removalPolicyVersion < 1) errors.push('removalPolicyVersion is invalid')
  for (const field of ['removedAt', 'createdAt', 'updatedAt']) if (!validDate(document[field])) errors.push(`${field} is invalid`)
  for (const field of OPTIONAL_STRING_FIELDS) if (document[field] !== undefined && (typeof document[field] !== 'string' || document[field].length < 1 || document[field].length > 500)) errors.push(`${field} is invalid`)
  return { valid: errors.length === 0, errors }
}
