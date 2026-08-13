import { INDEXING_JOB_AUDIT_VALIDATOR } from './indexing-jobs.js'

const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })
const sha256 = Object.freeze({ bsonType: 'string', pattern: '^[a-f0-9]{64}$' })
const refusalReasons = Object.freeze([
  'insufficient-evidence',
  'policy-blocked',
  'sensitive-input',
  'provider-unavailable',
])

const answerScope = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  properties: {
    articleId: objectId,
    topics: { bsonType: 'array', uniqueItems: true, minItems: 1, maxItems: 10, items: { bsonType: 'string', minLength: 1, maxLength: 100 } },
    publishedAfter: date,
    publishedBefore: date,
  },
})

const answerParagraph = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['text', 'citationIds'],
  properties: {
    text: { bsonType: 'string', minLength: 1, maxLength: 2000 },
    citationIds: { bsonType: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { bsonType: 'string', minLength: 1, maxLength: 128 } },
  },
})

const historicalCitation = Object.freeze({
  oneOf: [
    {
      bsonType: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'articleId', 'sourceId', 'originalUrl', 'titleOriginal', 'publishedAt'],
      properties: {
        id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        status: { enum: ['available'] },
        articleId: objectId,
        sourceId: objectId,
        originalUrl: { bsonType: 'string', minLength: 1, maxLength: 2048, pattern: '^https://(?![^/?#]*@)[^\\s]+$' },
        titleOriginal: { bsonType: 'string', minLength: 1, maxLength: 500 },
        publishedAt: date,
      },
    },
    {
      bsonType: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'unavailableReason'],
      properties: {
        id: { bsonType: 'string', minLength: 1, maxLength: 128 },
        status: { enum: ['unavailable'] },
        articleId: objectId,
        sourceId: objectId,
        unavailableReason: { enum: ['takedown', 'source-policy', 'article-removed'] },
      },
    },
  ],
})

const userMessage = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'text', 'createdAt'],
  properties: {
    id: { bsonType: 'string', minLength: 1, maxLength: 128 },
    role: { enum: ['user'] },
    text: { bsonType: 'string', minLength: 1, maxLength: 1000 },
    createdAt: date,
  },
})

const answeredMessage = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'status', 'paragraphs', 'citations', 'refusalReason', 'createdAt'],
  properties: {
    id: { bsonType: 'string', minLength: 1, maxLength: 128 },
    role: { enum: ['assistant'] },
    status: { enum: ['answered'] },
    paragraphs: { bsonType: 'array', minItems: 1, maxItems: 12, items: answerParagraph },
    citations: { bsonType: 'array', minItems: 1, maxItems: 50, items: historicalCitation },
    refusalReason: { bsonType: 'null' },
    createdAt: date,
  },
})

const refusedMessage = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'status', 'paragraphs', 'citations', 'refusalReason', 'createdAt'],
  properties: {
    id: { bsonType: 'string', minLength: 1, maxLength: 128 },
    role: { enum: ['assistant'] },
    status: { enum: ['refused'] },
    paragraphs: { bsonType: 'array', maxItems: 0 },
    citations: { bsonType: 'array', maxItems: 0 },
    refusalReason: { enum: refusalReasons },
    createdAt: date,
  },
})

const message = Object.freeze({ oneOf: [userMessage, answeredMessage, refusedMessage] })

const chatSessionSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['_id', 'userId', 'scope', 'messages', 'messageCount', 'expiresAt', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    userId: objectId,
    title: { bsonType: ['string', 'null'], maxLength: 200 },
    scope: answerScope,
    messages: { bsonType: 'array', maxItems: 30, items: message },
    messageCount: { bsonType: 'int', minimum: 0, maximum: 30 },
    expiresAt: date,
    createdAt: date,
    updatedAt: date,
  },
})

const answerAttemptSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: [
    '_id', 'userId', 'sessionId', 'expectedSessionVersion', 'idempotencyKeyHash', 'requestHash',
    'status', 'quotaReservationKey', 'expiresAt', 'createdAt', 'updatedAt',
  ],
  properties: {
    _id: objectId,
    userId: objectId,
    sessionId: objectId,
    expectedSessionVersion: { bsonType: 'int', minimum: 0 },
    idempotencyKeyHash: sha256,
    requestHash: sha256,
    status: { enum: ['reserved', 'provider-running', 'completed', 'refused', 'failed'] },
    quotaReservationKey: { bsonType: 'string', minLength: 1, maxLength: 256 },
    providerRouteId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    providerReservationExpiresAt: date,
    chatSessionId: objectId,
    messageId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    resultStatus: { enum: ['answered', 'refused'] },
    error: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable', 'occurredAt'],
      properties: {
        code: { bsonType: 'string', minLength: 1, maxLength: 128 },
        message: { bsonType: 'string', minLength: 1, maxLength: 500 },
        retryable: { bsonType: 'bool' },
        occurredAt: date,
        upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 },
      },
    },
    expiresAt: date,
    createdAt: date,
    updatedAt: date,
  },
})

const chatSessionValidator = Object.freeze({
  $and: [
    { $jsonSchema: chatSessionSchema },
    {
      $expr: {
        $and: [
          {
            $eq: [
              { $eq: [{ $type: '$scope.publishedAfter' }, 'date'] },
              { $eq: [{ $type: '$scope.publishedBefore' }, 'date'] },
            ],
          },
          {
            $or: [
              { $ne: [{ $type: '$scope.articleId' }, 'missing'] },
              { $gt: [{ $size: { $ifNull: ['$scope.topics', []] } }, 0] },
              {
                $and: [
                  { $eq: [{ $type: '$scope.publishedAfter' }, 'date'] },
                  { $eq: [{ $type: '$scope.publishedBefore' }, 'date'] },
                  { $lte: ['$scope.publishedAfter', '$scope.publishedBefore'] },
                ],
              },
            ],
          },
          {
            $or: [
              { $ne: [{ $type: '$scope.publishedAfter' }, 'date'] },
              { $lte: ['$scope.publishedAfter', '$scope.publishedBefore'] },
            ],
          },
        ],
      },
    },
    { $expr: { $eq: ['$messageCount', { $size: '$messages' }] } },
    { $expr: { $eq: ['$expiresAt', { $dateAdd: { startDate: '$updatedAt', unit: 'day', amount: 30 } }] } },
  ],
})

const answerAttemptValidator = Object.freeze({
  $and: [
    { $jsonSchema: answerAttemptSchema },
    { $expr: { $eq: ['$expiresAt', { $dateAdd: { startDate: '$createdAt', unit: 'hour', amount: 24 } }] } },
  ],
})

export const CHAT_SESSION_COLLECTIONS = Object.freeze({
  chatSessions: Object.freeze({ validator: chatSessionValidator }),
  answerAttempts: Object.freeze({ validator: answerAttemptValidator }),
})

export const CHAT_SESSION_INDEXES = Object.freeze({
  chatSessions: Object.freeze([
    { name: 'chat_sessions_user_updated', key: { userId: 1, updatedAt: -1, _id: -1 } },
    { name: 'chat_sessions_citation_article', key: { 'messages.citations.articleId': 1, _id: 1 } },
    { name: 'chat_sessions_citation_source', key: { 'messages.citations.sourceId': 1, _id: 1 } },
    { name: 'chat_sessions_expires_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]),
  answerAttempts: Object.freeze([
    { name: 'answer_attempts_identity_unique', key: { userId: 1, sessionId: 1, expectedSessionVersion: 1, idempotencyKeyHash: 1 }, options: { unique: true } },
    { name: 'answer_attempts_user_created', key: { userId: 1, createdAt: -1, _id: -1 } },
    { name: 'answer_attempts_expiry_deadline', key: { expiresAt: 1, _id: 1 } },
    { name: 'answer_attempts_expires_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ]),
})

// Aliases make the migration boundary explicit to callers that refer to the two
// owned collections rather than the combined Step 10 migration.
export const ANSWER_ATTEMPT_COLLECTIONS = CHAT_SESSION_COLLECTIONS
export const ANSWER_ATTEMPT_INDEXES = CHAT_SESSION_INDEXES

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function validSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function validateChatSessionDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  if (!document._id || document._id._bsontype !== 'ObjectId') errors.push('_id must be an ObjectId')
  if (!document.userId || document.userId._bsontype !== 'ObjectId') errors.push('userId must be an ObjectId')
  if (!document.scope || typeof document.scope !== 'object' || Array.isArray(document.scope)) errors.push('scope is invalid')
  else {
    const hasArticle = document.scope.articleId?._bsontype === 'ObjectId'
    const hasTopics = Array.isArray(document.scope.topics) && document.scope.topics.length > 0
    const hasAfter = validDate(document.scope.publishedAfter)
    const hasBefore = validDate(document.scope.publishedBefore)
    if (hasAfter !== hasBefore) errors.push('scope date range must include both boundaries')
    if (hasAfter && hasBefore && document.scope.publishedAfter > document.scope.publishedBefore) errors.push('scope date range is invalid')
    if (!hasArticle && !hasTopics && !(hasAfter && hasBefore)) errors.push('scope must select articleId, topics, or a date range')
  }
  if (!Array.isArray(document.messages) || document.messages.length > 30) errors.push('messages are invalid')
  if (!Number.isInteger(document.messageCount) || document.messageCount < 0 || document.messageCount > 30) errors.push('messageCount is invalid')
  else if (document.messageCount !== document.messages?.length) errors.push('messageCount must equal messages length')
  for (const field of ['expiresAt', 'createdAt', 'updatedAt']) if (!validDate(document[field])) errors.push(`${field} is invalid`)
  if (validDate(document.updatedAt) && validDate(document.expiresAt) && document.expiresAt.getTime() !== document.updatedAt.getTime() + 30 * 24 * 60 * 60 * 1000) errors.push('expiresAt must equal 30 days after updatedAt')
  return { valid: errors.length === 0, errors }
}

export function validateAnswerAttemptDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  for (const field of ['_id', 'userId', 'sessionId']) if (!document[field] || document[field]._bsontype !== 'ObjectId') errors.push(`${field} must be an ObjectId`)
  if (!Number.isInteger(document.expectedSessionVersion) || document.expectedSessionVersion < 0) errors.push('expectedSessionVersion is invalid')
  for (const field of ['idempotencyKeyHash', 'requestHash']) if (!validSha(document[field])) errors.push(`${field} is invalid`)
  if (!['reserved', 'provider-running', 'completed', 'refused', 'failed'].includes(document.status)) errors.push('status is invalid')
  if (typeof document.quotaReservationKey !== 'string' || !document.quotaReservationKey) errors.push('quotaReservationKey is invalid')
  for (const field of ['expiresAt', 'createdAt', 'updatedAt']) if (!validDate(document[field])) errors.push(`${field} is invalid`)
  if (validDate(document.createdAt) && validDate(document.expiresAt) && document.expiresAt.getTime() !== document.createdAt.getTime() + 24 * 60 * 60 * 1000) errors.push('expiresAt must equal 24 hours after createdAt')
  for (const forbidden of ['question', 'rawQuestion', 'evidence', 'prompt', 'modelOutput', 'providerPayload', 'token', 'secret']) if (Object.prototype.hasOwnProperty.call(document, forbidden)) errors.push(`${forbidden} is forbidden`)
  return { valid: errors.length === 0, errors }
}

export function buildChatSessionsMigration({ dryRun = false } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(CHAT_SESSION_COLLECTIONS)) {
    operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of CHAT_SESSION_INDEXES[name]) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

async function assertPredecessor(db) {
  const audit = (await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
  if (stableJson(audit?.options?.validator) !== stableJson(INDEXING_JOB_AUDIT_VALIDATOR)) throw new Error('indexing-jobs migration must be applied before chat-sessions')
}

export async function runChatSessionsMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function' || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  const plan = buildChatSessionsMigration({ dryRun })
  if (dryRun) return plan
  await assertPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try {
        await db.createCollection(operation.collection, operation.options)
      } catch (error) {
        if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error
      }
    } else if (operation.type === 'collMod') {
      await db.command({ collMod: operation.collection, ...operation.options })
    } else {
      await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
    }
  }
  return plan
}
