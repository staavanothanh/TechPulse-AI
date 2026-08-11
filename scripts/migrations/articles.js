import { ObjectId } from 'mongodb'
import { DURABLE_JOB_AUDIT_VALIDATOR } from './durable-jobs.js'
import { canonicalUrlHash } from '../../server/domain/article/identity.js'

const date = Object.freeze({ bsonType: 'date' })
const nullableDate = Object.freeze({ bsonType: ['date', 'null'] })
const nullableString = (maxLength = 20_000) => ({ bsonType: ['string', 'null'], maxLength })
const safeError = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['code', 'message', 'retryable', 'occurredAt'],
  properties: { code: { bsonType: 'string', minLength: 1, maxLength: 128 }, message: { bsonType: 'string', minLength: 1, maxLength: 500 }, retryable: { bsonType: 'bool' }, occurredAt: date, upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 } },
})
const leadMedia = Object.freeze({
  bsonType: ['object', 'null'], additionalProperties: false,
  required: ['type', 'displayMode', 'url', 'sourcePageUrl', 'altText', 'credit', 'attribution', 'mediaEvidenceStatus', 'sourcePolicyVersion'],
  properties: {
    type: { enum: ['image', 'video'] }, displayMode: { enum: ['remote-preview', 'link-only'] },
    url: { bsonType: 'string', maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' }, sourcePageUrl: { bsonType: 'string', maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' },
    altText: nullableString(500), credit: nullableString(500), attribution: { bsonType: 'string', minLength: 1, maxLength: 500 }, mediaEvidenceStatus: { enum: ['not-analyzed'] }, sourcePolicyVersion: { bsonType: 'int', minimum: 1 },
  },
})
const rightsSnapshot = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['sourcePolicyVersion', 'licenseStatus', 'llmInputScope', 'capturedAt'],
  properties: { sourcePolicyVersion: { bsonType: 'int', minimum: 1 }, licenseStatus: { enum: ['permitted', 'metadata-only', 'review-needed', 'blocked'] }, llmInputScope: { enum: ['metadata', 'excerpt', 'fulltext-temporary', 'none'] }, capturedAt: date },
})
const provenance = Object.freeze({
  bsonType: 'array', minItems: 1, maxItems: 20, items: {
    bsonType: 'object', additionalProperties: false, required: ['sourceId', 'originalUrl', 'observedAt'],
    properties: { sourceId: { bsonType: 'objectId' }, originalUrl: { bsonType: 'string', maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' }, externalId: { bsonType: 'string', maxLength: 500 }, observedAt: date },
  },
})

const articleJsonSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'sourceId', 'connectorType', 'sourceType', 'authorityTier', 'evidenceEligible', 'status', 'titleOriginal', 'titleVi', 'originalUrl', 'canonicalUrl', 'canonicalUrlHash', 'publishedAt', 'retrievedAt', 'sourceLanguage', 'topics', 'searchTextNormalized', 'leadMedia', 'leadMediaStatus', 'summaryVi', 'summaryStatus', 'summaryBasis', 'summaryModel', 'summaryInputHash', 'summarySourcePolicyVersion', 'summaryGeneratedAt', 'summaryError', 'contentScope', 'rightsSnapshot', 'embeddingStatus', 'embedding', 'embeddingModel', 'embeddingDimensions', 'embeddingInputHash', 'embeddingVersion', 'embeddingSourcePolicyVersion', 'embeddedAt', 'embeddingError', 'provenance', 'dedupeKey', 'createdAt', 'updatedAt'],
  properties: {
    _id: { bsonType: 'objectId' }, sourceId: { bsonType: 'objectId' }, connectorType: { enum: ['rss', 'arxiv', 'hacker-news'] }, sourceType: { bsonType: 'string', minLength: 1, maxLength: 120 }, authorityTier: { enum: ['primary', 'editorial', 'community-signal'] }, evidenceEligible: { bsonType: 'bool' }, status: { enum: ['processing', 'review-needed', 'published', 'hidden', 'removed'] },
    externalId: { bsonType: 'string', minLength: 1, maxLength: 500 }, titleOriginal: { bsonType: 'string', minLength: 1, maxLength: 2000 }, titleVi: nullableString(4000), originalUrl: { bsonType: 'string', maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' }, canonicalUrl: { bsonType: 'string', maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' }, canonicalUrlHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, author: { bsonType: 'string', maxLength: 500 }, publishedAt: date, retrievedAt: date, sourceLanguage: { bsonType: 'string', minLength: 2, maxLength: 50 }, topics: { bsonType: 'array', maxItems: 50, uniqueItems: true, items: { bsonType: 'string', minLength: 1, maxLength: 100 } }, excerptOriginal: { bsonType: 'string', maxLength: 20_000 }, searchTextNormalized: { bsonType: 'string', maxLength: 24_000 },
    leadMedia, leadMediaStatus: { enum: ['none', 'available', 'hidden'] }, leadMediaHiddenReason: { bsonType: 'string', maxLength: 128 },
    summaryVi: nullableString(4000), summaryStatus: { enum: ['pending', 'processing', 'ready', 'failed', 'removed'] }, summaryBasis: { enum: ['metadata', 'excerpt', 'fulltext-temporary', null] }, summaryModel: nullableString(200), summaryInputHash: nullableString(128), summarySourcePolicyVersion: { bsonType: ['int', 'null'], minimum: 1 }, summaryGeneratedAt: nullableDate, summaryError: { oneOf: [{ bsonType: 'null' }, safeError] },
    contentScope: { enum: ['metadata', 'excerpt', 'fulltext-temporary'] }, rightsSnapshot, embeddingStatus: { enum: ['pending', 'processing', 'ready', 'failed', 'removed'] }, embedding: { bsonType: ['array', 'null'], maxItems: 4096, items: { bsonType: ['double', 'int', 'long', 'decimal'] } }, embeddingModel: nullableString(200), embeddingDimensions: { bsonType: ['int', 'null'], minimum: 1, maximum: 4096 }, embeddingInputHash: nullableString(128), embeddingVersion: { bsonType: ['int', 'null'], minimum: 1 }, embeddingSourcePolicyVersion: { bsonType: ['int', 'null'], minimum: 1 }, embeddedAt: nullableDate, embeddingError: { oneOf: [{ bsonType: 'null' }, safeError] },
    provenance, duplicateOfId: { bsonType: 'objectId' }, dedupeKey: { bsonType: 'string', minLength: 1, maxLength: 600 }, hiddenReason: { bsonType: 'string', maxLength: 128 }, removedAt: nullableDate, createdAt: date, updatedAt: date,
  },
})

export const ARTICLE_COLLECTIONS = Object.freeze({ articles: Object.freeze({ validator: { $jsonSchema: articleJsonSchema } }) })
export const ARTICLE_INDEXES = Object.freeze({
  articles: Object.freeze([
    { name: 'articles_source_external_unique', key: { sourceId: 1, externalId: 1 }, options: { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } } },
    { name: 'articles_canonical_url_hash', key: { canonicalUrlHash: 1 } },
    { name: 'articles_dedupe_key', key: { dedupeKey: 1 } },
    { name: 'articles_status_published', key: { status: 1, publishedAt: -1, _id: -1 } },
    { name: 'articles_status_topic_time', key: { status: 1, topics: 1, publishedAt: -1 } },
    { name: 'articles_status_source_time', key: { status: 1, sourceId: 1, publishedAt: -1 } },
    { name: 'articles_embedding_status', key: { embeddingStatus: 1, embeddingModel: 1, embeddingVersion: 1 } },
    { name: 'articles_search_text', key: { titleOriginal: 'text', titleVi: 'text', summaryVi: 'text', topics: 'text', searchTextNormalized: 'text' }, options: { default_language: 'none' } },
  ]),
})

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.length > 0 } catch { return false }
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function validMedia(value) {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object' || !['image', 'video'].includes(value.type) || !['remote-preview', 'link-only'].includes(value.displayMode) || value.type === 'image' && value.displayMode !== 'remote-preview' || value.type === 'video' && value.displayMode !== 'link-only') return false
  if (!validUrl(value.url) || !validUrl(value.sourcePageUrl) || typeof value.attribution !== 'string' || !value.attribution.trim() || value.mediaEvidenceStatus !== 'not-analyzed' || !Number.isInteger(value.sourcePolicyVersion) || value.sourcePolicyVersion < 1) return false
  if (value.altText !== null && value.altText !== undefined && typeof value.altText !== 'string') return false
  if (value.credit !== null && value.credit !== undefined && typeof value.credit !== 'string') return false
  return true
}

export function validateArticleDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  if (!(document._id instanceof ObjectId)) errors.push('_id must be an ObjectId')
  if (!(document.sourceId instanceof ObjectId)) errors.push('sourceId must be an ObjectId')
  if (!['rss', 'arxiv', 'hacker-news'].includes(document.connectorType)) errors.push('connectorType is invalid')
  if (!['primary', 'editorial', 'community-signal'].includes(document.authorityTier)) errors.push('authorityTier is invalid')
  if (!['processing', 'review-needed', 'published', 'hidden', 'removed'].includes(document.status)) errors.push('status is invalid')
  if (typeof document.evidenceEligible !== 'boolean') errors.push('evidenceEligible is invalid')
  if (document.externalId !== undefined && (typeof document.externalId !== 'string' || !document.externalId.trim() || document.externalId.length > 500)) errors.push('externalId is invalid')
  for (const field of ['titleOriginal', 'sourceType', 'sourceLanguage', 'searchTextNormalized', 'dedupeKey']) if (typeof document[field] !== 'string' || !document[field].trim()) errors.push(`${field} is required`)
  for (const field of ['originalUrl', 'canonicalUrl']) if (!validUrl(document[field])) errors.push(`${field} is invalid`)
  if (typeof document.canonicalUrlHash !== 'string' || !/^[a-f0-9]{64}$/.test(document.canonicalUrlHash)) errors.push('canonicalUrlHash is invalid')
  else if (document.canonicalUrlHash !== canonicalUrlHash(document.canonicalUrl)) errors.push('canonicalUrlHash does not match canonicalUrl')
  for (const field of ['publishedAt', 'retrievedAt', 'createdAt', 'updatedAt']) if (!validDate(document[field])) errors.push(`${field} is invalid`)
  if (!Array.isArray(document.topics) || document.topics.length > 50 || new Set(document.topics).size !== document.topics.length || document.topics.some((topic) => typeof topic !== 'string' || !topic.trim() || topic.length > 100)) errors.push('topics are invalid')
  if (!Array.isArray(document.provenance) || document.provenance.length === 0 || document.provenance.length > 20 || document.provenance.some((entry) => !entry || !(entry.sourceId instanceof ObjectId) || !validUrl(entry.originalUrl) || !validDate(entry.observedAt) || entry.externalId !== undefined && typeof entry.externalId !== 'string')) errors.push('provenance is invalid')
  if (document.status === 'published' && document.provenance?.length < 1) errors.push('published article needs provenance')
  if (!['metadata', 'excerpt', 'fulltext-temporary'].includes(document.contentScope)) errors.push('contentScope is invalid')
  if (!document.rightsSnapshot || !Number.isInteger(document.rightsSnapshot.sourcePolicyVersion) || !['permitted', 'metadata-only', 'review-needed', 'blocked'].includes(document.rightsSnapshot.licenseStatus) || !['metadata', 'excerpt', 'fulltext-temporary', 'none'].includes(document.rightsSnapshot.llmInputScope) || !validDate(document.rightsSnapshot.capturedAt)) errors.push('rightsSnapshot is invalid')
  if (!['none', 'available', 'hidden'].includes(document.leadMediaStatus) || !validMedia(document.leadMedia)) errors.push('leadMedia is invalid')
  if (document.leadMediaStatus === 'available' && !document.leadMedia) errors.push('available media needs leadMedia')
  if (document.leadMediaStatus === 'none' && document.leadMedia) errors.push('leadMedia status is inconsistent')
  if (!['pending', 'processing', 'ready', 'failed', 'removed'].includes(document.summaryStatus)) errors.push('summaryStatus is invalid')
  if (document.summaryStatus === 'ready' && (!document.summaryVi || !document.summaryBasis || !document.summaryModel || !document.summaryInputHash || !validDate(document.summaryGeneratedAt) || !Number.isInteger(document.summarySourcePolicyVersion))) errors.push('ready summary is incomplete')
  if (document.summaryStatus === 'removed' && (document.summaryVi || document.summaryBasis || document.summaryModel || document.summaryInputHash || document.summaryGeneratedAt || document.summaryError)) errors.push('removed summary must be cleared')
  if (!['pending', 'processing', 'ready', 'failed', 'removed'].includes(document.embeddingStatus)) errors.push('embeddingStatus is invalid')
  if (document.embeddingStatus === 'ready' && (!Array.isArray(document.embedding) || !Number.isInteger(document.embeddingDimensions) || document.embedding.length !== document.embeddingDimensions || !document.embeddingModel || !document.embeddingInputHash || !Number.isInteger(document.embeddingVersion) || !Number.isInteger(document.embeddingSourcePolicyVersion) || !validDate(document.embeddedAt))) errors.push('ready embedding is incomplete')
  if (document.embeddingStatus === 'removed' && (document.embedding || document.embeddingModel || document.embeddingDimensions || document.embeddingInputHash || document.embeddingVersion || document.embeddingSourcePolicyVersion || document.embeddedAt || document.embeddingError)) errors.push('removed embedding must be cleared')
  for (const forbidden of ['raw', 'rawHtml', 'html', 'body', 'content', 'fullText', 'translatedFullText', 'mediaBinary', 'binary', 'imageBinary', 'videoBinary', 'audioBinary', 'base64', 'gridFsId', 'providerPayload']) if (Object.prototype.hasOwnProperty.call(document, forbidden)) errors.push(`${forbidden} is forbidden`)
  return { valid: errors.length === 0, errors }
}

export function buildArticlesMigration({ dryRun = false, existingCollections = [], existingIndexes = {} } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(ARTICLE_COLLECTIONS)) {
    if (!existingCollections.includes(name)) operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of ARTICLE_INDEXES[name]) if (!existingIndexes[name]?.includes(index.name)) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

async function assertPredecessor(db) {
  const audit = (await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
  if (stableJson(audit?.options?.validator) !== stableJson(DURABLE_JOB_AUDIT_VALIDATOR)) throw new Error('durable-jobs migration must be applied before articles')
}

export async function runArticlesMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildArticlesMigration({ dryRun })
  if (dryRun) return plan
  await assertPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try { await db.createCollection(operation.collection, operation.options) } catch (error) { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error }
    } else if (operation.type === 'collMod') await db.command({ collMod: operation.collection, ...operation.options })
    else await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
  }
  return plan
}
