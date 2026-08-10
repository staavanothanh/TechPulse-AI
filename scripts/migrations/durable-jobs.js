import { SOURCE_AUDIT_VALIDATOR } from './sources.js'

const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })
const safeError = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['code', 'message', 'retryable', 'occurredAt'],
  properties: {
    code: { bsonType: 'string', minLength: 1, maxLength: 128 },
    message: { bsonType: 'string', minLength: 1, maxLength: 500 },
    retryable: { bsonType: 'bool' }, occurredAt: date,
    upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 },
  },
})
const counters = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed'],
  properties: Object.fromEntries(['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed'].map((key) => [key, { bsonType: 'int', minimum: 0 }])),
})
const checkpoint = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['processedCount'],
  properties: {
    cursor: { bsonType: 'string', maxLength: 2000 },
    lastExternalId: { bsonType: 'string', maxLength: 500 },
    processedCount: { bsonType: 'int', minimum: 0 },
  },
})

const ingestionJobSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'idempotencyKey', 'actorScope', 'requestHash', 'sourceId', 'connectorType', 'expectedSourcePolicyVersion', 'trigger', 'status', 'attempt', 'priority', 'availableAt', 'agingEligibleAt', 'idempotencyExpiresAt', 'leaseGeneration', 'batchSize', 'counters', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    idempotencyKey: { bsonType: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    actorScope: { bsonType: 'string', minLength: 1, maxLength: 512 },
    requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    sourceId: objectId,
    connectorType: { enum: ['rss', 'arxiv', 'hacker-news'] },
    expectedSourcePolicyVersion: { bsonType: 'int', minimum: 1 },
    trigger: { enum: ['cron', 'admin', 'retry'] },
    requestedBy: objectId, parentJobId: objectId,
    status: { enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] },
    attempt: { bsonType: 'int', minimum: 1, maximum: 10 },
    priority: { bsonType: 'int', minimum: -100, maximum: 100 },
    availableAt: date, agingEligibleAt: date, idempotencyExpiresAt: date,
    leaseGeneration: { bsonType: ['int', 'long'], minimum: 0 },
    batchSize: { bsonType: 'int', minimum: 1, maximum: 100 },
    checkpoint, counters,
    cancellationRequestedAt: date, error: safeError,
    createdAt: date, startedAt: date, heartbeatAt: date, finishedAt: date, purgeAfter: date, updatedAt: date,
  },
})

const TERMINAL_STATUSES = Object.freeze(['succeeded', 'partial', 'failed', 'cancelled'])
const ingestionJobValidator = Object.freeze({
  $and: [
    { $jsonSchema: ingestionJobSchema },
    { $expr: { $gte: ['$idempotencyExpiresAt', { $dateAdd: { startDate: '$createdAt', unit: 'day', amount: 14 } }] } },
    { $expr: { $eq: ['$agingEligibleAt', { $dateAdd: { startDate: '$createdAt', unit: 'minute', amount: 30 } }] } },
    { $or: [
      { status: { $nin: TERMINAL_STATUSES } },
      { $and: [
        { purgeAfter: { $type: 'date' } },
        { $expr: { $gte: ['$purgeAfter', { $dateAdd: {
          startDate: '$finishedAt', unit: 'day', amount: { $cond: [{ $in: ['$status', ['failed', 'partial']] }, 30, 14] },
        } }] } },
      ] },
    ] },
  ],
})

const ingestionScheduleProgressSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'period', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    period: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    cursorSourceId: objectId,
    completedAt: date,
    createdAt: date,
    updatedAt: date,
  },
})

const activeOwner = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['ownerTokenHash', 'jobId', 'leaseGeneration', 'acquiredAt', 'heartbeatAt', 'expiresAt'],
  properties: {
    ownerTokenHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    jobId: objectId,
    leaseGeneration: { bsonType: ['int', 'long'], minimum: 1 },
    acquiredAt: date, heartbeatAt: date, expiresAt: date,
  },
})

const jobLeaseSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'key', 'generationHighWater', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    key: { bsonType: 'string', minLength: 5, maxLength: 300, pattern: '^(ingestion:source|indexing:article|reconciliation:source|account-deletion:user):[a-z0-9_-]{1,128}$' },
    generationHighWater: { bsonType: ['int', 'long'], minimum: 0 },
    activeOwner,
    lastFenceValidatedAt: date, lastReleasedAt: date, createdAt: date, updatedAt: date,
  },
})

const noStateTransition = Object.freeze({ stateTransition: { $exists: false } })
const jobAuditRules = Object.freeze([
  { action: 'ingestion_job_created', targetType: 'ingestion-job', reasonCode: 'ingestion_trigger_requested', changedFields: ['status'], ...noStateTransition },
  { action: 'ingestion_job_retry_created', targetType: 'ingestion-job', reasonCode: 'job_retry_requested', changedFields: ['status', 'attempt', 'parentJobId'], ...noStateTransition },
  { action: 'ingestion_job_cancelled', targetType: 'ingestion-job', reasonCode: 'job_cancel_requested', changedFields: ['status'], ...noStateTransition },
  { action: 'ingestion_job_cancellation_requested', targetType: 'ingestion-job', reasonCode: 'job_cancel_requested', changedFields: ['cancellationRequestedAt'], ...noStateTransition },
  { action: 'ingestion_job_lease_recovered', actorType: 'system-worker', targetType: 'ingestion-job', reasonCode: 'lease_expired_recovered', changedFields: ['status', 'error'], ...noStateTransition },
])

const sourceAuditParts = SOURCE_AUDIT_VALIDATOR.$and
export const DURABLE_JOB_AUDIT_VALIDATOR = Object.freeze({
  $and: [
    { $or: [...sourceAuditParts[0].$or, ...jobAuditRules] },
    sourceAuditParts[1],
  ],
})

export const DURABLE_JOB_COLLECTIONS = Object.freeze({
  ingestionJobs: Object.freeze({ validator: ingestionJobValidator }),
  jobLeases: Object.freeze({ validator: { $jsonSchema: jobLeaseSchema } }),
  ingestionScheduleProgress: Object.freeze({ validator: { $jsonSchema: ingestionScheduleProgressSchema } }),
})

export const DURABLE_JOB_INDEXES = Object.freeze({
  ingestionJobs: Object.freeze([
    { name: 'ingestion_actor_idempotency_unique', key: { actorScope: 1, idempotencyKey: 1 }, options: { unique: true } },
    { name: 'ingestion_parent_attempt_unique', key: { parentJobId: 1, attempt: 1 }, options: { unique: true, partialFilterExpression: { parentJobId: { $type: 'objectId' } } } },
    { name: 'ingestion_source_created', key: { sourceId: 1, createdAt: -1 } },
    { name: 'ingestion_due_normal', key: { status: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 } },
    { name: 'ingestion_due_aged', key: { status: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 } },
    { name: 'ingestion_next_available', key: { status: 1, availableAt: 1, _id: 1 } },
    { name: 'ingestion_purge_deadline', key: { purgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { purgeAfter: { $type: 'date' } } } },
  ]),
  jobLeases: Object.freeze([
    { name: 'job_lease_key_unique', key: { key: 1 }, options: { unique: true } },
    { name: 'job_lease_expiry', key: { 'activeOwner.expiresAt': 1 } },
  ]),
  ingestionScheduleProgress: Object.freeze([
    { name: 'ingestion_schedule_period_unique', key: { period: 1 }, options: { unique: true } },
  ]),
})

export function buildDurableJobsMigration({ dryRun = false } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(DURABLE_JOB_COLLECTIONS)) {
    operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of DURABLE_JOB_INDEXES[name]) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  operations.push({ type: 'collMod', collection: 'adminAuditLogs', options: { validator: DURABLE_JOB_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } })
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function assertDurableJobsPredecessor(db) {
  const audit = (await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
  const current = stableJson(audit?.options?.validator)
  if (![SOURCE_AUDIT_VALIDATOR, DURABLE_JOB_AUDIT_VALIDATOR].some((validator) => stableJson(validator) === current)) {
    throw new Error('sources migration must be applied with an exact known audit revision before durable-jobs')
  }
}

export async function runDurableJobsMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function' || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  const plan = buildDurableJobsMigration({ dryRun })
  if (dryRun) return plan
  await assertDurableJobsPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try { await db.createCollection(operation.collection, operation.options) } catch (error) { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error }
    } else if (operation.type === 'collMod') {
      await db.command({ collMod: operation.collection, ...operation.options })
    } else {
      await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
    }
  }
  return plan
}
