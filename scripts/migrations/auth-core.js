import { ObjectId } from 'mongodb'

const USER_TOMBSTONE_FIELDS = new Set([
  '_id', 'status', 'deletionRequestedAt', 'deletionRequestId', 'deletedAt', 'sessionVersion', 'createdAt', 'updatedAt',
])

const isoDate = { bsonType: 'date' }
const idSchema = { bsonType: 'objectId' }
const auditIdSchema = { bsonType: ['objectId', 'string'], minLength: 1, maxLength: 128 }
const hmacFingerprintSchema = { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }

function hmacLifecycleVersionSchema(state) {
  const properties = {
    version: { bsonType: 'int', minimum: 1 },
    state: { enum: [state] },
    keyFingerprint: hmacFingerprintSchema,
    firstObservedAt: isoDate,
  }
  const required = ['version', 'state', 'keyFingerprint', 'firstObservedAt']
  if (state !== 'current') {
    properties.successorVersion = { bsonType: 'int', minimum: 1 }
    properties.successorActivatedAt = isoDate
    required.push('successorVersion', 'successorActivatedAt')
  }
  if (state === 'retired') {
    properties.retiredAt = isoDate
    properties.dependentEvidence = {
      bsonType: 'object',
      additionalProperties: false,
      required: ['rateLimitBuckets', 'sessions', 'adminAuditLogs'],
      properties: {
        rateLimitBuckets: { bsonType: 'int', minimum: 0, maximum: 0 },
        sessions: { bsonType: 'int', minimum: 0, maximum: 0 },
        adminAuditLogs: { bsonType: 'int', minimum: 0, maximum: 0 },
      },
    }
    required.push('retiredAt', 'dependentEvidence')
  }
  return { bsonType: 'object', additionalProperties: false, required, properties }
}

export const AUTH_CORE_COLLECTIONS = Object.freeze({
  users: Object.freeze({
    validator: { $or: [
      { $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['_id', 'emailNormalized', 'emailDisplay', 'passwordHash', 'role', 'status', 'topicPreferences', 'sessionVersion', 'createdAt', 'updatedAt'],
        properties: {
          _id: idSchema,
          emailNormalized: { bsonType: 'string', minLength: 3, maxLength: 254 },
          emailDisplay: { bsonType: 'string', maxLength: 254 },
          passwordHash: { bsonType: 'string', pattern: '^scrypt\\$[0-9]+\\$[0-9]+\\$[0-9]+\\$[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$', minLength: 20, maxLength: 512 },
          role: { enum: ['user', 'admin'] },
          status: { enum: ['active', 'suspended', 'deletion-pending'] },
          topicPreferences: { bsonType: 'array', uniqueItems: true, maxItems: 20, items: { bsonType: 'string', minLength: 1, maxLength: 64 } },
          sessionVersion: { bsonType: 'int', minimum: 0 },
          createdAt: isoDate,
          updatedAt: isoDate,
          deletionRequestedAt: isoDate,
          deletionRequestId: idSchema,
          deletedAt: isoDate,
          suspendedAt: isoDate,
          suspensionReason: { bsonType: 'string', maxLength: 128 },
        },
      } },
      { $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: ['_id', 'status', 'deletionRequestedAt', 'deletionRequestId', 'deletedAt', 'sessionVersion', 'createdAt', 'updatedAt'],
        properties: {
          _id: idSchema,
          status: { enum: ['deleted'] },
          deletionRequestedAt: isoDate,
          deletionRequestId: idSchema,
          deletedAt: isoDate,
          sessionVersion: { bsonType: 'int', minimum: 0 },
          createdAt: isoDate,
          updatedAt: isoDate,
        },
      } },
    ] },
  }),
  sessions: Object.freeze({
    validator: { $jsonSchema: {
      additionalProperties: false,
      bsonType: 'object', required: ['_id', 'tokenHash', 'userId', 'userSessionVersion', 'csrfSecretHash', 'status', 'absoluteExpiresAt', 'expiresAt', 'lastSeenAt', 'createdAt'],
      properties: {
        _id: idSchema, tokenHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, userId: idSchema,
        userSessionVersion: { bsonType: 'int', minimum: 0 }, csrfSecretHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        status: { enum: ['active', 'revoked'] }, absoluteExpiresAt: isoDate, expiresAt: isoDate, lastSeenAt: isoDate, createdAt: isoDate,
        revokedAt: isoDate, createdIpHmac: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, ipHmacKeyVersion: { bsonType: 'int', minimum: 1 }, userAgentSummary: { bsonType: 'string', maxLength: 256 },
      },
    } },
  }),
  rateLimitBuckets: Object.freeze({
    validator: { $and: [
      { $or: [
        { scope: 'login', subjectType: 'ip', limit: 10 },
        { scope: 'register', subjectType: 'ip', limit: 5 },
        { scope: 'answer-minute', subjectType: 'user', limit: 10 },
        { scope: 'answer-daily', subjectType: 'user', limit: 100 },
        { scope: 'admin-trigger', subjectType: 'admin', limit: 20 },
        { scope: 'source-test', subjectType: 'source', limit: 10 },
      ] },
      { $jsonSchema: {
        additionalProperties: false,
        bsonType: 'object', required: ['_id', 'scope', 'subjectType', 'keyHash', 'keyVersion', 'keyFingerprint', 'windowStart', 'count', 'limit', 'expiresAt', 'updatedAt'],
        properties: {
          _id: idSchema, scope: { enum: ['login', 'register', 'answer-minute', 'answer-daily', 'admin-trigger', 'source-test'] },
          subjectType: { enum: ['user', 'ip', 'admin', 'source'] }, keyHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, keyVersion: { bsonType: 'int', minimum: 1 }, keyFingerprint: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
          windowStart: isoDate, count: { bsonType: 'int', minimum: 0 }, limit: { bsonType: 'int', minimum: 1 }, expiresAt: isoDate, updatedAt: isoDate,
        },
      } },
    ] },
  }),
  savedArticles: Object.freeze({
    validator: { $jsonSchema: {
      additionalProperties: false,
      bsonType: 'object', required: ['_id', 'userId', 'articleId', 'createdAt'],
      properties: { _id: idSchema, userId: idSchema, articleId: idSchema, createdAt: isoDate },
    } },
  }),
  adminAuditLogs: Object.freeze({
    validator: { $and: [
      { $or: [
        { action: 'user_registered', reasonCode: 'user_registered', changedFields: ['status'], stateTransition: { $exists: false } },
        { action: 'user_logged_in', reasonCode: 'user_login', changedFields: [], stateTransition: { $exists: false } },
        { action: 'user_logged_out', reasonCode: 'user_logout', changedFields: [], stateTransition: { $exists: false } },
        { action: 'user_preferences_updated', reasonCode: 'preferences_updated', changedFields: ['topicPreferences'], stateTransition: { $exists: false } },
        { action: 'user_suspended', reasonCode: 'user_suspended', changedFields: ['status', 'sessionVersion'], 'stateTransition.from': 'active', 'stateTransition.to': 'suspended' },
        { action: 'user_restored', reasonCode: 'user_restored', changedFields: ['status', 'sessionVersion'], 'stateTransition.from': 'suspended', 'stateTransition.to': 'active' },
      ] },
      { $jsonSchema: {
        additionalProperties: false,
        bsonType: 'object', required: ['_id', 'eventId', 'actorType', 'actorId', 'action', 'targetType', 'targetId', 'changedFields', 'reasonCode', 'requestId', 'result', 'createdAt'],
        properties: {
          _id: idSchema, eventId: { bsonType: 'string', minLength: 8, maxLength: 128 }, actorType: { enum: ['admin', 'user', 'system-worker'] }, actorId: auditIdSchema,
          action: { bsonType: 'string', minLength: 1, maxLength: 128 }, targetType: { bsonType: 'string', minLength: 1, maxLength: 128 }, targetId: auditIdSchema,
          changedFields: { bsonType: 'array', maxItems: 32, items: { bsonType: 'string', maxLength: 128 } }, reasonCode: { bsonType: 'string', maxLength: 128 },
          stateTransition: { bsonType: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { bsonType: 'string', maxLength: 64 }, to: { bsonType: 'string', maxLength: 64 } } },
          requestId: { bsonType: 'string', minLength: 1, maxLength: 128 }, result: { enum: ['pending', 'succeeded', 'failed'] }, createdAt: isoDate,
          ipAddressHmac: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, ipHmacKeyVersion: { bsonType: 'int', minimum: 1 }, purgeAfter: isoDate, ipHmacPurgeAfter: isoDate,
        },
      } },
    ] },
  }),
  hmacKeyLifecycleSnapshots: Object.freeze({
    validator: { $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'inventoryId', 'revision', 'previousRevision', 'previousSnapshotHash', 'snapshotHash', 'currentVersion', 'versions', 'recordedAt'],
      properties: {
        _id: idSchema,
        inventoryId: { enum: ['quota-hmac'] },
        revision: { bsonType: 'int', minimum: 1 },
        previousRevision: { bsonType: 'int', minimum: 0 },
        previousSnapshotHash: hmacFingerprintSchema,
        snapshotHash: hmacFingerprintSchema,
        currentVersion: { bsonType: 'int', minimum: 1 },
        versions: {
          bsonType: 'array', minItems: 1, maxItems: 64,
          items: { oneOf: [hmacLifecycleVersionSchema('current'), hmacLifecycleVersionSchema('retiring'), hmacLifecycleVersionSchema('retired')] },
        },
        recordedAt: isoDate,
      },
    } },
  }),
})

export const AUTH_CORE_INDEXES = Object.freeze({
  users: [
    { name: 'users_email_unique', key: { emailNormalized: 1 }, options: { unique: true, partialFilterExpression: { emailNormalized: { $type: 'string' } } } },
    { name: 'users_status_created', key: { status: 1, createdAt: -1 } },
  ],
  sessions: [
    { name: 'sessions_token_unique', key: { tokenHash: 1 }, options: { unique: true } },
    { name: 'sessions_user_status', key: { userId: 1, status: 1 } },
    { name: 'sessions_expires_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ],
  rateLimitBuckets: [
    { name: 'rate_limit_unique_window', key: { scope: 1, subjectType: 1, keyHash: 1, windowStart: 1 }, options: { unique: true } },
    { name: 'rate_limit_key_version', key: { keyVersion: 1 } },
    { name: 'rate_limit_expires_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
  ],
  savedArticles: [
    { name: 'saved_articles_user_article_unique', key: { userId: 1, articleId: 1 }, options: { unique: true } },
    { name: 'saved_articles_user_created', key: { userId: 1, createdAt: -1, _id: -1 } },
    { name: 'saved_articles_article_user', key: { articleId: 1, userId: 1 } },
  ],
  adminAuditLogs: [
    { name: 'audit_event_unique', key: { eventId: 1 }, options: { unique: true } },
    { name: 'audit_created', key: { createdAt: -1, _id: -1 } },
    { name: 'audit_actor_created', key: { actorType: 1, actorId: 1, createdAt: -1 } },
    { name: 'audit_target_created', key: { targetType: 1, targetId: 1, createdAt: -1 } },
    { name: 'audit_ip_purge', key: { ipHmacPurgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { ipHmacPurgeAfter: { $exists: true } } } },
    { name: 'audit_purge', key: { purgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { purgeAfter: { $exists: true } } } },
  ],
  hmacKeyLifecycleSnapshots: [
    { name: 'hmac_lifecycle_revision_unique', key: { inventoryId: 1, revision: 1 }, options: { unique: true } },
    { name: 'hmac_lifecycle_latest', key: { inventoryId: 1, revision: -1 } },
  ],
})

export function validateDeletedUserDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  if (document.status !== 'deleted') errors.push('status must be deleted')
  for (const key of Object.keys(document)) if (!USER_TOMBSTONE_FIELDS.has(key)) errors.push(`field ${key} is not allowed on deleted tombstone`)
  for (const key of ['deletionRequestedAt', 'deletedAt', 'createdAt', 'updatedAt']) if (!(document[key] instanceof Date)) errors.push(`${key} must be a Date`)
  if (!(document.deletionRequestId instanceof ObjectId)) errors.push('deletionRequestId must be an ObjectId')
  if (!(document._id instanceof ObjectId)) errors.push('_id must be an ObjectId')
  if (typeof document.sessionVersion !== 'number' || !Number.isInteger(document.sessionVersion) || document.sessionVersion < 0) errors.push('sessionVersion must be a non-negative integer')
  return { valid: errors.length === 0, errors }
}

export function buildAuthCoreMigration({ dryRun = false } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(AUTH_CORE_COLLECTIONS)) {
    operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of AUTH_CORE_INDEXES[name]) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

export async function runAuthCoreMigration({ db, dryRun = false }) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildAuthCoreMigration({ dryRun })
  if (dryRun) return plan
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

export const USER_TOMBSTONE_FIELDS_LIST = Object.freeze([...USER_TOMBSTONE_FIELDS])
