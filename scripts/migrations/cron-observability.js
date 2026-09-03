const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })

const safeErrorSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['code', 'retryable', 'occurredAt'],
  properties: {
    code: { bsonType: 'string', minLength: 1, maxLength: 128 },
    retryable: { bsonType: 'bool' },
    occurredAt: date,
    upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 },
  },
})

const countersSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  properties: {
    fetched: { bsonType: 'int', minimum: 0 },
    created: { bsonType: 'int', minimum: 0 },
    updated: { bsonType: 'int', minimum: 0 },
    duplicate: { bsonType: 'int', minimum: 0 },
    skipped: { bsonType: 'int', minimum: 0 },
    failed: { bsonType: 'int', minimum: 0 },
    claimed: { bsonType: 'int', minimum: 0 },
    succeeded: { bsonType: 'int', minimum: 0 },
    partial: { bsonType: 'int', minimum: 0 },
    deferred: { bsonType: 'int', minimum: 0 },
    inspected: { bsonType: 'int', minimum: 0 },
    recovered: { bsonType: 'int', minimum: 0 },
    retriesCreated: { bsonType: 'int', minimum: 0 },
  },
})

export const CRON_LIFECYCLE_EVENT_SCHEMA = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['_id', 'eventId', 'version', 'occurredAt', 'eventType', 'stage', 'status', 'purgeAfter', 'createdAt'],
  properties: {
    _id: objectId,
    eventId: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    version: { bsonType: 'int', minimum: 1, maximum: 1 },
    occurredAt: date,
    eventType: { bsonType: 'string', minLength: 1, maxLength: 128 },
    runId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    queueName: { bsonType: 'string', minLength: 1, maxLength: 64 },
    task: { bsonType: 'string', minLength: 1, maxLength: 64 },
    jobId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    articleId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    sourceId: { bsonType: 'string', minLength: 1, maxLength: 128 },
    sourceKey: { bsonType: 'string', minLength: 1, maxLength: 128 },
    sequence: { bsonType: 'int', minimum: 0, maximum: 2147483647 },
    leaseGeneration: { bsonType: ['int', 'long'], minimum: 0 },
    remainingClaims: { bsonType: 'int', minimum: 0 },
    profileMaxJobs: { bsonType: 'int', minimum: 0 },
    stage: { bsonType: 'string', minLength: 1, maxLength: 128 },
    status: { bsonType: 'string', minLength: 1, maxLength: 64 },
    elapsedMs: { bsonType: 'int', minimum: 0 },
    counters: countersSchema,
    error: safeErrorSchema,
    purgeAfter: date,
    createdAt: date,
  },
})

export const CRON_OBSERVABILITY_COLLECTIONS = Object.freeze({
  cronLifecycleEvents: Object.freeze({ validator: { $jsonSchema: CRON_LIFECYCLE_EVENT_SCHEMA } }),
})

export const CRON_OBSERVABILITY_INDEXES = Object.freeze({
  cronLifecycleEvents: Object.freeze([
    { name: 'cron_events_eventId_unique', key: { eventId: 1 }, options: { unique: true } },
    { name: 'cron_events_occurred_id', key: { occurredAt: -1, _id: -1 } },
    { name: 'cron_events_run_occurred_id', key: { runId: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_queue_occurred_id', key: { queueName: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_task_occurred_id', key: { task: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_job_occurred_id', key: { jobId: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_article_occurred_id', key: { articleId: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_source_occurred_id', key: { sourceId: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_status_occurred_id', key: { status: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_run_stage_occurred', key: { runId: 1, stage: 1, occurredAt: -1, _id: -1 } },
    { name: 'cron_events_stage_occurred_id', key: { stage: 1, occurredAt: -1, _id: -1 } },
    {
      name: 'cron_events_purge_deadline',
      key: { purgeAfter: 1, _id: 1 },
      options: { partialFilterExpression: { purgeAfter: { $type: 'date' } } },
    },
  ]),
})

export function buildCronObservabilityMigration({ dryRun = false } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(CRON_OBSERVABILITY_COLLECTIONS)) {
    operations.push({
      type: 'createCollection',
      collection: name,
      options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' },
    })
    operations.push({
      type: 'collMod',
      collection: name,
      options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' },
    })
    for (const index of CRON_OBSERVABILITY_INDEXES[name]) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

export async function runCronObservabilityMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildCronObservabilityMigration({ dryRun })
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
