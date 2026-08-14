import { ObjectId } from 'mongodb'
import { GOVERNANCE_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_INDEXES } from './governance-audit.js'

const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })
const sha256 = Object.freeze({ bsonType: 'string', pattern: '^[a-f0-9]{64}$' })
const takedownStatuses = Object.freeze(['received', 'reviewing', 'approved', 'rejected', 'completed'])
const takedownScopes = Object.freeze(['metadata', 'media-metadata', 'summary', 'embedding'])

const completion = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['hidden', 'metadataRemoved', 'mediaMetadataRemoved', 'summaryRemoved', 'embeddingRemoved', 'historicalChatCitationsRedacted'],
  properties: Object.fromEntries(['hidden', 'metadataRemoved', 'mediaMetadataRemoved', 'summaryRemoved', 'embeddingRemoved', 'historicalChatCitationsRedacted'].map((field) => [field, { bsonType: 'bool' }])),
})

const safeError = Object.freeze({
  bsonType: ['object', 'null'],
  additionalProperties: false,
  required: ['code', 'message', 'retryable', 'occurredAt'],
  properties: { code: { bsonType: 'string', minLength: 1, maxLength: 128 }, message: { bsonType: 'string', minLength: 1, maxLength: 500 }, retryable: { bsonType: 'bool' }, occurredAt: date, upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 } },
})

const takedownBaseSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['_id', 'status', 'requesterName', 'requesterContact', 'targetType', 'targetIds', 'reason', 'requestedScope', 'completion', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId, status: { enum: takedownStatuses },
    requesterName: { bsonType: 'string', minLength: 1, maxLength: 160 }, requesterContact: { bsonType: 'string', minLength: 3, maxLength: 254 },
    targetType: { enum: ['source', 'article'] }, targetIds: { bsonType: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: objectId },
    reason: { bsonType: 'string', minLength: 3, maxLength: 4000 }, evidenceNote: { bsonType: ['string', 'null'], maxLength: 4000 },
    requestedScope: { bsonType: 'array', minItems: 1, uniqueItems: true, items: { enum: takedownScopes } },
    decisionReasonCode: { bsonType: ['string', 'null'], maxLength: 128 }, reviewedBy: { bsonType: ['objectId', 'null'] }, reviewedAt: { bsonType: ['date', 'null'] }, completedAt: { bsonType: ['date', 'null'] },
    piiPurgeAfter: { bsonType: ['date', 'null'] }, workflowPurgeAfter: { bsonType: ['date', 'null'] }, completion,
    createdAt: date, updatedAt: date,
  },
})

// The approved public contract still requires requester/case fields.  The
// 90-day PII-unset persistence shape is intentionally not accepted until the
// owner resolves the DATA-MODEL/OpenAPI 90–180-day retention mismatch.
const takedownSchema = Object.freeze({ $jsonSchema: takedownBaseSchema })

const deletionSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'userId', 'actorScope', 'idempotencyKey', 'requestHash', 'status', 'attempt', 'priority', 'availableAt', 'agingEligibleAt', 'idempotencyExpiresAt', 'leaseGeneration', 'safeReasonCategory', 'completion', 'requestedAt', 'updatedAt'],
  properties: {
    _id: objectId, userId: objectId, actorScope: { bsonType: 'string', minLength: 1, maxLength: 128 }, idempotencyKey: { bsonType: 'string', minLength: 8, maxLength: 128 }, requestHash: sha256,
    status: { enum: ['queued', 'running', 'completed', 'failed'] }, attempt: { bsonType: 'int', minimum: 1, maximum: 100 }, priority: { bsonType: 'int', minimum: 0, maximum: 100 }, availableAt: date, agingEligibleAt: date, idempotencyExpiresAt: date, leaseGeneration: { bsonType: 'int', minimum: 0 }, leaseOwner: { bsonType: ['string', 'null'], pattern: '^[a-f0-9]{64}$' }, leaseExpiresAt: { bsonType: ['date', 'null'] }, safeReasonCategory: { enum: ['user-request'] }, completion: { bsonType: 'object', additionalProperties: false, required: ['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'], properties: Object.fromEntries(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'].map((field) => [field, { bsonType: 'bool' }])) },
    error: safeError, requestedAt: date, startedAt: { bsonType: ['date', 'null'] }, completedAt: { bsonType: ['date', 'null'] }, purgeAfter: { bsonType: ['date', 'null'] }, updatedAt: date,
  },
})

const suppressionSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['_id', 'eventId', 'kind', 'requestId', 'effectiveAt', 'payloadDigest', 'signatureKeyVersion', 'signature', 'createdAt'],
  properties: { _id: objectId, eventId: { bsonType: 'string', minLength: 8, maxLength: 128 }, kind: { enum: ['account-deletion', 'takedown'] }, requestId: objectId, userId: objectId, targetType: { enum: ['source', 'article'] }, targetIds: { bsonType: 'array', minItems: 1, uniqueItems: true, items: objectId }, requestedScope: { bsonType: 'array', minItems: 1, uniqueItems: true, items: { bsonType: 'string', maxLength: 64 } }, effectiveAt: date, payloadDigest: sha256, signatureKeyVersion: { bsonType: 'int', minimum: 1 }, signature: { bsonType: 'string', minLength: 1, maxLength: 512 }, createdAt: date },
})

const checkpointSchema = Object.freeze({ bsonType: 'object', additionalProperties: false, required: ['_id', 'sequence', 'coveredThroughEventId', 'auditDigest', 'suppressionDigest', 'signerKeyId', 'signature', 'createdAt'], properties: { _id: objectId, sequence: { bsonType: 'long', minimum: 0 }, previousCheckpointDigest: sha256, coveredThroughEventId: { bsonType: 'string', minLength: 1, maxLength: 128 }, auditDigest: sha256, suppressionDigest: sha256, signerKeyId: { bsonType: 'string', minLength: 1, maxLength: 64 }, signature: { bsonType: 'string', minLength: 1, maxLength: 512 }, createdAt: date } })
const manifestSchema = Object.freeze({ bsonType: 'object', additionalProperties: false, required: ['_id', 'manifestId', 'cutoff', 'eventIds', 'eventIdsDigest', 'previousCheckpointDigest', 'resultingCheckpointDigest', 'signerKeyId', 'signature', 'createdAt'], properties: { _id: objectId, manifestId: { bsonType: 'string', minLength: 1, maxLength: 128 }, cutoff: date, eventIds: { bsonType: 'array', uniqueItems: true, items: { bsonType: 'string', minLength: 1, maxLength: 128 } }, eventIdsDigest: sha256, previousCheckpointDigest: sha256, resultingCheckpointDigest: sha256, signerKeyId: { bsonType: 'string', minLength: 1, maxLength: 64 }, signature: { bsonType: 'string', minLength: 1, maxLength: 512 }, createdAt: date } })

export const GOVERNANCE_COLLECTIONS = Object.freeze({
  takedownRequests: Object.freeze({ validator: takedownSchema }),
  accountDeletionRequests: Object.freeze({ validator: { $jsonSchema: deletionSchema } }),
})

export const GOVERNANCE_INDEXES = Object.freeze({
  takedownRequests: Object.freeze([
    { name: 'takedown_status_created', key: { status: 1, createdAt: 1 } }, { name: 'takedown_target_lookup', key: { targetType: 1, targetIds: 1 } },
    { name: 'takedown_pii_deadline', key: { piiPurgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { piiPurgeAfter: { $type: 'date' } } } },
    { name: 'takedown_workflow_deadline', key: { workflowPurgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { workflowPurgeAfter: { $type: 'date' } } } },
  ]),
  accountDeletionRequests: Object.freeze([
    { name: 'account_deletion_user_unique', key: { userId: 1 }, options: { unique: true } }, { name: 'account_deletion_actor_key_unique', key: { actorScope: 1, idempotencyKey: 1 }, options: { unique: true } },
    { name: 'account_deletion_aged', key: { status: 1, agingEligibleAt: 1, availableAt: 1, requestedAt: 1, _id: 1 } }, { name: 'account_deletion_normal', key: { status: 1, priority: -1, availableAt: 1, requestedAt: 1, _id: 1 } },
    { name: 'account_deletion_purge_deadline', key: { purgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { purgeAfter: { $type: 'date' } } } },
  ]),
})

export const GOVERNANCE_DATABASE_COLLECTIONS = Object.freeze({
  governanceSuppressions: Object.freeze({ validator: { $jsonSchema: suppressionSchema } }), governanceCheckpoints: Object.freeze({ validator: { $jsonSchema: checkpointSchema } }), auditRetentionManifests: Object.freeze({ validator: { $jsonSchema: manifestSchema } }),
})
export const GOVERNANCE_DATABASE_INDEXES = Object.freeze({ governanceSuppressions: [{ name: 'governance_suppression_event_unique', key: { eventId: 1 }, options: { unique: true } }, { name: 'governance_suppression_request', key: { kind: 1, requestId: 1 } }], governanceCheckpoints: [{ name: 'governance_checkpoint_sequence_unique', key: { sequence: 1 }, options: { unique: true } }, { name: 'governance_checkpoint_event', key: { coveredThroughEventId: 1 } }], auditRetentionManifests: [{ name: 'audit_manifest_unique', key: { manifestId: 1 }, options: { unique: true } }, { name: 'audit_manifest_cutoff', key: { cutoff: 1, _id: 1 } }] })

function operations(collections, indexes, dryRun) {
  const result = []
  for (const [name, definition] of Object.entries(collections)) {
    result.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    result.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of indexes[name]) result.push({ type: 'createIndex', collection: name, ...index })
  }
  return dryRun ? result.map((operation) => ({ ...operation, dryRun: true })) : result
}

export function buildGovernanceMigration({ dryRun = false } = {}) {
  const plan = operations(GOVERNANCE_COLLECTIONS, GOVERNANCE_INDEXES, false)
  plan.push({ type: 'collMod', collection: 'adminAuditLogs', options: { validator: GOVERNANCE_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } })
  for (const index of GOVERNANCE_AUDIT_INDEXES) plan.push({ type: 'createIndex', collection: 'adminAuditLogs', ...index })
  return dryRun ? plan.map((operation) => ({ ...operation, dryRun: true })) : plan
}
export function buildGovernanceDatabaseMigration({ dryRun = false } = {}) { return operations(GOVERNANCE_DATABASE_COLLECTIONS, GOVERNANCE_DATABASE_INDEXES, dryRun) }

async function runOperations(db, plan) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try { await db.createCollection(operation.collection, operation.options) } catch (error) { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error }
    } else if (operation.type === 'collMod') await db.command({ collMod: operation.collection, ...operation.options })
    else await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
  }
  return plan
}

export async function runGovernanceMigration({ db, dryRun = false } = {}) { const plan = buildGovernanceMigration({ dryRun }); return dryRun ? plan : runOperations(db, plan) }
export async function runGovernanceDatabaseMigration({ db, dryRun = false } = {}) { const plan = buildGovernanceDatabaseMigration({ dryRun }); return dryRun ? plan : runOperations(db, plan) }

function validDate(value) { return value instanceof Date && !Number.isNaN(value.getTime()) }
function validate(document, kind) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  for (const field of ['_id']) if (!(document[field] instanceof ObjectId)) errors.push(`${field} must be an ObjectId`)
  if (kind === 'takedown') {
    if (!takedownStatuses.includes(document.status)) errors.push('status is invalid')
    for (const field of ['requesterName', 'requesterContact', 'reason']) if (typeof document[field] !== 'string' || document[field].length < 1) errors.push(`${field} is invalid`)
    if (document.evidenceNote !== undefined && document.evidenceNote !== null && typeof document.evidenceNote !== 'string') errors.push('evidenceNote is invalid')
    if (!['source', 'article'].includes(document.targetType) || !Array.isArray(document.targetIds) || document.targetIds.length < 1 || document.targetIds.some((id) => !(id instanceof ObjectId))) errors.push('target is invalid')
    if (!Array.isArray(document.requestedScope) || document.requestedScope.length < 1 || document.requestedScope.some((scope) => !takedownScopes.includes(scope)) || new Set(document.requestedScope).size !== document.requestedScope.length) errors.push('requestedScope is invalid')
    if (!document.completion || Object.keys(completion.properties).some((field) => typeof document.completion[field] !== 'boolean')) errors.push('completion is invalid')
    if (document.status === 'completed' && (!document.completion.hidden || !document.completion.historicalChatCitationsRedacted || document.requestedScope.some((scope) => !document.completion[{ metadata: 'metadataRemoved', 'media-metadata': 'mediaMetadataRemoved', summary: 'summaryRemoved', embedding: 'embeddingRemoved' }[scope]]))) errors.push('completed takedown is incomplete')
  } else {
    for (const field of ['userId']) if (!(document[field] instanceof ObjectId)) errors.push(`${field} must be an ObjectId`)
    if (!['queued', 'running', 'completed', 'failed'].includes(document.status)) errors.push('status is invalid')
    if (document.safeReasonCategory !== 'user-request') errors.push('safeReasonCategory is invalid')
    const fields = ['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized']
    if (!document.completion || fields.some((field) => typeof document.completion[field] !== 'boolean')) errors.push('completion is invalid')
    if (document.status === 'completed' && (fields.some((field) => !document.completion[field]) || document.error !== null)) errors.push('completed deletion is incomplete')
  }
  for (const field of kind === 'takedown' ? ['createdAt', 'updatedAt'] : ['requestedAt', 'availableAt', 'agingEligibleAt', 'idempotencyExpiresAt', 'updatedAt']) if (!validDate(document[field])) errors.push(`${field} is invalid`)
  return { valid: errors.length === 0, errors }
}

export function validateTakedownRequestDocument(document) { return validate(document, 'takedown') }
export function validateAccountDeletionRequestDocument(document) { return validate(document, 'deletion') }
