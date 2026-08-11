import { DURABLE_JOB_AUDIT_VALIDATOR } from './durable-jobs.js'
import { ARTICLE_COLLECTIONS } from './articles.js'

const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })
const safeError = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['code', 'message', 'retryable', 'occurredAt'],
  properties: {
    code: { bsonType: 'string', minLength: 1, maxLength: 128 }, message: { bsonType: 'string', minLength: 1, maxLength: 500 },
    retryable: { bsonType: 'bool' }, occurredAt: date, upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 },
  },
})

const indexingJobSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'idempotencyKey', 'actorScope', 'requestHash', 'articleId', 'sourceId', 'expectedSourcePolicyVersion', 'task', 'trigger', 'status', 'attempt', 'priority', 'availableAt', 'agingEligibleAt', 'idempotencyExpiresAt', 'leaseGeneration', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    idempotencyKey: { bsonType: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    actorScope: { bsonType: 'string', minLength: 1, maxLength: 512 }, requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    articleId: objectId, sourceId: objectId, expectedSourcePolicyVersion: { bsonType: 'int', minimum: 1 },
    task: { enum: ['summary', 'embedding', 'visibility-reconcile'] }, trigger: { enum: ['ingestion', 'admin', 'policy-change', 'model-change', 'retry'] },
    requestedBy: objectId, parentJobId: objectId,
    status: { enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] }, attempt: { bsonType: 'int', minimum: 1, maximum: 10 },
    priority: { bsonType: 'int', minimum: -100, maximum: 100 }, availableAt: date, agingEligibleAt: date, idempotencyExpiresAt: date,
    leaseGeneration: { bsonType: ['int', 'long'], minimum: 0 }, targetEmbeddingVersion: { bsonType: 'int', minimum: 1 },
    inputHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, cancellationRequestedAt: date, error: safeError,
    createdAt: date, startedAt: date, heartbeatAt: date, finishedAt: date, purgeAfter: date, updatedAt: date,
  },
})

const TERMINAL = Object.freeze(['succeeded', 'partial', 'failed', 'cancelled'])
const indexingJobValidator = Object.freeze({ $and: [
  { $jsonSchema: indexingJobSchema },
  { $expr: { $gte: ['$idempotencyExpiresAt', { $dateAdd: { startDate: '$createdAt', unit: 'day', amount: 14 } }] } },
  { $expr: { $eq: ['$agingEligibleAt', { $dateAdd: { startDate: '$createdAt', unit: 'minute', amount: 30 } }] } },
  { $or: [{ status: { $nin: TERMINAL } }, { $and: [
    { purgeAfter: { $type: 'date' } },
    { $expr: { $gte: [
      '$purgeAfter',
      { $dateAdd: { startDate: '$finishedAt', unit: 'day', amount: { $cond: [{ $in: ['$status', ['failed', 'partial']] }, 30, 14] } } },
    ] } },
  ] }] },
] })

const reservation = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['reservationId', 'routeId', 'attemptId', 'kind', 'expiresAt'],
  properties: {
    reservationId: { bsonType: 'string', minLength: 8, maxLength: 128 }, routeId: { bsonType: 'string', minLength: 1, maxLength: 64 }, attemptId: objectId,
    kind: { enum: ['summary', 'embedding', 'answer-primary', 'answer-fallback', 'answer-support'] }, expiresAt: date,
  },
})
const routeCircuit = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['routeId', 'state', 'consecutiveRetryableFailures'],
  properties: {
    routeId: { bsonType: 'string', minLength: 1, maxLength: 64 }, state: { enum: ['closed', 'open', 'half-open'] },
    consecutiveRetryableFailures: { bsonType: 'int', minimum: 0, maximum: 3 }, cooldownUntil: date,
    halfOpenProbeReservationId: { bsonType: 'string', minLength: 8, maxLength: 128 },
  },
})
const providerAdmissionStateValidator = Object.freeze({ $and: [
  { $jsonSchema: {
    bsonType: 'object', additionalProperties: false,
    required: ['_id', 'admissionDomainId', 'provider', 'activeReservations', 'maxConcurrency', 'budgetWindowStart', 'spentUnits', 'budgetLimit', 'routeCircuits', 'updatedAt'],
    properties: {
      _id: objectId, admissionDomainId: { bsonType: 'string', minLength: 1, maxLength: 64 }, provider: { bsonType: 'string', minLength: 1, maxLength: 64 },
      activeReservations: { bsonType: 'array', maxItems: 8, items: reservation }, maxConcurrency: { bsonType: 'int', minimum: 1, maximum: 8 },
      budgetWindowStart: date, spentUnits: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 }, budgetLimit: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 },
      routeCircuits: { bsonType: 'array', maxItems: 32, items: routeCircuit }, updatedAt: date,
    },
  } },
  { $expr: { $lte: [{ $size: '$activeReservations' }, '$maxConcurrency'] } },
] })

const noStateTransition = Object.freeze({ stateTransition: { $exists: false } })
const indexingAuditRules = Object.freeze([
  { action: 'indexing_job_created', targetType: 'indexing-job', reasonCode: 'artifact_regeneration_requested', changedFields: ['status'], ...noStateTransition },
  { action: 'indexing_job_retry_created', targetType: 'indexing-job', reasonCode: 'job_retry_requested', changedFields: ['status', 'attempt', 'parentJobId'], ...noStateTransition },
  { action: 'indexing_job_cancelled', targetType: 'indexing-job', reasonCode: 'job_cancel_requested', changedFields: ['status'], ...noStateTransition },
  { action: 'indexing_job_cancellation_requested', targetType: 'indexing-job', reasonCode: 'job_cancel_requested', changedFields: ['cancellationRequestedAt'], ...noStateTransition },
  { action: 'indexing_job_lease_recovered', actorType: 'system-worker', targetType: 'indexing-job', reasonCode: 'lease_expired_recovered', changedFields: ['status', 'error'], ...noStateTransition },
])

export const INDEXING_JOB_AUDIT_VALIDATOR = Object.freeze({ $and: [
  { $or: [...DURABLE_JOB_AUDIT_VALIDATOR.$and[0].$or, ...indexingAuditRules] },
  DURABLE_JOB_AUDIT_VALIDATOR.$and[1],
] })

export const INDEXING_JOB_COLLECTIONS = Object.freeze({
  indexingJobs: Object.freeze({ validator: indexingJobValidator }),
  providerAdmissionStates: Object.freeze({ validator: providerAdmissionStateValidator }),
})

export const INDEXING_JOB_INDEXES = Object.freeze({
  indexingJobs: Object.freeze([
    { name: 'indexing_actor_idempotency_unique', key: { actorScope: 1, idempotencyKey: 1 }, options: { unique: true } },
    { name: 'indexing_parent_attempt_unique', key: { parentJobId: 1, attempt: 1 }, options: { unique: true, partialFilterExpression: { parentJobId: { $type: 'objectId' } } } },
    { name: 'indexing_article_created', key: { articleId: 1, createdAt: -1 } },
    { name: 'indexing_source_status_available', key: { sourceId: 1, status: 1, availableAt: 1 } },
    { name: 'indexing_due_normal', key: { status: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 } },
    { name: 'indexing_due_aged', key: { status: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 } },
    { name: 'indexing_next_available', key: { status: 1, availableAt: 1, _id: 1 } },
    { name: 'indexing_purge_deadline', key: { purgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { purgeAfter: { $type: 'date' } } } },
  ]),
  providerAdmissionStates: Object.freeze([
    { name: 'provider_admission_domain_unique', key: { admissionDomainId: 1 }, options: { unique: true } },
    { name: 'provider_route_circuit', key: { 'routeCircuits.routeId': 1, _id: 1 } },
  ]),
})

export const INDEXING_ARTICLE_INDEXES = Object.freeze([
  { name: 'articles_source_reconciliation', key: { sourceId: 1, _id: 1 } },
])

export function buildIndexingJobsMigration({ dryRun = false } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(INDEXING_JOB_COLLECTIONS)) {
    operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of INDEXING_JOB_INDEXES[name]) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  operations.push({ type: 'collMod', collection: 'adminAuditLogs', options: { validator: INDEXING_JOB_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } })
  for (const index of INDEXING_ARTICLE_INDEXES) operations.push({ type: 'createIndex', collection: 'articles', ...index })
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function assertPredecessor(db) {
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  if (stableJson(byName.get('articles')?.options?.validator) !== stableJson(ARTICLE_COLLECTIONS.articles.validator)) throw new Error('articles migration must be applied before indexing-jobs')
  if (![DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR].some((validator) => stableJson(byName.get('adminAuditLogs')?.options?.validator) === stableJson(validator))) throw new Error('durable-jobs audit revision must precede indexing-jobs')
}

export async function runIndexingJobsMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildIndexingJobsMigration({ dryRun })
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
