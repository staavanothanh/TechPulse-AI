import {
  INDEXING_ARTICLE_INDEXES,
  INDEXING_JOB_COLLECTIONS,
  INDEXING_JOB_INDEXES,
} from './indexing-jobs.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from './chat-sessions.js'
import { ARTICLE_INDEXES } from './articles.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from './article-governance-hardening.js'

const ID_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$'
const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })

const reservation = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['reservationId', 'routeId', 'attemptId', 'kind', 'expiresAt'],
  properties: {
    reservationId: { bsonType: 'string', minLength: 8, maxLength: 128 },
    routeId: { bsonType: 'string', pattern: ID_PATTERN },
    attemptId: objectId,
    kind: { enum: ['summary', 'embedding', 'answer-primary', 'answer-fallback', 'answer-support'] },
    expiresAt: date,
  },
})

const routeCircuit = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['routeId', 'state', 'consecutiveRetryableFailures'],
  properties: {
    routeId: { bsonType: 'string', pattern: ID_PATTERN },
    state: { enum: ['closed', 'open', 'half-open'] },
    consecutiveRetryableFailures: { bsonType: 'int', minimum: 0, maximum: 3 },
    cooldownUntil: date,
    halfOpenProbeReservationId: { bsonType: 'string', minLength: 8, maxLength: 128 },
  },
})

export const PROVIDER_ADMISSION_STATE_VALIDATOR_V2 = Object.freeze({
  $and: [
    {
      $jsonSchema: {
        bsonType: 'object',
        additionalProperties: false,
        required: [
          '_id',
          'admissionDomainId',
          'providerId',
          'activeReservations',
          'maxConcurrency',
          'budgetWindowStart',
          'spentUnits',
          'budgetLimit',
          'routeCircuits',
          'updatedAt',
        ],
        properties: {
          _id: objectId,
          admissionDomainId: { bsonType: 'string', pattern: ID_PATTERN },
          providerId: { bsonType: 'string', pattern: ID_PATTERN },
          activeReservations: { bsonType: 'array', maxItems: 8, items: reservation },
          maxConcurrency: { bsonType: 'int', minimum: 1, maximum: 8 },
          budgetWindowStart: date,
          spentUnits: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 },
          budgetLimit: { bsonType: ['int', 'long', 'double', 'decimal'], minimum: 0 },
          routeCircuits: { bsonType: 'array', maxItems: 32, items: routeCircuit },
          updatedAt: date,
        },
      },
    },
    { $expr: { $lte: [{ $size: '$activeReservations' }, '$maxConcurrency'] } },
    { $expr: { $lte: ['$spentUnits', '$budgetLimit'] } },
    {
      $expr: {
        $eq: [
          { $size: '$activeReservations' },
          { $size: { $setUnion: ['$activeReservations.reservationId', []] } },
        ],
      },
    },
    {
      $expr: {
        $eq: [
          { $size: '$routeCircuits' },
          { $size: { $setUnion: ['$routeCircuits.routeId', []] } },
        ],
      },
    },
  ],
})

export const PROVIDER_FAILURE_DOMAIN_STATE_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'providerFailureDomainId',
      'configVersion',
      'state',
      'consecutiveRetryableFailures',
      'updatedAt',
    ],
    properties: {
      _id: objectId,
      providerFailureDomainId: { bsonType: 'string', pattern: ID_PATTERN },
      configVersion: { bsonType: 'int', minimum: 1 },
      state: { enum: ['closed', 'open', 'half-open'] },
      consecutiveRetryableFailures: { bsonType: 'int', minimum: 0, maximum: 3 },
      cooldownUntil: date,
      halfOpenProbeReservationId: { bsonType: 'string', minLength: 8, maxLength: 128 },
      updatedAt: date,
    },
  },
})

const answerAttemptValidator = CHAT_SESSION_COLLECTIONS.answerAttempts.validator
const answerAttemptSchema = answerAttemptValidator.$and[0].$jsonSchema
export const PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR = Object.freeze({
  ...answerAttemptValidator,
  $and: Object.freeze([
    {
      $jsonSchema: {
        ...answerAttemptSchema,
        properties: {
          ...answerAttemptSchema.properties,
          providerFailureDomainId: { bsonType: 'string', pattern: ID_PATTERN },
          fallbackKind: { enum: ['none', 'model', 'provider'] },
        },
      },
    },
    ...answerAttemptValidator.$and.slice(1),
    {
      $expr: {
        $eq: [
          { $ne: [{ $type: '$providerFailureDomainId' }, 'missing'] },
          { $ne: [{ $type: '$fallbackKind' }, 'missing'] },
        ],
      },
    },
  ]),
})

const indexingJobValidator = INDEXING_JOB_COLLECTIONS.indexingJobs.validator
const indexingJobSchema = indexingJobValidator.$and[0].$jsonSchema
export const PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR = Object.freeze({
  ...indexingJobValidator,
  $and: Object.freeze([
    {
      $jsonSchema: {
        ...indexingJobSchema,
        properties: {
          ...indexingJobSchema.properties,
          targetEmbeddingArtifactCompatibilityId: { bsonType: 'string', pattern: ID_PATTERN },
        },
      },
    },
    ...indexingJobValidator.$and.slice(1),
    {
      $expr: {
        $cond: [
          { $eq: ['$task', 'embedding'] },
          {
            $and: [
              { $in: [{ $type: '$targetEmbeddingVersion' }, ['int', 'long']] },
              { $eq: [{ $type: '$targetEmbeddingArtifactCompatibilityId' }, 'string'] },
            ],
          },
          {
            $and: [
              { $eq: [{ $type: '$targetEmbeddingVersion' }, 'missing'] },
              { $eq: [{ $type: '$targetEmbeddingArtifactCompatibilityId' }, 'missing'] },
            ],
          },
        ],
      },
    },
  ]),
})

const governedArticleBranch = ARTICLE_GOVERNANCE_HARDENING_VALIDATOR.$or[0]
const articleSchema = governedArticleBranch.$and[0].$jsonSchema
export const PROVIDER_ROUTING_ARTICLE_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    {
      $and: Object.freeze([
        {
          $jsonSchema: {
            ...articleSchema,
            properties: {
              ...articleSchema.properties,
              embeddingArtifactCompatibilityId: { bsonType: 'string', pattern: ID_PATTERN },
              embeddingCutover: {
                bsonType: 'object',
                additionalProperties: false,
                required: ['epoch', 'status', 'requestedAt'],
                properties: {
                  epoch: { enum: ['provider-routing-v2'] },
                  status: { enum: ['pending', 'materialized'] },
                  requestedAt: { bsonType: 'date' },
                  materializedAt: { bsonType: 'date' },
                },
              },
            },
          },
        },
        ...governedArticleBranch.$and.slice(1),
        {
          $expr: {
            $cond: [
              { $eq: ['$embeddingStatus', 'ready'] },
              { $eq: [{ $type: '$embeddingArtifactCompatibilityId' }, 'string'] },
              { $eq: [{ $type: '$embeddingArtifactCompatibilityId' }, 'missing'] },
            ],
          },
        },
      ]),
    },
    ...ARTICLE_GOVERNANCE_HARDENING_VALIDATOR.$or.slice(1),
  ]),
})

const PROVIDER_ROUTING_ARTICLE_COMPATIBILITY_VALIDATOR = Object.freeze({
  $or: [ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, PROVIDER_ROUTING_ARTICLE_VALIDATOR],
})

const PROVIDER_ADMISSION_COMPATIBILITY_VALIDATOR = Object.freeze({
  $or: [
    INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator,
    PROVIDER_ADMISSION_STATE_VALIDATOR_V2,
  ],
})

export const PROVIDER_ROUTING_V2_COLLECTIONS = Object.freeze({
  providerAdmissionStates: Object.freeze({ validator: PROVIDER_ADMISSION_STATE_VALIDATOR_V2 }),
  providerFailureDomainStates: Object.freeze({ validator: PROVIDER_FAILURE_DOMAIN_STATE_VALIDATOR }),
  answerAttempts: Object.freeze({ validator: PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR }),
  indexingJobs: Object.freeze({ validator: PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR }),
  articles: Object.freeze({ validator: PROVIDER_ROUTING_ARTICLE_VALIDATOR }),
})

function uniqueIndexes(...groups) {
  return Object.freeze([...new Map(groups.flat().map((index) => [index.name, index])).values()])
}

export const PROVIDER_ROUTING_V2_INDEXES = Object.freeze({
  providerAdmissionStates: INDEXING_JOB_INDEXES.providerAdmissionStates,
  providerFailureDomainStates: Object.freeze([
    {
      name: 'provider_failure_domain_unique',
      key: { providerFailureDomainId: 1 },
      options: { unique: true },
    },
    {
      name: 'provider_failure_domain_cooldown',
      key: { state: 1, cooldownUntil: 1, _id: 1 },
    },
  ]),
  answerAttempts: CHAT_SESSION_INDEXES.answerAttempts,
  indexingJobs: INDEXING_JOB_INDEXES.indexingJobs,
  articles: uniqueIndexes(ARTICLE_INDEXES.articles, INDEXING_ARTICLE_INDEXES, [
    {
      name: 'articles_embedding_compatibility',
      key: {
        embeddingStatus: 1,
        embeddingArtifactCompatibilityId: 1,
        embeddingVersion: 1,
      },
    },
  ]),
})

const LEGACY_READY_EMBEDDING_FILTER = Object.freeze({
  embeddingStatus: 'ready',
  embeddingArtifactCompatibilityId: { $exists: false },
})
const EMBEDDING_CUTOVER_EPOCH = 'provider-routing-v2'
const PENDING_EMBEDDING_CUTOVER_FILTER = Object.freeze({
  'embeddingCutover.epoch': EMBEDDING_CUTOVER_EPOCH,
  'embeddingCutover.status': 'pending',
})

export async function invalidateLegacyReadyEmbeddings({ db, batchSize = 100 } = {}) {
  if (!db?.collection || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Bounded legacy embedding invalidation requires MongoDB and batchSize 1..100')
  }
  const articles = db.collection('articles')
  const sources = db.collection('sources')
  let invalidatedCount = 0
  const reconciledSources = new Set()
  while (true) {
    const candidates = await articles.find(LEGACY_READY_EMBEDDING_FILTER)
      .sort({ _id: 1 })
      .limit(batchSize)
      .project({ _id: 1, sourceId: 1 })
      .toArray()
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      const invalidated = await articles.findOneAndUpdate(
        { _id: candidate._id, ...LEGACY_READY_EMBEDDING_FILTER },
        [
          { $set: {
            embeddingStatus: 'pending',
            embedding: null,
            embeddingModel: null,
            embeddingDimensions: null,
            embeddingInputHash: null,
            embeddingVersion: null,
            embeddingSourcePolicyVersion: null,
            embeddedAt: null,
            embeddingError: null,
            embeddingCutover: {
              epoch: EMBEDDING_CUTOVER_EPOCH,
              status: 'pending',
              requestedAt: '$$NOW',
            },
            updatedAt: '$$NOW',
          } },
          { $unset: 'embeddingArtifactCompatibilityId' },
        ],
        { projection: { _id: 0, sourceId: 1 }, returnDocument: 'before' },
      )
      if (!invalidated?.sourceId) continue
      invalidatedCount += 1
    }
  }

  let cursorArticleId = null
  while (true) {
    const filter = cursorArticleId
      ? { ...PENDING_EMBEDDING_CUTOVER_FILTER, _id: { $gt: cursorArticleId } }
      : PENDING_EMBEDDING_CUTOVER_FILTER
    const intents = await articles.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .project({ _id: 1, sourceId: 1 })
      .toArray()
    if (intents.length === 0) break
    cursorArticleId = intents.at(-1)._id
    const bySource = new Map()
    for (const intent of intents) {
      if (!intent.sourceId) continue
      const sourceKey = intent.sourceId.toHexString?.() ?? String(intent.sourceId)
      const group = bySource.get(sourceKey) ?? { sourceId: intent.sourceId, articleIds: [] }
      bySource.set(sourceKey, { ...group, articleIds: [...group.articleIds, intent._id] })
    }
    for (const [sourceKey, { sourceId, articleIds }] of bySource) {
      const result = await sources.updateOne(
        { _id: sourceId },
        [{
          $set: {
            reconciliation: {
              status: 'pending',
              requiredPolicyVersion: '$policyVersion',
              completedPolicyVersion: null,
              requestedAt: '$$NOW',
              error: null,
            },
            updatedAt: '$$NOW',
          },
        }],
      )
      if (result.matchedCount !== 1) continue
      await articles.updateMany(
        {
          _id: { $in: articleIds },
          ...PENDING_EMBEDDING_CUTOVER_FILTER,
        },
        [{ $set: {
          'embeddingCutover.status': 'materialized',
          'embeddingCutover.materializedAt': '$$NOW',
        } }],
      )
      reconciledSources.add(sourceKey)
    }
  }
  return { invalidatedCount, sourceCount: reconciledSources.size }
}

const UNSAFE_OLDER_TARGETS = new Set(['sources', 'articles', 'indexing-jobs', 'chat-sessions'])

export async function assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db, target } = {}) {
  if (!db?.listCollections || !UNSAFE_OLDER_TARGETS.has(target)) return
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const v2Installed = collections.some(({ name, options }) =>
    name === 'providerFailureDomainStates' ||
    stableJson(options?.validator) === stableJson(PROVIDER_ROUTING_ARTICLE_VALIDATOR) ||
    stableJson(options?.validator) === stableJson(PROVIDER_ROUTING_ARTICLE_COMPATIBILITY_VALIDATOR) ||
    stableJson(options?.validator) === stableJson(PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR) ||
    stableJson(options?.validator) === stableJson(PROVIDER_ADMISSION_STATE_VALIDATOR_V2))
  if (v2Installed) throw new Error(`Migration target ${target} would downgrade provider-routing-v2`)
}

export function upgradeProviderAdmissionDocument(document) {
  if (!document || typeof document !== 'object') throw new Error('Provider admission document is required')
  const { provider, ...rest } = document
  return { ...rest, providerId: rest.providerId ?? provider }
}

export function buildProviderRoutingV2Migration({ dryRun = false } = {}) {
  const operations = [
    {
      type: 'collMod',
      collection: 'providerAdmissionStates',
      options: {
        validator: PROVIDER_ADMISSION_COMPATIBILITY_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'updateMany',
      collection: 'providerAdmissionStates',
      filter: { providerId: { $exists: false }, provider: { $type: 'string' } },
      update: [
        { $set: { providerId: '$provider' } },
        { $unset: 'provider' },
      ],
    },
    {
      type: 'collMod',
      collection: 'providerAdmissionStates',
      options: {
        validator: PROVIDER_ADMISSION_STATE_VALIDATOR_V2,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'createCollection',
      collection: 'providerFailureDomainStates',
      options: {
        validator: PROVIDER_FAILURE_DOMAIN_STATE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'collMod',
      collection: 'providerFailureDomainStates',
      options: {
        validator: PROVIDER_FAILURE_DOMAIN_STATE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'collMod',
      collection: 'answerAttempts',
      options: {
        validator: PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'updateMany',
      collection: 'indexingJobs',
      filter: {
        $or: [
          { task: 'embedding', targetEmbeddingArtifactCompatibilityId: { $exists: false } },
          { task: { $ne: 'embedding' }, targetEmbeddingVersion: { $exists: true } },
          { task: { $ne: 'embedding' }, targetEmbeddingArtifactCompatibilityId: { $exists: true } },
        ],
      },
      update: [{
        $set: {
          targetEmbeddingVersion: {
            $cond: [{ $eq: ['$task', 'embedding'] }, { $ifNull: ['$targetEmbeddingVersion', 1] }, '$$REMOVE'],
          },
          targetEmbeddingArtifactCompatibilityId: {
            $cond: [{ $eq: ['$task', 'embedding'] }, { $ifNull: ['$targetEmbeddingArtifactCompatibilityId', 'legacy-invalidated'] }, '$$REMOVE'],
          },
        },
      }],
    },
    {
      type: 'collMod',
      collection: 'indexingJobs',
      options: {
        validator: PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'collMod',
      collection: 'articles',
      options: {
        validator: PROVIDER_ROUTING_ARTICLE_COMPATIBILITY_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'invalidateLegacyEmbeddings',
      collection: 'articles',
      batchSize: 100,
    },
    {
      type: 'collMod',
      collection: 'articles',
      options: {
        validator: PROVIDER_ROUTING_ARTICLE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    ...Object.entries(PROVIDER_ROUTING_V2_INDEXES).flatMap(([collection, indexes]) =>
      indexes.map((index) => ({ type: 'createIndex', collection, ...index }))),
  ]
  return dryRun
    ? operations.map((operation) => ({ ...operation, dryRun: true }))
    : operations
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function isProviderRoutingArticleSuccessor(validator) {
  const branch = validator?.$or?.[0]
  const schemaRule = branch?.$and?.[0]
  const schema = schemaRule?.$jsonSchema
  const token = schema?.properties?.qnaFenceToken
  if (stableJson(token) !== stableJson({ bsonType: 'objectId' })) return false
  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([key]) => key !== 'qnaFenceToken'),
  )
  const predecessor = {
    ...validator,
    $or: [
      {
        ...branch,
        $and: [
          { ...schemaRule, $jsonSchema: { ...schema, properties } },
          ...branch.$and.slice(1),
        ],
      },
      ...validator.$or.slice(1),
    ],
  }
  return stableJson(predecessor) === stableJson(PROVIDER_ROUTING_ARTICLE_VALIDATOR)
}

async function assertPredecessor(db) {
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  const acceptedAdmission = [
    INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator,
    PROVIDER_ADMISSION_STATE_VALIDATOR_V2,
  ]
  if (!acceptedAdmission.some((validator) => stableJson(byName.get('providerAdmissionStates')?.options?.validator) === stableJson(validator))) {
    throw new Error('indexing-jobs migration must be applied before provider-routing-v2')
  }
  const acceptedAttempts = [answerAttemptValidator, PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR]
  if (!acceptedAttempts.some((validator) => stableJson(byName.get('answerAttempts')?.options?.validator) === stableJson(validator))) {
    throw new Error('chat-sessions migration must be applied before provider-routing-v2')
  }
  const acceptedIndexingJobs = [indexingJobValidator, PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR]
  if (!acceptedIndexingJobs.some((validator) => stableJson(byName.get('indexingJobs')?.options?.validator) === stableJson(validator))) {
    throw new Error('indexing-jobs migration must be applied before provider-routing-v2')
  }
  const acceptedArticles = [
    ARTICLE_GOVERNANCE_HARDENING_VALIDATOR,
    PROVIDER_ROUTING_ARTICLE_COMPATIBILITY_VALIDATOR,
    PROVIDER_ROUTING_ARTICLE_VALIDATOR,
  ]
  const installedArticles = byName.get('articles')?.options?.validator
  if (!acceptedArticles.some((validator) => stableJson(installedArticles) === stableJson(validator))
    && !isProviderRoutingArticleSuccessor(installedArticles)) {
    throw new Error('governance article hardening must be applied before provider-routing-v2')
  }
  return {
    articleSuccessorValidator: isProviderRoutingArticleSuccessor(installedArticles)
      ? installedArticles
      : null,
  }
}

export async function runProviderRoutingV2Migration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const basePlan = buildProviderRoutingV2Migration({ dryRun })
  if (dryRun) return basePlan
  const { articleSuccessorValidator } = await assertPredecessor(db)
  const successorCompatibilityValidator = articleSuccessorValidator
    ? { $or: [ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, articleSuccessorValidator] }
    : null
  const plan = basePlan.map((operation) => {
    if (!articleSuccessorValidator || operation.type !== 'collMod' || operation.collection !== 'articles') return operation
    const validator = stableJson(operation.options.validator) === stableJson(PROVIDER_ROUTING_ARTICLE_COMPATIBILITY_VALIDATOR)
      ? successorCompatibilityValidator
      : articleSuccessorValidator
    return { ...operation, options: { ...operation.options, validator } }
  })
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try {
        await db.createCollection(operation.collection, operation.options)
      } catch (error) {
        if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error
      }
    } else if (operation.type === 'collMod') {
      await db.command({ collMod: operation.collection, ...operation.options })
    } else if (operation.type === 'updateMany') {
      await db.collection(operation.collection).updateMany(operation.filter, operation.update)
    } else if (operation.type === 'invalidateLegacyEmbeddings') {
      await invalidateLegacyReadyEmbeddings({ db, batchSize: operation.batchSize })
    } else {
      await db.collection(operation.collection).createIndex(operation.key, {
        ...(operation.options ?? {}),
        name: operation.name,
      })
    }
  }
  return plan
}

export { PROVIDER_ADMISSION_COMPATIBILITY_VALIDATOR }
